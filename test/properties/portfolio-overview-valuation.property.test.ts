import { Decimal } from 'decimal.js';
import fc from 'fast-check';

import { addHolding, updateHolding } from '../../src/domain/holdings';
import { MAX_DECIMAL_PLACES, MAX_VALUE } from '../../src/domain/types';
import type { PortfolioState } from '../../src/domain/types';
import {
  validateHoldingUpdateInput,
  validateNewHoldingInput,
} from '../../src/domain/validation';
import { portfolioOverview } from '../../src/domain/valuation';

/**
 * Property 14: Portfolio overview values are always quantity times price,
 * summed correctly (Requirements 3.1, 3.2, 3.3, 3.4).
 *
 * For any set of Holdings, requesting the Portfolio overview returns, for every
 * Holding, a Holding_Value equal to that Holding's quantity multiplied by its
 * Current_Price, and a Portfolio_Value equal to the sum of all returned
 * Holding_Values (zero when there are no Holdings).
 *
 * Expected values come from an **independent oracle**, not from `Decimal`:
 * quantities and Current_Prices are exact multiples of 10^-8, so each is an
 * integer number of hundred-millionths and the product of two of them is an
 * integer number of 10^-16 units. The oracle multiplies and sums those scaled
 * integers as `BigInt`s — exact by construction, unbounded, and with no rounding
 * mode to configure — then renders the result as a plain decimal string. Calling
 * `Decimal.times`/`Decimal.plus` in the assertions instead would only prove the
 * implementation agrees with itself, and would inherit the very rounding that
 * `Decimal.precision` governs (see `src/domain/decimalConfig.ts`).
 *
 * Holdings are built through the real boundary path — `validateNewHoldingInput`
 * followed by `addHolding` — so the values being valued are the ones a user's
 * submission actually produced, and generated values never pass through a
 * JavaScript number.
 *
 * Req 3.4 (values as of the time of the request) is checked by revising one
 * Holding's quantity and Current_Price and re-requesting the overview: the same
 * invariant must hold against the revised state, which a cached or precomputed
 * Holding_Value would fail.
 *
 * Comparisons use `toFixed()` output rather than structural equality, since two
 * `Decimal` instances holding the same value can differ in internal digit
 * representation and it is the value the requirements constrain.
 */

/** Inclusive upper bound for generated quantities and prices, as a bigint. */
const MAX_WHOLE = BigInt(MAX_VALUE);

/** Largest 8-decimal-place fraction, i.e. `.99999999`. */
const MAX_FRACTION = 10 ** MAX_DECIMAL_PLACES - 1;

/** Symbol alphabet from Req 1.11: uppercase letters and digits only. */
const SYMBOL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

/** How many Holdings a generated Portfolio may contain. Zero covers Req 3.3. */
const MAX_HOLDINGS = 5;

/** Decimal places carried by a quantity or Current_Price. */
const INPUT_SCALE = MAX_DECIMAL_PLACES;

/** Decimal places carried by an exact `quantity * currentPrice` product. */
const VALUE_SCALE = INPUT_SCALE * 2;

/**
 * Decimal strings in `[0, MAX_VALUE]` with up to 8 decimal places, biased
 * towards both ends of the range: small everyday values and the
 * 20-significant-digit extremes whose exact product needs 40 significant digits.
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

/** A quantity/Current_Price pair inside the Req 1.1 ranges, as strings. */
const valuesArbitrary = fc.record({
  quantity: decimalStrings('positive'),
  currentPrice: decimalStrings('nonNegative'),
});

/**
 * A Portfolio of 0-5 distinct Holdings, plus a revision to apply to one of them
 * afterwards. `uniqueArray` with `minLength: 0` lets the empty Portfolio be
 * generated, which is the Req 3.3 case.
 */
const scenarioArbitrary = fc.record({
  symbols: fc.uniqueArray(symbolArbitrary, { minLength: 0, maxLength: MAX_HOLDINGS }),
  values: fc.array(valuesArbitrary, { minLength: MAX_HOLDINGS, maxLength: MAX_HOLDINGS }),
  revision: fc.record({ at: fc.nat({ max: MAX_HOLDINGS - 1 }), values: valuesArbitrary }),
});

/** What each Holding should be worth, tracked as exact strings. */
type Model = Map<string, { quantity: string; currentPrice: string }>;

describe('portfolioOverview across arbitrary sets of Holdings', () => {
  // Feature: crypto-portfolio-core, Property 14: Portfolio overview values are always quantity times price, summed correctly
  it('reports every Holding_Value as quantity times Current_Price and the Portfolio_Value as their sum', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ symbols, values, revision }) => {
        let state: PortfolioState = { holdings: new Map(), transactions: [] };
        const model: Model = new Map();

        // Req 3.3: an empty Portfolio has no Holdings and a Portfolio_Value of
        // zero — asserted before anything is added, and again below whenever the
        // generated Portfolio is itself empty.
        const empty = portfolioOverview(state);
        expect(empty.holdings).toEqual([]);
        expect(empty.portfolioValue.isZero()).toBe(true);
        expect(empty.portfolioValue.toFixed()).toBe('0');

        symbols.forEach((symbol, index) => {
          const { quantity, currentPrice } = values[index] as {
            quantity: string;
            currentPrice: string;
          };

          const validated = validateNewHoldingInput({ symbol, quantity, currentPrice });
          // The generated values are inside the Req 1.1 ranges, so a rejection
          // here would itself be a defect.
          expect(validated.ok).toBe(true);
          if (!validated.ok) {
            return;
          }

          // The symbols are unique, so every creation is expected to succeed.
          const created = addHolding(state, validated.value);
          expect(created.ok).toBe(true);
          if (!created.ok) {
            return;
          }

          state = created.value;
          model.set(symbol, { quantity, currentPrice });
        });

        expectOverviewMatches(state, model);

        if (symbols.length === 0) {
          return;
        }

        // Req 3.4: revise a Holding, then request the overview again. The values
        // must reflect the state as of this request, not the earlier one.
        const target = symbols[revision.at % symbols.length] as string;
        const revised = validateHoldingUpdateInput(revision.values);
        expect(revised.ok).toBe(true);
        if (!revised.ok) {
          return;
        }

        const updated = updateHolding(state, target, revised.value);
        expect(updated.ok).toBe(true);
        if (!updated.ok) {
          return;
        }

        state = updated.value;
        model.set(target, revision.values);

        expectOverviewMatches(state, model);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Asserts the overview against the model: exactly the current Holdings
 * (Req 3.1), each carrying its submitted quantity and Current_Price and a
 * Holding_Value equal to their exact product, and a Portfolio_Value equal to the
 * exact sum of those products (Req 3.2), zero when there are none (Req 3.3).
 */
function expectOverviewMatches(state: PortfolioState, model: Model): void {
  const overview = portfolioOverview(state);
  const views = overview.holdings;

  // Req 3.1: exactly the current Holdings — same count, no duplicates, no
  // missing and no extra symbols. Order is not constrained by the requirement.
  expect(views).toHaveLength(model.size);
  const symbols = views.map((view) => view.symbol);
  expect(new Set(symbols).size).toBe(views.length);
  expect([...symbols].sort()).toEqual([...model.keys()].sort());

  let expectedTotal = 0n;

  for (const view of views) {
    const expected = model.get(view.symbol);
    expect(expected).toBeDefined();
    if (expected === undefined) {
      return;
    }

    // Req 3.1: the overview reports the Holding's own quantity and Current_Price.
    expect(view.quantity.toFixed()).toBe(new Decimal(expected.quantity).toFixed());
    expect(view.currentPrice.toFixed()).toBe(new Decimal(expected.currentPrice).toFixed());

    // Req 3.1: Holding_Value is exactly quantity * Current_Price, per the
    // BigInt oracle rather than a second Decimal multiplication.
    const scaledValue = toScaled(expected.quantity) * toScaled(expected.currentPrice);
    expect(view.holdingValue.toFixed()).toBe(formatScaled(scaledValue, VALUE_SCALE));

    expectedTotal += scaledValue;
  }

  // Req 3.2: the Portfolio_Value is the sum of the returned Holding_Values —
  // and Req 3.3's zero falls out of the empty sum.
  expect(overview.portfolioValue.toFixed()).toBe(formatScaled(expectedTotal, VALUE_SCALE));
  if (model.size === 0) {
    expect(overview.portfolioValue.isZero()).toBe(true);
  }
}

/**
 * A quantity or Current_Price as an exact integer number of 10^-8 units.
 *
 * Purely string arithmetic: the fraction is right-padded to 8 digits and
 * concatenated onto the integer part, so no rounding or float conversion is
 * involved. Inputs come from `decimalStrings`, so they are non-negative and
 * carry at most 8 decimal places.
 */
function toScaled(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(`${whole}${fraction.padEnd(INPUT_SCALE, '0')}`);
}

/**
 * Renders a scaled integer as a plain decimal string with trailing zeros
 * trimmed, matching what `Decimal.toFixed()` emits for the same value.
 */
function formatScaled(scaled: bigint, scale: number): string {
  const digits = scaled.toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');

  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}
