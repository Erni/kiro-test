import { Decimal } from 'decimal.js';
import fc from 'fast-check';

import { listHoldings, updateHolding } from '../../src/domain/holdings';
import { MAX_DECIMAL_PLACES, MAX_VALUE } from '../../src/domain/types';
import type { Holding, PortfolioState, Transaction, TransactionType } from '../../src/domain/types';
import { validateHoldingUpdateInput } from '../../src/domain/validation';

/**
 * Property 4: Valid holding update applies exactly the submitted values
 * (Requirement 1.5).
 *
 * For any existing Holding and any valid quantity/Current_Price within the
 * allowed ranges, updating the Holding with those values results in a Holding
 * whose quantity and Current_Price exactly equal the submitted values.
 *
 * The update goes through the real boundary path — `validateHoldingUpdateInput`
 * followed by `updateHolding` — because Req 1.5 is about what the System does
 * with a *submitted* update, not about what the state transition does with an
 * already-parsed one. Feeding pre-built `Decimal`s straight into
 * `updateHolding` would skip exactly the step where precision can be lost.
 *
 * Values are generated as decimal *strings* and never routed through a
 * JavaScript number, so the generators themselves cannot lose the precision the
 * property is checking for. "Exactly equal" is asserted on `toFixed()` output
 * rather than by structural comparison: two `Decimal` instances holding the same
 * value can differ in internal digit representation, and it is the value that
 * Req 1.5 constrains.
 *
 * The Portfolio is seeded with unrelated Holdings and with Transactions across
 * several symbols, so the property also pins down what an update must *not*
 * touch: the target's symbol, the other Holdings, and the Transaction history
 * (an update revises the current position, it does not rewrite history).
 */

/** Inclusive upper bound for generated quantities and prices, as a bigint. */
const MAX_WHOLE = BigInt(MAX_VALUE);

/** Largest 8-decimal-place fraction, i.e. `.99999999`. */
const MAX_FRACTION = 10 ** MAX_DECIMAL_PLACES - 1;

/** Symbol alphabet from Req 1.11: uppercase letters and digits only. */
const SYMBOL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

/** How many Holdings the Portfolio may contain, the update target included. */
const MAX_HOLDINGS = 5;

/** How many pre-existing Transactions the Portfolio may carry. */
const MAX_TRANSACTIONS = 5;

/**
 * Decimal strings in `[0, MAX_VALUE]` with up to 8 decimal places, biased
 * towards both ends of the range: small everyday values and the
 * 20-significant-digit extremes that a float-backed path would silently mangle.
 *
 * `positive` additionally guarantees `> 0`, as a Holding quantity requires
 * (Req 1.5).
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

/** A quantity/Current_Price pair inside the Req 1.1 ranges, as strings. */
const valuesArbitrary = fc.record({
  quantity: decimalStrings('positive'),
  currentPrice: decimalStrings('nonNegative'),
});

/**
 * A populated Portfolio, the symbol of the Holding to update, and the submitted
 * update values.
 *
 * The target is drawn from the symbols actually held, so the update is always
 * expected to succeed (Req 1.5 rather than Req 1.9). Transactions are attached
 * to symbols from the same pool, so a transition that filtered or rebuilt
 * history by symbol could not slip through.
 */
const scenarioArbitrary = fc
  .record({
    symbols: fc.uniqueArray(symbolArbitrary, { minLength: 1, maxLength: MAX_HOLDINGS }),
    values: fc.array(valuesArbitrary, { minLength: MAX_HOLDINGS, maxLength: MAX_HOLDINGS }),
    targetAt: fc.nat({ max: MAX_HOLDINGS - 1 }),
    submission: valuesArbitrary,
    transactions: fc.array(
      fc.record({
        at: fc.nat({ max: MAX_HOLDINGS - 1 }),
        type: fc.constantFrom<TransactionType>('Buy', 'Sell'),
        quantity: decimalStrings('positive'),
        pricePerUnit: decimalStrings('nonNegative'),
        timestamp: fc.date({
          min: new Date('2000-01-01T00:00:00.000Z'),
          max: new Date('2100-01-01T00:00:00.000Z'),
          noInvalidDate: true,
        }),
      }),
      { minLength: 0, maxLength: MAX_TRANSACTIONS },
    ),
  })
  .map(({ symbols, values, targetAt, submission, transactions }) => {
    const held = symbols as [string, ...string[]];

    const holdings = new Map<string, Holding>();
    held.forEach((symbol, index) => {
      const value = values[index] as { quantity: string; currentPrice: string };
      holdings.set(symbol, {
        symbol,
        quantity: new Decimal(value.quantity),
        currentPrice: new Decimal(value.currentPrice),
      });
    });

    const recorded: Transaction[] = transactions.map((transaction, index) => ({
      id: `t-${index}`,
      symbol: held[transaction.at % held.length] as string,
      type: transaction.type,
      quantity: new Decimal(transaction.quantity),
      pricePerUnit: new Decimal(transaction.pricePerUnit),
      timestamp: transaction.timestamp,
    }));

    return {
      state: { holdings, transactions: recorded } as PortfolioState,
      target: held[targetAt % held.length] as string,
      submission,
    };
  });

describe('updateHolding with valid input', () => {
  // Feature: crypto-portfolio-core, Property 4: Valid holding update applies exactly the submitted values
  it('applies exactly the submitted quantity and Current_Price to the targeted Holding', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ state, target, submission }) => {
        const before = state.holdings.get(target) as Holding;

        const validated = validateHoldingUpdateInput(submission);
        // Every generated submission is inside the Req 1.5 ranges, so rejecting
        // one here would itself be a defect.
        expect(validated.ok).toBe(true);
        if (!validated.ok) {
          return;
        }

        const updated = updateHolding(state, target, validated.value);
        expect(updated.ok).toBe(true);
        if (!updated.ok) {
          return;
        }

        const stored = updated.value.holdings.get(target);
        expect(stored).toBeDefined();
        expect(stored?.quantity.toFixed()).toBe(new Decimal(submission.quantity).toFixed());
        expect(stored?.currentPrice.toFixed()).toBe(new Decimal(submission.currentPrice).toFixed());

        // The symbol identifies the Holding; an update must not re-key it.
        expect(stored?.symbol).toBe(before.symbol);
        expect(listHoldings(updated.value).map((holding) => holding.symbol).sort()).toEqual(
          listHoldings(state).map((holding) => holding.symbol).sort(),
        );

        // Every other Holding keeps its own values, so "applies the submitted
        // values" cannot be satisfied by writing them everywhere.
        expect(updated.value.holdings.size).toBe(state.holdings.size);
        for (const existing of state.holdings.values()) {
          if (existing.symbol === target) {
            continue;
          }
          const carried = updated.value.holdings.get(existing.symbol);
          expect(carried?.quantity.toFixed()).toBe(existing.quantity.toFixed());
          expect(carried?.currentPrice.toFixed()).toBe(existing.currentPrice.toFixed());
        }

        // An update revises the current position, it does not rewrite history.
        expect(historySnapshot(updated.value)).toEqual(historySnapshot(state));
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * A comparable view of the Transaction list.
 *
 * `Decimal` and `Date` are reduced to their exact textual forms because two
 * `Decimal` instances holding the same value are not structurally equal, and
 * `toFixed()` compares the value itself rather than how it happens to be
 * stored. Order is preserved and compared, since history ordering is observable
 * behavior (Req 2.8).
 */
function historySnapshot(state: PortfolioState): unknown {
  return state.transactions.map((transaction: Transaction) => ({
    id: transaction.id,
    symbol: transaction.symbol,
    type: transaction.type,
    quantity: transaction.quantity.toFixed(),
    pricePerUnit: transaction.pricePerUnit.toFixed(),
    timestamp: transaction.timestamp.toISOString(),
  }));
}
