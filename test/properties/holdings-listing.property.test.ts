import { Decimal } from 'decimal.js';
import fc from 'fast-check';

import { addHolding, listHoldings, removeHolding, updateHolding } from '../../src/domain/holdings';
import { MAX_DECIMAL_PLACES, MAX_VALUE } from '../../src/domain/types';
import type { PortfolioState } from '../../src/domain/types';
import {
  validateHoldingUpdateInput,
  validateNewHoldingInput,
} from '../../src/domain/validation';

/**
 * Property 8: Listing holdings always reflects exactly the current holdings
 * (Requirement 1.8).
 *
 * For any sequence of holding creations, updates, and removals applied to a
 * Portfolio, requesting the list of Holdings returns exactly the set of Holdings
 * currently present (order-independent), or an empty list if none are present.
 *
 * "Exactly" is checked against an independent model of what the Portfolio should
 * contain, rebuilt from the operation sequence rather than read back out of the
 * state under test. Comparing `listHoldings` to `state.holdings` would only prove
 * the listing agrees with itself; the model is what makes a dropped or stale
 * Holding visible.
 *
 * The listing is asserted after *every* operation, not only at the end of the
 * sequence, so the first step where the listing and the model diverge is the one
 * that gets reported.
 *
 * Operations run through the real boundary path — the validators followed by the
 * state transitions — because Req 1.8 is about the Holdings a user's submissions
 * actually produced. Rejected operations (duplicate symbol, missing Holding) are
 * part of the generated space on purpose: the listing must be unchanged after
 * one, which is a stricter statement than the successful path alone.
 *
 * Values are generated as decimal *strings* and parsed with `Decimal`, never via
 * JavaScript numbers, so the generators cannot lose precision that the
 * comparisons would then blame on the code. Equality is asserted on `toFixed()`
 * output, since two `Decimal` instances holding the same value can differ in
 * internal digit representation and it is the value Req 1.8 concerns.
 */

/** Inclusive upper bound for generated quantities and prices, as a bigint. */
const MAX_WHOLE = BigInt(MAX_VALUE);

/** Largest 8-decimal-place fraction, i.e. `.99999999`. */
const MAX_FRACTION = 10 ** MAX_DECIMAL_PLACES - 1;

/** Symbol alphabet from Req 1.11: uppercase letters and digits only. */
const SYMBOL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

/**
 * Size of the symbol pool an operation sequence draws from. Deliberately small:
 * a narrow pool makes symbols collide, which is what produces re-creations of a
 * previously removed symbol, duplicate rejections, and runs that empty the
 * Portfolio again.
 */
const SYMBOL_POOL_SIZE = 3;

/** How many operations a single sequence may contain. */
const MAX_OPERATIONS = 12;

/**
 * Decimal strings in `[0, MAX_VALUE]` with up to 8 decimal places, biased
 * towards both ends of the range: small everyday values and the
 * 20-significant-digit extremes a float-backed path would silently mangle.
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

/** A quantity/Current_Price pair inside the Req 1.1 ranges. */
const valuesArbitrary = fc.record({
  quantity: decimalStrings('positive'),
  currentPrice: decimalStrings('nonNegative'),
});

/**
 * A single operation. The symbol is referenced by index into the sequence's
 * symbol pool rather than generated freely, so operations actually target the
 * same Holdings. `remove` is weighted up a little so sequences regularly end
 * with an empty Portfolio, which is the second half of Req 1.8.
 */
const operationArbitrary = fc.record({
  kind: fc.constantFrom<'add' | 'update' | 'remove'>(
    'add',
    'add',
    'update',
    'remove',
    'remove',
  ),
  at: fc.nat({ max: SYMBOL_POOL_SIZE - 1 }),
  values: valuesArbitrary,
});

/** A pool of distinct symbols plus the operation sequence to apply to it. */
const scenarioArbitrary = fc.record({
  pool: fc.uniqueArray(symbolArbitrary, {
    minLength: SYMBOL_POOL_SIZE,
    maxLength: SYMBOL_POOL_SIZE,
  }),
  operations: fc.array(operationArbitrary, { minLength: 0, maxLength: MAX_OPERATIONS }),
});

/** What the Portfolio should contain, tracked independently of the state. */
type Model = Map<string, { quantity: string; currentPrice: string }>;

describe('listHoldings across sequences of holding operations', () => {
  // Feature: crypto-portfolio-core, Property 8: Listing holdings always reflects exactly the current holdings
  it('returns exactly the Holdings currently present, and an empty list when there are none', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ pool, operations }) => {
        let state: PortfolioState = { holdings: new Map(), transactions: [] };
        const model: Model = new Map();

        // Req 1.8, second half: an untouched Portfolio lists nothing.
        expect(listHoldings(state)).toEqual([]);

        for (const operation of operations) {
          const symbol = pool[operation.at] as string;
          const { quantity, currentPrice } = operation.values;
          const held = model.has(symbol);

          if (operation.kind === 'add') {
            const validated = validateNewHoldingInput({ symbol, quantity, currentPrice });
            // The generated values are inside the Req 1.1 ranges, so a
            // rejection here would itself be a defect.
            expect(validated.ok).toBe(true);
            if (!validated.ok) {
              return;
            }

            const result = addHolding(state, validated.value);
            // Succeeds exactly when the symbol is not already held (Req 1.2).
            expect(result.ok).toBe(!held);
            if (result.ok) {
              state = result.value;
              model.set(symbol, { quantity, currentPrice });
            }
          } else if (operation.kind === 'update') {
            const validated = validateHoldingUpdateInput({ quantity, currentPrice });
            expect(validated.ok).toBe(true);
            if (!validated.ok) {
              return;
            }

            const result = updateHolding(state, symbol, validated.value);
            // Succeeds exactly when the Holding exists (Req 1.9).
            expect(result.ok).toBe(held);
            if (result.ok) {
              state = result.value;
              model.set(symbol, { quantity, currentPrice });
            }
          } else {
            const result = removeHolding(state, symbol);
            // Succeeds exactly when the Holding exists (Req 1.10).
            expect(result.ok).toBe(held);
            if (result.ok) {
              state = result.value;
              model.delete(symbol);
            }
          }

          // Req 1.8: after every operation — applied or rejected — the listing
          // is exactly the current Holdings.
          expectListingMatches(state, model);
        }

        // And once more at the end of the sequence, which for remove-heavy runs
        // is the empty-Portfolio case.
        expectListingMatches(state, model);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Asserts `listHoldings` returns exactly the modelled Holdings: same
 * cardinality, no duplicate symbols, no missing or extra symbols, and each
 * Holding carrying its exact quantity and Current_Price. Symbols are compared as
 * sorted sets because Req 1.8 says nothing about order.
 */
function expectListingMatches(state: PortfolioState, model: Model): void {
  const listed = listHoldings(state);
  const listedSymbols = listed.map((holding) => holding.symbol);

  // Same cardinality, and no symbol listed twice — an empty model therefore
  // requires an empty list.
  expect(listed).toHaveLength(model.size);
  expect(new Set(listedSymbols).size).toBe(listed.length);

  // No missing, no extra.
  expect([...listedSymbols].sort()).toEqual([...model.keys()].sort());

  // Exact values, per Holding.
  for (const holding of listed) {
    const expected = model.get(holding.symbol);
    expect(expected).toBeDefined();
    expect(holding.quantity.toFixed()).toBe(new Decimal(expected?.quantity as string).toFixed());
    expect(holding.currentPrice.toFixed()).toBe(
      new Decimal(expected?.currentPrice as string).toFixed(),
    );
  }
}
