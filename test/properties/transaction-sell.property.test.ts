import { Decimal } from 'decimal.js';
import fc from 'fast-check';

import { InsufficientQuantityError } from '../../src/domain/errors';
import { applyTransaction, transactionHistory } from '../../src/domain/transactions';
import { MAX_DECIMAL_PLACES, MAX_VALUE } from '../../src/domain/types';
import type {
  Holding,
  PortfolioState,
  Transaction,
  TransactionType,
} from '../../src/domain/types';
import { validateTransactionInput } from '../../src/domain/validation';

/**
 * Property 10: Sell transactions decrease quantity or are rejected for
 * insufficient quantity (Requirements 2.2, 2.4).
 *
 * For any Portfolio, symbol, and valid Sell Transaction (quantity `> 0`, price
 * `>= 0`): if no Holding exists for the symbol, or the Holding's quantity is
 * less than the Transaction's quantity, the Transaction is rejected with an
 * insufficient-quantity error and the Portfolio is unchanged; otherwise the
 * Holding's resulting quantity equals its prior quantity minus the Transaction's
 * quantity.
 *
 * The submission goes through the real boundary path — `validateTransactionInput`
 * followed by `applyTransaction` — because Req 2.2 is about what the System does
 * with a *submitted* Transaction. Feeding pre-built `Decimal`s straight into
 * `applyTransaction` would skip the step where precision can be lost, and would
 * let the test assert against inputs the boundary would never actually produce.
 *
 * A single generator drives both halves of the property: the sell quantity is
 * drawn *relative to* the quantity on hand — a strict fraction of it, exactly
 * all of it, one hundred-millionth more than it, or an unrelated value — and the
 * target symbol is sometimes not held at all. The expected branch is then
 * derived from the state rather than dictated by the generator, so the test
 * cannot silently stop exercising one side.
 *
 * On the accepted side, "decreased by exactly the sold amount" is asserted
 * against the *effective* resulting quantity: zero when the Sell empties the
 * position, since Req 2.7 removes the Holding in that case. That much overlap
 * with Property 12 is unavoidable — the arithmetic has to be checked somewhere
 * for a full sell — but the retention of history that Property 12 is really
 * about is left to its own test.
 *
 * On the rejected side the whole Portfolio is compared against a pre-call
 * snapshot, which is what catches the failure mode that matters: a Transaction
 * appended to the history for a Sell that was refused.
 *
 * Values are generated as decimal *strings* and parsed with `Decimal`, never via
 * JavaScript numbers, so the generators cannot lose the precision the
 * comparisons then blame on the code. Comparisons use `toFixed()` because two
 * `Decimal` instances holding the same value need not be structurally equal.
 */

/** Inclusive upper bound for generated Holding quantities and prices, as a bigint. */
const MAX_WHOLE = BigInt(MAX_VALUE);

/** Largest 8-decimal-place fraction, i.e. `.99999999`. */
const MAX_FRACTION = 10 ** MAX_DECIMAL_PLACES - 1;

/** Smallest representable step at 8 decimal places, used to just overshoot a position. */
const SMALLEST_STEP = new Decimal('0.00000001');

/** Symbol alphabet from Req 1.11: uppercase letters and digits only. */
const SYMBOL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

/** Size of the symbol pool a scenario draws from. */
const MAX_SYMBOLS = 4;

/** How many Transactions a single scenario may seed across all symbols. */
const MAX_TRANSACTIONS = 6;

/**
 * Decimal strings in `[0, MAX_VALUE]` with up to 8 decimal places, biased
 * towards both ends of the range: small everyday values and the
 * 20-significant-digit extremes where a value-comparison shortcut would show up.
 *
 * `positive` additionally guarantees `> 0`, as Holding and Transaction
 * quantities require.
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
 * How the Sell quantity relates to the quantity on hand.
 *
 * `part` and `all` land on the accepted side, `overshoot` and `far` on the
 * rejected side (unless the target is unheld, which rejects regardless).
 * `unrelated` is drawn independently of the position and so can fall on either
 * side — that is the case that keeps the test honest about deriving the expected
 * outcome from the state rather than from the generator's intent.
 */
type SellMode = 'part' | 'all' | 'overshoot' | 'far' | 'unrelated';

/**
 * A seeded pre-existing Transaction, referenced to the scenario's symbol pool by
 * index and weighted towards the Sell target so histories are non-trivial there.
 */
const seedTransactionArbitrary = fc.record({
  at: fc.oneof(fc.constant(0), fc.nat({ max: MAX_SYMBOLS - 1 })),
  type: fc.constantFrom<TransactionType>('Buy', 'Sell'),
  quantity: decimalStrings('positive'),
  pricePerUnit: decimalStrings('nonNegative'),
  timestamp: fc.date({
    min: new Date('2000-01-01T00:00:00.000Z'),
    max: new Date('2100-01-01T00:00:00.000Z'),
    noInvalidDate: true,
  }),
});

/** A Portfolio, the symbol to sell, and the Sell quantity to submit. */
const scenarioArbitrary = fc
  .record({
    symbols: fc.uniqueArray(symbolArbitrary, { minLength: 2, maxLength: MAX_SYMBOLS }),
    values: fc.array(valuesArbitrary, { minLength: MAX_SYMBOLS, maxLength: MAX_SYMBOLS }),
    held: fc.array(fc.boolean(), { minLength: MAX_SYMBOLS, maxLength: MAX_SYMBOLS }),
    // The target is unheld only occasionally: the no-Holding case of Req 2.4 is
    // worth hitting regularly, but not at the expense of the arithmetic case.
    targetHeld: fc.oneof(
      { weight: 3, arbitrary: fc.constant(true) },
      { weight: 1, arbitrary: fc.constant(false) },
    ),
    mode: fc.constantFrom<SellMode>('part', 'all', 'overshoot', 'far', 'unrelated'),
    // Fraction of the position to sell in `part` mode, as a per-hundred-million
    // share so it stays exact.
    share: fc.integer({ min: 1, max: MAX_FRACTION }),
    standalone: decimalStrings('positive'),
    pricePerUnit: decimalStrings('nonNegative'),
    seeds: fc.array(seedTransactionArbitrary, { minLength: 0, maxLength: MAX_TRANSACTIONS }),
  })
  .map(({ symbols, values, held, targetHeld, mode, share, standalone, pricePerUnit, seeds }) => {
    const pool = symbols as [string, string, ...string[]];
    const target = pool[0];

    const holdings = new Map<string, Holding>();
    pool.forEach((symbol, index) => {
      if (index === 0 ? !targetHeld : held[index] !== true) {
        return;
      }
      const value = values[index] as { quantity: string; currentPrice: string };
      holdings.set(symbol, {
        symbol,
        quantity: new Decimal(value.quantity),
        currentPrice: new Decimal(value.currentPrice),
      });
    });

    const onHand = holdings.get(target)?.quantity;
    const sellQuantity = sellQuantityFor(mode, onHand, share, standalone);

    const transactions: Transaction[] = seeds.map((seed, index) => ({
      id: `seed-${index}`,
      symbol: pool[seed.at % pool.length] as string,
      type: seed.type,
      quantity: new Decimal(seed.quantity),
      pricePerUnit: new Decimal(seed.pricePerUnit),
      timestamp: seed.timestamp,
    }));

    return {
      state: { holdings, transactions } as PortfolioState,
      target,
      // Submitted as a string, the way it arrives at the boundary.
      quantity: sellQuantity.toFixed(),
      pricePerUnit,
    };
  });

/**
 * Derives the Sell quantity for a mode. Always returns a value `> 0` so the
 * submission is valid per Req 2.6 and the property is exercising the
 * state-dependent rule of Req 2.4 rather than validation.
 */
function sellQuantityFor(
  mode: SellMode,
  onHand: Decimal | undefined,
  share: number,
  standalone: string,
): Decimal {
  if (onHand === undefined) {
    // Nothing on hand to be relative to; any positive quantity rejects.
    return new Decimal(standalone);
  }

  switch (mode) {
    case 'all':
      return onHand;
    case 'part': {
      // A strict fraction of the position, rounded down to 8 decimal places and
      // floored at the smallest step so it stays positive and `< onHand`.
      const fraction = onHand
        .times(share)
        .dividedBy(MAX_FRACTION + 1)
        .toDecimalPlaces(MAX_DECIMAL_PLACES, Decimal.ROUND_DOWN);
      return fraction.isZero() || fraction.greaterThanOrEqualTo(onHand)
        ? Decimal.min(SMALLEST_STEP, onHand)
        : fraction;
    }
    case 'overshoot':
      // The tightest possible rejection: one hundred-millionth too many.
      return onHand.plus(SMALLEST_STEP);
    case 'far':
      return onHand.plus(new Decimal(standalone));
    case 'unrelated':
    default:
      return new Decimal(standalone);
  }
}

describe('applyTransaction with a Sell transaction', () => {
  // Feature: crypto-portfolio-core, Property 10: Sell transactions decrease quantity or are rejected for insufficient quantity
  it('decreases the holding by exactly the sold quantity, or rejects with insufficient quantity and changes nothing', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ state, target, quantity, pricePerUnit }) => {
        const validated = validateTransactionInput({
          symbol: target,
          type: 'Sell',
          quantity,
          pricePerUnit,
        });
        // Every generated Sell has quantity > 0 and price >= 0, so a rejection
        // here would itself be a defect (Req 2.6).
        expect(validated.ok).toBe(true);
        if (!validated.ok) {
          return;
        }

        const before = snapshot(state);
        const seededCount = state.transactions.length;
        const existing = state.holdings.get(target);
        const requested = validated.value.quantity;
        const sufficient = existing !== undefined && existing.quantity.greaterThanOrEqualTo(requested);

        const timestamp = new Date('2024-06-01T12:00:00.000Z');
        const applied = applyTransaction(state, validated.value, {
          newId: () => 'applied-sell',
          now: () => timestamp,
        });

        if (!sufficient) {
          // Req 2.4: no Holding, or not enough of it, is rejected.
          expect(applied.ok).toBe(false);
          if (applied.ok) {
            return;
          }
          expect(applied.error).toBeInstanceOf(InsufficientQuantityError);
          expect(applied.error.symbol).toBe(target);
          expect(applied.error.requested.toFixed()).toBe(requested.toFixed());
          expect(applied.error.available.toFixed()).toBe(
            (existing?.quantity ?? new Decimal(0)).toFixed(),
          );

          // "The Portfolio is unchanged": no Holding touched and — the failure
          // mode worth guarding — no Transaction appended.
          expect(snapshot(state)).toEqual(before);
          expect(state.transactions).toHaveLength(seededCount);
          expect(state.transactions.some((recorded) => recorded.id === 'applied-sell')).toBe(false);
          expect(
            transactionHistory(state, target).some((recorded) => recorded.id === 'applied-sell'),
          ).toBe(false);
          return;
        }

        // Req 2.2: the position decreases by exactly the sold quantity.
        expect(applied.ok).toBe(true);
        if (!applied.ok) {
          return;
        }

        const next = applied.value.state;
        const held = existing as Holding;
        const remaining = held.quantity.minus(requested);

        // Effective resulting quantity: a Holding emptied to zero is removed
        // from the Portfolio (Req 2.7), so its remaining quantity reads as zero.
        const resulting = next.holdings.get(target)?.quantity ?? new Decimal(0);
        expect(resulting.toFixed()).toBe(remaining.toFixed());

        if (!remaining.isZero()) {
          // A Sell is a position change, not a price quote: the Current_Price
          // survives it.
          expect(next.holdings.get(target)?.currentPrice.toFixed()).toBe(
            held.currentPrice.toFixed(),
          );
        }

        // The Transaction is recorded, exactly as submitted.
        expect(next.transactions).toHaveLength(state.transactions.length + 1);
        expect(transactionSnapshot(applied.value.transaction)).toEqual({
          id: 'applied-sell',
          symbol: target,
          type: 'Sell',
          quantity: requested.toFixed(),
          pricePerUnit: new Decimal(pricePerUnit).toFixed(),
          timestamp: timestamp.toISOString(),
        });
        expect(next.transactions[next.transactions.length - 1]).toBe(applied.value.transaction);

        // Every other Holding is carried over untouched, so "decreases the
        // corresponding Holding" cannot be satisfied by rewriting the rest.
        for (const other of state.holdings.values()) {
          if (other.symbol === target) {
            continue;
          }
          const carried = next.holdings.get(other.symbol);
          expect(carried?.quantity.toFixed()).toBe(other.quantity.toFixed());
          expect(carried?.currentPrice.toFixed()).toBe(other.currentPrice.toFixed());
        }

        // The transition is pure: the pre-call state is what the service layer
        // keeps as its rollback value when persistence fails (Req 5.4).
        expect(snapshot(state)).toEqual(before);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * A comparable view of a Transaction.
 *
 * `Decimal` and `Date` are reduced to their exact textual forms: two `Decimal`
 * instances holding the same value are not structurally equal (they differ in
 * internal digit representation), and it is the value that matters here.
 */
function transactionSnapshot(transaction: Transaction): unknown {
  return {
    id: transaction.id,
    symbol: transaction.symbol,
    type: transaction.type,
    quantity: transaction.quantity.toFixed(),
    pricePerUnit: transaction.pricePerUnit.toFixed(),
    timestamp: transaction.timestamp.toISOString(),
  };
}

/**
 * A comparable view of a whole Portfolio, used to detect mutation of the input
 * state. Holdings are sorted by symbol because map iteration order is an
 * implementation detail; Transaction order is compared as-is, since history
 * ordering is observable behavior (Req 2.8).
 */
function snapshot(state: PortfolioState): unknown {
  return {
    holdings: [...state.holdings.values()]
      .map((holding: Holding) => ({
        symbol: holding.symbol,
        quantity: holding.quantity.toFixed(),
        currentPrice: holding.currentPrice.toFixed(),
      }))
      .sort((left, right) => left.symbol.localeCompare(right.symbol)),
    transactions: state.transactions.map(transactionSnapshot),
  };
}
