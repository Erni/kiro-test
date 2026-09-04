import { Decimal } from 'decimal.js';
import fc from 'fast-check';

import { ValidationError } from '../../src/domain/errors';
import { updatePrice } from '../../src/domain/pricing';
import { MAX_DECIMAL_PLACES, MAX_VALUE } from '../../src/domain/types';
import type {
  Holding,
  PortfolioState,
  PriceUpdateInput,
  Transaction,
  TransactionType,
} from '../../src/domain/types';
import { validatePriceUpdateInput } from '../../src/domain/validation';

/**
 * Property 15: Price updates change only the price, and only when valid
 * (Requirements 4.1, 4.2).
 *
 * For any existing Holding, submitting a valid (numeric, `>= 0`) Current_Price
 * updates the Holding's Current_Price to that value while leaving its quantity
 * unchanged; submitting an invalid Current_Price (missing, non-numeric, or
 * `< 0`) is rejected with a validation error and leaves the Holding's
 * Current_Price and quantity unchanged.
 *
 * Both halves go through the real boundary path the service uses —
 * `validatePriceUpdateInput` first, and `updatePrice` only if validation
 * succeeded — because Req 4.1/4.2 describe what the System does with a
 * *submitted* price. Handing a pre-parsed `Decimal` straight to `updatePrice`
 * would skip the only step that can reject it, and would also skip the step
 * where precision can be lost.
 *
 * "Change only the price" is asserted broadly: the target Holding's symbol and
 * quantity, every other Holding, and the whole Transaction list must come
 * through untouched. A revised price quote is not a position change, so it
 * records no history.
 *
 * Values are generated as decimal *strings* and never routed through a
 * JavaScript number, so a generated extreme such as `999999999999.99999999`
 * stays exact instead of rounding on the way in. "Exactly the submitted value"
 * is compared on `toFixed()` output rather than structurally: two `Decimal`
 * instances holding the same value can differ in internal digit
 * representation, and it is the value Req 4.1 constrains.
 *
 * The not-found case (Req 4.3) is deliberately out of scope here; it belongs to
 * Property 6.
 */

/** Inclusive upper bound for a Holding quantity or Current_Price, as a bigint. */
const MAX_WHOLE = BigInt(MAX_VALUE);

/** Largest 8-decimal-place fraction, i.e. `.99999999`. */
const MAX_FRACTION = 10 ** MAX_DECIMAL_PLACES - 1;

/** Symbol alphabet from Req 1.11: uppercase letters and digits only. */
const SYMBOL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

/** How many Holdings the Portfolio may already contain, target included. */
const MAX_EXISTING_HOLDINGS = 4;

/** How many Transactions the Portfolio's history may already contain. */
const MAX_EXISTING_TRANSACTIONS = 3;

/**
 * Decimal strings in `[0, MAX_VALUE]` with up to 8 decimal places, biased
 * towards both ends of the range: small everyday values and the
 * 20-significant-digit extremes that a float-backed path would silently mangle.
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

/**
 * A submitted Current_Price that is absent as far as the boundary is concerned:
 * omitted entirely, explicitly null, or blank text from a form field.
 */
const missingPrices: fc.Arbitrary<unknown> = fc.constantFrom(undefined, null, '', '   ', '\t');

/**
 * A submitted Current_Price that carries no number at all.
 *
 * Every candidate is either of a type that cannot denote a number, or text that
 * decimal.js refuses / parses as a non-finite value. Deliberately excluded:
 * exponent (`1e5`) and hexadecimal (`0xff`) notation, which decimal.js accepts
 * as perfectly good numbers.
 */
const nonNumericPrices: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom<unknown>(
    true,
    false,
    {},
    [],
    { currentPrice: '1' },
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    'abc',
    'NaN',
    'Infinity',
    '-Infinity',
    '1,000.50',
    '$42',
    '42 USD',
    '12.34.56',
    '--5',
    '.',
    'null',
  ),
  // Alphabetic text of any shape is never a price.
  fc
    .stringMatching(/^[A-Za-z]{1,8}$/)
    .filter((text) => !/^(nan|infinity)$/i.test(text)),
);

/**
 * A submitted Current_Price strictly below zero (Req 4.2).
 *
 * Built by negating a strictly-positive value, so no candidate can collapse to
 * `-0`, which decimal.js — correctly — treats as zero and therefore as valid.
 */
const negativePrices: fc.Arbitrary<unknown> = fc.oneof(
  decimalStrings('positive').map((value) => `-${value}`),
  fc.constantFrom<unknown>('-0.00000001', '-1', `-${MAX_VALUE}`, -1, -0.5, -1234.5678),
);

/** Which flavour of invalid Current_Price a run submits. */
type Invalidity = 'missing' | 'nonNumeric' | 'negative';

/** An invalid Current_Price paired with the reason it is invalid, for reporting. */
const invalidPriceArbitrary: fc.Arbitrary<{
  readonly invalidity: Invalidity;
  readonly value: unknown;
}> = fc.oneof(
  fc.record({ invalidity: fc.constant<Invalidity>('missing'), value: missingPrices }),
  fc.record({ invalidity: fc.constant<Invalidity>('nonNumeric'), value: nonNumericPrices }),
  fc.record({ invalidity: fc.constant<Invalidity>('negative'), value: negativePrices }),
);

/**
 * A populated Portfolio, the symbol of the Holding whose price is being
 * revised, a valid replacement price, and an invalid one.
 *
 * The Portfolio carries several Holdings and a Transaction history so that
 * "changes only the price" is checked against a realistic state: a transition
 * that rebuilt the wrong Holding, or that recorded history for a price quote,
 * would go unnoticed against a single-entry Portfolio.
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
    history: fc.array(
      fc.record({
        type: fc.constantFrom<TransactionType>('Buy', 'Sell'),
        quantity: decimalStrings('positive'),
        pricePerUnit: decimalStrings('nonNegative'),
        offsetMinutes: fc.nat({ max: 10_000 }),
      }),
      { minLength: 0, maxLength: MAX_EXISTING_TRANSACTIONS },
    ),
    submittedPrice: decimalStrings('nonNegative'),
    invalidPrice: invalidPriceArbitrary,
    /** Picks which of the generated Holdings is targeted. */
    targetIndex: fc.nat({ max: MAX_EXISTING_HOLDINGS - 1 }),
  })
  .map(({ symbols, values, history, submittedPrice, invalidPrice, targetIndex }) => {
    const holdings = new Map<string, Holding>();
    symbols.forEach((symbol, index) => {
      const value = values[index] as { quantity: string; currentPrice: string };
      holdings.set(symbol, {
        symbol,
        quantity: new Decimal(value.quantity),
        currentPrice: new Decimal(value.currentPrice),
      });
    });

    const transactions: Transaction[] = history.map((entry, index) => ({
      id: `t-${index}`,
      symbol: symbols[index % symbols.length] as string,
      type: entry.type,
      quantity: new Decimal(entry.quantity),
      pricePerUnit: new Decimal(entry.pricePerUnit),
      timestamp: new Date(Date.UTC(2024, 0, 1) + entry.offsetMinutes * 60_000),
    }));

    return {
      state: { holdings, transactions } as PortfolioState,
      // Always an existing Holding: Property 15 is about a reachable target.
      symbol: symbols[targetIndex % symbols.length] as string,
      submittedPrice,
      invalidPrice,
    };
  });

describe('updatePrice', () => {
  // Feature: crypto-portfolio-core, Property 15: Price updates change only the price, and only when valid
  it('sets a valid submitted Current_Price exactly and leaves everything else unchanged', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ state, symbol, submittedPrice }) => {
        const before = snapshot(state);
        const target = state.holdings.get(symbol) as Holding;

        const validated = validatePriceUpdateInput({ currentPrice: submittedPrice });
        // Every generated price is numeric and `>= 0`, so a rejection here would
        // itself be the defect Req 4.1 forbids.
        expect(validated.ok).toBe(true);
        if (!validated.ok) {
          return;
        }

        const updated = updatePrice(state, symbol, validated.value);
        expect(updated.ok).toBe(true);
        if (!updated.ok) {
          return;
        }

        const stored = updated.value.holdings.get(symbol);
        expect(stored).toBeDefined();

        // The price is exactly what was submitted (Req 4.1).
        expect(stored?.currentPrice.toFixed()).toBe(new Decimal(submittedPrice).toFixed());

        // ...and nothing else about the Holding moved.
        expect(stored?.symbol).toBe(target.symbol);
        expect(stored?.quantity.toFixed()).toBe(target.quantity.toFixed());

        // Every other Holding is carried over untouched, so the update cannot
        // have been applied to, or have dropped, the wrong one.
        expect(updated.value.holdings.size).toBe(state.holdings.size);
        for (const existing of state.holdings.values()) {
          if (existing.symbol === symbol) {
            continue;
          }
          const carried = updated.value.holdings.get(existing.symbol);
          expect(carried?.quantity.toFixed()).toBe(existing.quantity.toFixed());
          expect(carried?.currentPrice.toFixed()).toBe(existing.currentPrice.toFixed());
        }

        // A price revision is not a position change, so it records no history.
        expect(transactionSnapshot(updated.value)).toEqual(before.transactions);

        // The transition is pure: the caller's state still holds the old price,
        // which is what makes it usable as the rollback value (Req 5.4).
        expect(snapshot(state)).toEqual(before);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: crypto-portfolio-core, Property 15: Price updates change only the price, and only when valid
  it('rejects a missing, non-numeric, or negative Current_Price and changes nothing', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ state, symbol, invalidPrice }) => {
        const before = snapshot(state);
        const target = state.holdings.get(symbol) as Holding;

        // `missing` covers an omitted field as well as an explicit `undefined`;
        // both must be rejected the same way. An absent property cannot be
        // expressed in `PriceUpdateInput`, which declares the field as required
        // `unknown`, so the omitted case is cast in — that is exactly the shape a
        // JSON body without the field arrives as at runtime.
        const input: PriceUpdateInput =
          invalidPrice.invalidity === 'missing' && invalidPrice.value === undefined
            ? ({} as PriceUpdateInput)
            : { currentPrice: invalidPrice.value };

        const validated = validatePriceUpdateInput(input);

        expect(validated.ok).toBe(false);
        if (validated.ok) {
          // Accepting the input is the defect Req 4.2 forbids. Applying it would
          // be the side effect, so the run stops here rather than continuing.
          return;
        }

        expect(validated.error).toBeInstanceOf(ValidationError);
        expect(validated.error.kind).toBe('ValidationError');
        // The message is field-scoped, as the 400 response body relies on.
        expect(validated.error.field).toBe('currentPrice');
        expect(validated.error.message.startsWith('currentPrice: ')).toBe(true);
        expect(validated.error.message.length).toBeGreaterThan('currentPrice: '.length);

        // No state transition ran, so the target Holding keeps exactly the
        // Current_Price and quantity it had before the attempt (Req 4.2).
        const after = state.holdings.get(symbol) as Holding;
        expect(after.currentPrice.toFixed()).toBe(target.currentPrice.toFixed());
        expect(after.quantity.toFixed()).toBe(target.quantity.toFixed());

        // ...and the rest of the Portfolio, history included, is untouched too.
        expect(snapshot(state)).toEqual(before);
      }),
      { numRuns: 100 },
    );
  });

  // The rejected path above only means something if the same target accepts a
  // valid price, i.e. the rejection came from the payload rather than from the
  // Holding being unreachable.
  it('accepts a valid price for the same target, confirming rejections come from the input', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ state, symbol }) => {
        const validated = validatePriceUpdateInput({ currentPrice: '0' });
        expect(validated.ok).toBe(true);
        if (!validated.ok) {
          return;
        }

        expect(updatePrice(state, symbol, validated.value).ok).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * A comparable view of a Portfolio.
 *
 * `Decimal` and `Date` are reduced to their exact textual forms because two
 * `Decimal` instances holding the same value are not structurally equal, and
 * `toFixed()` compares the value rather than how it is stored. Holdings are
 * sorted by symbol since map iteration order is an implementation detail;
 * Transaction order is preserved, because history ordering is observable
 * behavior (Req 2.8).
 */
function snapshot(state: PortfolioState): {
  readonly holdings: readonly unknown[];
  readonly transactions: readonly unknown[];
} {
  return {
    holdings: [...state.holdings.values()]
      .map((holding: Holding) => ({
        symbol: holding.symbol,
        quantity: holding.quantity.toFixed(),
        currentPrice: holding.currentPrice.toFixed(),
      }))
      .sort((left, right) => left.symbol.localeCompare(right.symbol)),
    transactions: transactionSnapshot(state),
  };
}

/** The Transaction history of a Portfolio, in exact textual form. */
function transactionSnapshot(state: PortfolioState): readonly unknown[] {
  return state.transactions.map((transaction: Transaction) => ({
    id: transaction.id,
    symbol: transaction.symbol,
    type: transaction.type,
    quantity: transaction.quantity.toFixed(),
    pricePerUnit: transaction.pricePerUnit.toFixed(),
    timestamp: transaction.timestamp.toISOString(),
  }));
}
