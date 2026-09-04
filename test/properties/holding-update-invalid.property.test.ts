import { Decimal } from 'decimal.js';
import fc from 'fast-check';

import { ValidationError } from '../../src/domain/errors';
import { listHoldings, updateHolding } from '../../src/domain/holdings';
import { MAX_DECIMAL_PLACES, MAX_VALUE } from '../../src/domain/types';
import type { Holding, PortfolioState } from '../../src/domain/types';
import { validateHoldingUpdateInput } from '../../src/domain/validation';

/**
 * Property 5: Invalid holding update is always rejected without side effects
 * (Requirement 1.6).
 *
 * For any existing Holding and any update input where the quantity is `<= 0` or
 * `> 1_000_000_000_000`, or the Current_Price is `< 0` or
 * `> 1_000_000_000_000`, the update is rejected with a validation error and the
 * Holding retains its pre-update quantity and Current_Price.
 *
 * The submission goes through the real boundary path the service uses —
 * `validateHoldingUpdateInput` first, and `updateHolding` only if validation
 * succeeded — because Req 1.6 is a statement about what happens to a *submitted*
 * update. Handing pre-parsed `Decimal`s straight to `updateHolding` would skip
 * the only step that can reject them, and would prove nothing.
 *
 * "Without side effects" is checked two ways: the untouched Portfolio still
 * carries the target Holding's original quantity and Current_Price, and no state
 * transition was invoked at all (the guard below fails the run if validation
 * unexpectedly accepted the input, rather than quietly skipping it).
 *
 * Values are generated as decimal *strings* and never routed through a
 * JavaScript number, so a generated "just over the limit" value such as
 * `1000000000000.00000001` stays exactly that instead of rounding back inside
 * the allowed range.
 *
 * Only the quantity/Current_Price range rules named by Property 5 are exercised
 * here. Symbol-format rejection belongs to Property 3, and a missing Holding to
 * Property 6.
 */

/** Inclusive upper bound for a valid quantity or Current_Price, as a bigint. */
const MAX_WHOLE = BigInt(MAX_VALUE);

/** Largest 8-decimal-place fraction, i.e. `.99999999`. */
const MAX_FRACTION = 10 ** MAX_DECIMAL_PLACES - 1;

/** Symbol alphabet from Req 1.11: uppercase letters and digits only. */
const SYMBOL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

/** How many Holdings the Portfolio may already contain, target included. */
const MAX_EXISTING_HOLDINGS = 4;

/**
 * Decimal strings inside the allowed range `[0, MAX_VALUE]` with up to 8 decimal
 * places, biased towards both ends: small everyday values and the
 * 20-significant-digit extremes. Used for the pre-existing Holding values and
 * for the field that is deliberately left valid, so a rejection is always
 * attributable to the field that was made invalid.
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

/**
 * Values equal to zero, in every spelling decimal.js treats as zero. Invalid for
 * a quantity (`> 0` required), but *valid* for a Current_Price, so this feeds the
 * quantity generator only.
 */
const zeroStrings: fc.Arbitrary<string> = fc.constantFrom('0', '0.0', '0.00000000', '-0', '0e5');

/** Values strictly below zero: invalid for both fields. */
const negativeStrings: fc.Arbitrary<string> = decimalStrings('positive').map(
  (value) => `-${value}`,
);

/** Values strictly above MAX_VALUE, from one hundred-millionth over to far over. */
const aboveMaxStrings: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    `${MAX_VALUE}.00000001`,
    `${MAX_WHOLE + 1n}`,
    `${MAX_WHOLE * 1000n}`,
    '1e13',
  ),
  fc.bigInt({ min: MAX_WHOLE + 1n, max: MAX_WHOLE * 1_000_000n }).map(String),
  fc
    .integer({ min: 1, max: MAX_FRACTION })
    .map((digits) => `${MAX_VALUE}.${String(digits).padStart(MAX_DECIMAL_PLACES, '0')}`),
);

/** Quantity violations from Req 1.6: `<= 0` or `> MAX_VALUE`. */
const invalidQuantityStrings = fc.oneof(zeroStrings, negativeStrings, aboveMaxStrings);

/** Current_Price violations from Req 1.6: `< 0` or `> MAX_VALUE`. */
const invalidPriceStrings = fc.oneof(negativeStrings, aboveMaxStrings);

/** Symbols matching `[A-Z0-9]{1,10}` (Req 1.11). */
const symbolArbitrary: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...SYMBOL_CHARS), { minLength: 1, maxLength: 10 })
  .map((characters) => characters.join(''));

/** Which field of the update is out of range. */
type Violation = 'quantity' | 'currentPrice' | 'both';

/**
 * A populated Portfolio, the symbol of the Holding being updated, and an update
 * whose quantity, Current_Price, or both fall outside the allowed range.
 *
 * The Portfolio holds several Holdings so that "the Holding is unchanged" is
 * checked against a realistic state rather than a single-entry one.
 */
const scenarioArbitrary = fc
  .record({
    symbols: fc.uniqueArray(symbolArbitrary, { minLength: 1, maxLength: MAX_EXISTING_HOLDINGS }),
    values: fc.array(
      fc.record({
        quantity: decimalStrings('positive'),
        currentPrice: decimalStrings('nonNegative'),
      }),
      { minLength: MAX_EXISTING_HOLDINGS, maxLength: MAX_EXISTING_HOLDINGS },
    ),
    violation: fc.constantFrom<Violation>('quantity', 'currentPrice', 'both'),
    invalidQuantity: invalidQuantityStrings,
    invalidPrice: invalidPriceStrings,
    validQuantity: decimalStrings('positive'),
    validPrice: decimalStrings('nonNegative'),
  })
  .map(
    ({
      symbols,
      values,
      violation,
      invalidQuantity,
      invalidPrice,
      validQuantity,
      validPrice,
    }) => {
      const holdings = new Map<string, Holding>();
      symbols.forEach((symbol, index) => {
        const value = values[index] as { quantity: string; currentPrice: string };
        holdings.set(symbol, {
          symbol,
          quantity: new Decimal(value.quantity),
          currentPrice: new Decimal(value.currentPrice),
        });
      });

      return {
        state: { holdings, transactions: [] } as PortfolioState,
        // Always an existing Holding: Property 5 is about a *valid* target with
        // an invalid payload.
        symbol: symbols[0] as string,
        update: {
          quantity: violation === 'currentPrice' ? validQuantity : invalidQuantity,
          currentPrice: violation === 'quantity' ? validPrice : invalidPrice,
        },
        // Validation reports the first offending field, and it checks quantity
        // before Current_Price.
        expectedField: violation === 'currentPrice' ? 'currentPrice' : 'quantity',
      };
    },
  );

describe('updateHolding with out-of-range input', () => {
  // Feature: crypto-portfolio-core, Property 5: Invalid holding update is always rejected without side effects
  it('rejects the update with a field-level validation error and leaves the Holding unchanged', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ state, symbol, update, expectedField }) => {
        const before = state.holdings.get(symbol) as Holding;
        const beforeQuantity = before.quantity.toFixed();
        const beforePrice = before.currentPrice.toFixed();

        const validated = validateHoldingUpdateInput(update);

        expect(validated.ok).toBe(false);
        if (validated.ok) {
          // Accepting the input is the defect Req 1.6 forbids. Applying it would
          // be the side effect, so the run stops here rather than continuing.
          return;
        }

        expect(validated.error).toBeInstanceOf(ValidationError);
        expect(validated.error.kind).toBe('ValidationError');
        expect(validated.error.field).toBe(expectedField);
        // The message is field-scoped, as the 400 response body relies on.
        expect(validated.error.message.startsWith(`${expectedField}: `)).toBe(true);
        expect(validated.error.message.length).toBeGreaterThan(expectedField.length + 2);

        // No state transition ran, so the target Holding keeps exactly the
        // quantity and Current_Price it had before the attempt.
        const after = state.holdings.get(symbol) as Holding;
        expect(after.quantity.toFixed()).toBe(beforeQuantity);
        expect(after.currentPrice.toFixed()).toBe(beforePrice);

        // ...and the rest of the Portfolio is untouched too.
        expect(listHoldings(state)).toHaveLength(state.holdings.size);
        expect(state.holdings.size).toBe(new Set(state.holdings.keys()).size);
        expect(state.transactions).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  // The rejected path is only meaningful if the same target accepts a valid
  // update, i.e. the Holding was reachable and the rejection came from the
  // payload rather than from the Holding being absent.
  it('applies an in-range update to the same Holding, confirming the rejection came from the input', () => {
    fc.assert(
      fc.property(scenarioArbitrary, decimalStrings('positive'), ({ state, symbol }, quantity) => {
        const applied = updateHolding(state, symbol, {
          quantity: new Decimal(quantity),
          currentPrice: new Decimal('1'),
        });

        expect(applied.ok).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
