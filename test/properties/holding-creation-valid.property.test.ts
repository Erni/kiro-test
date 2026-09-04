import { Decimal } from 'decimal.js';
import fc from 'fast-check';

import { addHolding, listHoldings } from '../../src/domain/holdings';
import { MAX_DECIMAL_PLACES, MAX_VALUE } from '../../src/domain/types';
import type { Holding, PortfolioState } from '../../src/domain/types';
import { validateNewHoldingInput } from '../../src/domain/validation';

/**
 * Property 1: Creating a valid holding stores exactly the submitted values
 * (Requirement 1.1).
 *
 * For any valid Cryptoasset symbol, quantity, and Current_Price within the
 * allowed ranges, creating a Holding with those values results in a Holding in
 * the Portfolio whose symbol, quantity, and Current_Price exactly equal the
 * submitted values.
 *
 * The submission goes through the real boundary path — `validateNewHoldingInput`
 * followed by `addHolding` — because Req 1.1 is about what the System does with
 * a *submitted* Holding, not about what the state transition does with an
 * already-parsed one. Feeding pre-built `Decimal`s straight into `addHolding`
 * would skip exactly the step where precision can be lost.
 *
 * Values are generated as decimal *strings* and never routed through a
 * JavaScript number, so the generators themselves cannot lose the precision the
 * property is checking for. "Exactly equal" is asserted on `toFixed()` output
 * rather than by structural comparison: two `Decimal` instances holding the same
 * value can differ in internal digit representation, and it is the value that
 * Req 1.1 constrains.
 *
 * The Portfolio is seeded with unrelated Holdings so the creation happens
 * against a populated state rather than only an empty one — a stored value that
 * came from the wrong Holding would otherwise go unnoticed.
 */

/** Inclusive upper bound for generated quantities and prices, as a bigint. */
const MAX_WHOLE = BigInt(MAX_VALUE);

/** Largest 8-decimal-place fraction, i.e. `.99999999`. */
const MAX_FRACTION = 10 ** MAX_DECIMAL_PLACES - 1;

/** Symbol alphabet from Req 1.11: uppercase letters and digits only. */
const SYMBOL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

/** How many pre-existing Holdings the Portfolio may already contain. */
const MAX_EXISTING_HOLDINGS = 4;

/**
 * Decimal strings in `[0, MAX_VALUE]` with up to 8 decimal places, biased
 * towards both ends of the range: small everyday values and the
 * 20-significant-digit extremes that a float-backed path would silently mangle.
 *
 * `positive` additionally guarantees `> 0`, as a Holding quantity requires
 * (Req 1.1).
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

/** A submitted Holding: symbol plus its quantity and Current_Price as strings. */
const submissionArbitrary = fc.record({
  symbol: symbolArbitrary,
  quantity: decimalStrings('positive'),
  currentPrice: decimalStrings('nonNegative'),
});

/**
 * A Portfolio to create into, plus the Holding to create. The symbols are drawn
 * as one unique set and then split, so the new symbol is never already held and
 * the creation is therefore always expected to succeed (Req 1.1 rather than
 * Req 1.2).
 */
const scenarioArbitrary = fc
  .record({
    symbols: fc.uniqueArray(symbolArbitrary, {
      minLength: 1,
      maxLength: MAX_EXISTING_HOLDINGS + 1,
    }),
    values: fc.array(
      fc.record({
        quantity: decimalStrings('positive'),
        currentPrice: decimalStrings('nonNegative'),
      }),
      { minLength: MAX_EXISTING_HOLDINGS, maxLength: MAX_EXISTING_HOLDINGS },
    ),
    submission: submissionArbitrary,
  })
  .map(({ symbols, values, submission }) => {
    const [newSymbol, ...existingSymbols] = symbols as [string, ...string[]];

    const holdings = new Map<string, Holding>();
    existingSymbols.forEach((symbol, index) => {
      const value = values[index] as { quantity: string; currentPrice: string };
      holdings.set(symbol, {
        symbol,
        quantity: new Decimal(value.quantity),
        currentPrice: new Decimal(value.currentPrice),
      });
    });

    return {
      state: { holdings, transactions: [] } as PortfolioState,
      submission: { ...submission, symbol: newSymbol },
    };
  });

describe('addHolding with valid input', () => {
  // Feature: crypto-portfolio-core, Property 1: Creating a valid holding stores exactly the submitted values
  it('stores a Holding whose symbol, quantity, and Current_Price equal the submitted values', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ state, submission }) => {
        const validated = validateNewHoldingInput(submission);
        // Every generated submission is inside the Req 1.1 ranges, so rejecting
        // one here would itself be a defect.
        expect(validated.ok).toBe(true);
        if (!validated.ok) {
          return;
        }

        const created = addHolding(state, validated.value);
        expect(created.ok).toBe(true);
        if (!created.ok) {
          return;
        }

        const stored = created.value.holdings.get(submission.symbol);
        expect(stored).toBeDefined();
        expect(stored?.symbol).toBe(submission.symbol);
        expect(stored?.quantity.toFixed()).toBe(new Decimal(submission.quantity).toFixed());
        expect(stored?.currentPrice.toFixed()).toBe(new Decimal(submission.currentPrice).toFixed());

        // The Holding is in the Portfolio, i.e. observable through the listing
        // the user actually reads (Req 1.8), not merely inside the map.
        expect(listHoldings(created.value).map((holding) => holding.symbol)).toContain(
          submission.symbol,
        );

        // The other Holdings are carried over untouched, so "stores the
        // submitted values" cannot be satisfied by discarding the rest.
        expect(created.value.holdings.size).toBe(state.holdings.size + 1);
        for (const existing of state.holdings.values()) {
          const carried = created.value.holdings.get(existing.symbol);
          expect(carried?.quantity.toFixed()).toBe(existing.quantity.toFixed());
          expect(carried?.currentPrice.toFixed()).toBe(existing.currentPrice.toFixed());
        }
      }),
      { numRuns: 100 },
    );
  });
});
