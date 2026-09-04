import { Decimal } from 'decimal.js';
import fc from 'fast-check';

import { DuplicateHoldingError } from '../../src/domain/errors';
import { addHolding } from '../../src/domain/holdings';
import { MAX_DECIMAL_PLACES, MAX_VALUE } from '../../src/domain/types';
import { validateNewHoldingInput } from '../../src/domain/validation';

import type { Holding, PortfolioState, Transaction, ValidHoldingInput } from '../../src/domain/types';

/**
 * Property 2: Duplicate symbol creation is always rejected without side effects
 * (Requirement 1.2).
 *
 * A Portfolio is built up through the real `addHolding` transition, then a
 * second Holding is submitted for a symbol that is already held. Whatever the
 * submitted quantity and Current_Price are - including values identical to the
 * ones already stored - the submission must be rejected with a
 * `DuplicateHoldingError`, and the Portfolio it was submitted against must be
 * byte-for-byte the state it was before the attempt.
 *
 * Two things are checked on the "no side effects" side, because they can fail
 * independently:
 *
 * - The whole Portfolio is compared against a snapshot taken *before* the
 *   attempt (every Holding's quantity and Current_Price, plus the Transaction
 *   list), so a rejection that nonetheless overwrote or dropped something is
 *   caught wherever it happened.
 * - The targeted Holding is additionally compared by reference. `addHolding`
 *   returns a new state on success rather than mutating, and the rejection path
 *   must not even reach the copy: an implementation that mutated the map first
 *   and validated afterwards could restore equal values while still having
 *   replaced the object.
 *
 * Numeric values are generated as decimal *strings* and parsed with `Decimal`,
 * never through JavaScript numbers, so the generators cannot themselves lose the
 * precision the domain promises to preserve. Every generated input is run through
 * the real `validateNewHoldingInput` first, which both guards the generators
 * (a submission rejected as invalid would make the run vacuous) and matches how
 * the service layer reaches `addHolding`.
 */

/** Inclusive upper bound for generated quantities and prices, as a bigint. */
const MAX_WHOLE = BigInt(MAX_VALUE);

/** Largest 8-decimal-place fraction, i.e. `.99999999`. */
const MAX_FRACTION = 10 ** MAX_DECIMAL_PLACES - 1;

/** Symbol alphabet from Req 1.11: uppercase letters and digits only. */
const SYMBOL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

/** Size of the symbol pool the Portfolio is seeded from. */
const MAX_SYMBOLS = 4;

/** How many Transactions the seeded Portfolio may already carry. */
const MAX_TRANSACTIONS = 3;

/**
 * Decimal strings in `[0, MAX_VALUE]` with up to 8 decimal places, biased
 * towards both ends of the range: small everyday values and the
 * 20-significant-digit extremes.
 *
 * `positive` additionally guarantees `> 0`, as a Holding quantity requires.
 */
function decimalStrings(bound: 'positive' | 'nonNegative'): fc.Arbitrary<string> {
  const whole = fc.oneof(
    fc.bigInt({ min: 0n, max: 1000n }),
    fc.bigInt({ min: 0n, max: MAX_WHOLE }),
    fc.constantFrom(0n, 1n, MAX_WHOLE),
  );
  const fraction = fc.oneof(
    fc.integer({ min: 0, max: MAX_FRACTION }),
    fc.constantFrom(0, 1, MAX_FRACTION),
  );

  return fc.tuple(whole, fraction).map(([units, hundredMillionths]) => {
    // At the upper bound any fraction would push the value over MAX_VALUE.
    const digits = units === MAX_WHOLE ? 0 : hundredMillionths;
    if (units === 0n && digits === 0) {
      return bound === 'positive' ? '0.00000001' : '0';
    }
    if (digits === 0) {
      return units.toString();
    }
    return `${units}.${String(digits).padStart(MAX_DECIMAL_PLACES, '0')}`;
  });
}

/** Symbols matching `[A-Z0-9]{1,10}` (Req 1.11). */
const symbolArbitrary: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...SYMBOL_CHARS), { minLength: 1, maxLength: 10 })
  .map((characters) => characters.join(''));

/** A quantity / Current_Price pair for one Holding submission. */
const valuesArbitrary = fc.record({
  quantity: decimalStrings('positive'),
  currentPrice: decimalStrings('nonNegative'),
});

/**
 * A Portfolio to seed, the already-held symbol to collide with, and the values
 * the duplicate submission carries.
 */
const scenarioArbitrary = fc
  .record({
    symbols: fc.uniqueArray(symbolArbitrary, { minLength: 1, maxLength: MAX_SYMBOLS }),
    seeded: fc.array(valuesArbitrary, { minLength: MAX_SYMBOLS, maxLength: MAX_SYMBOLS }),
    /** Index into the seeded symbols; taken modulo the pool size. */
    target: fc.nat({ max: MAX_SYMBOLS - 1 }),
    duplicate: valuesArbitrary,
    /**
     * When true the duplicate carries exactly the stored values. The rejection
     * is about the symbol alone, so re-submitting an identical Holding must be
     * rejected too - and that is the case where a state comparison would not
     * notice an overwrite.
     */
    resubmitStoredValues: fc.boolean(),
    transactionCount: fc.nat({ max: MAX_TRANSACTIONS }),
  })
  .map((scenario) => ({
    ...scenario,
    targetSymbol: scenario.symbols[scenario.target % scenario.symbols.length] as string,
  }));

describe('addHolding duplicate rejection', () => {
  // Feature: crypto-portfolio-core, Property 2: Duplicate symbol creation is always rejected without side effects
  it('rejects a symbol that is already held and leaves the portfolio untouched', () => {
    fc.assert(
      fc.property(
        scenarioArbitrary,
        ({ symbols, seeded, duplicate, resubmitStoredValues, targetSymbol, transactionCount }) => {
          const state = seedPortfolio(symbols, seeded, transactionCount);

          const existing = state.holdings.get(targetSymbol);
          expect(existing).toBeDefined();
          const heldBefore = existing as Holding;

          const before = snapshot(state);

          const submission = valid({
            symbol: targetSymbol,
            quantity: resubmitStoredValues ? heldBefore.quantity.toFixed() : duplicate.quantity,
            currentPrice: resubmitStoredValues
              ? heldBefore.currentPrice.toFixed()
              : duplicate.currentPrice,
          });

          const result = addHolding(state, submission);

          // Rejected with the "already held" error, naming the symbol so the
          // HTTP layer can report which Cryptoasset collided.
          expect(result.ok).toBe(false);
          if (result.ok) {
            throw new Error(`expected ${targetSymbol} to be rejected as already held`);
          }
          expect(result.error).toBeInstanceOf(DuplicateHoldingError);
          expect(result.error.kind).toBe('DuplicateHoldingError');
          expect(result.error.symbol).toBe(targetSymbol);
          // No candidate state is handed back alongside the error.
          expect('value' in result).toBe(false);

          // The Portfolio as a whole is exactly as it was.
          expect(snapshot(state)).toEqual(before);

          // ...and the targeted Holding was not replaced by an equal-valued copy.
          expect(state.holdings.get(targetSymbol)).toBe(heldBefore);
          expect(heldBefore.quantity.toFixed()).toBe(before.holdings[targetSymbol]?.quantity);
          expect(heldBefore.currentPrice.toFixed()).toBe(before.holdings[targetSymbol]?.currentPrice);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/** Runs a submission through the real validator, failing the run if it is not valid. */
function valid(input: {
  readonly symbol: string;
  readonly quantity: string;
  readonly currentPrice: string;
}): ValidHoldingInput {
  const validated = validateNewHoldingInput(input);
  if (!validated.ok) {
    throw new Error(
      `generator produced an invalid holding input: ${validated.error.message} (${JSON.stringify(input)})`,
    );
  }
  return validated.value;
}

/**
 * Builds the starting Portfolio through the real `addHolding` transition, plus a
 * few Transactions so the "nothing changed" check has more than Holdings to
 * cover. Transaction ids and timestamps are fixed rather than generated: this
 * property is not about history, only about that history surviving a rejection.
 */
function seedPortfolio(
  symbols: readonly string[],
  values: readonly { readonly quantity: string; readonly currentPrice: string }[],
  transactionCount: number,
): PortfolioState {
  let state: PortfolioState = { holdings: new Map(), transactions: [] };

  for (const [index, symbol] of symbols.entries()) {
    const submission = valid({ symbol, ...(values[index] as { quantity: string; currentPrice: string }) });
    const result = addHolding(state, submission);
    if (!result.ok) {
      // The pool is unique, so no seeding submission can collide.
      throw new Error(`seeding ${symbol} unexpectedly failed: ${result.error.message}`);
    }
    state = result.value;
  }

  const transactions: Transaction[] = Array.from({ length: transactionCount }, (_unused, index) => ({
    id: `seed-${index}`,
    symbol: symbols[index % symbols.length] as string,
    type: index % 2 === 0 ? 'Buy' : 'Sell',
    quantity: new Decimal('1'),
    pricePerUnit: new Decimal('2'),
    timestamp: new Date(Date.UTC(2024, 0, 1 + index)),
  }));

  return { holdings: state.holdings, transactions };
}

/**
 * A comparable view of a Portfolio.
 *
 * `Decimal` values are reduced to their exact textual form: two `Decimal`
 * instances holding the same value are not structurally equal (they differ in
 * internal digit representation), while `toFixed()` compares the value itself.
 * Holdings are keyed by symbol because map iteration order is an implementation
 * detail; the Transaction list keeps its order, which is observable behavior.
 */
function snapshot(state: PortfolioState): {
  holdings: Record<string, { quantity: string; currentPrice: string }>;
  transactions: { id: string; symbol: string; type: string; quantity: string }[];
} {
  return {
    holdings: Object.fromEntries(
      [...state.holdings.values()].map((holding) => [
        holding.symbol,
        { quantity: holding.quantity.toFixed(), currentPrice: holding.currentPrice.toFixed() },
      ]),
    ),
    transactions: state.transactions.map((transaction) => ({
      id: transaction.id,
      symbol: transaction.symbol,
      type: transaction.type,
      quantity: transaction.quantity.toFixed(),
    })),
  };
}
