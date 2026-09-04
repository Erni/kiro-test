import { Decimal } from 'decimal.js';
import fc from 'fast-check';

import { listHoldings } from '../../src/domain/holdings';
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
 * Property 12: Selling to zero quantity removes the holding but retains its
 * transactions (Requirement 2.7).
 *
 * For any Holding with quantity Q and any prior Transactions recorded against
 * it, recording a Sell Transaction of exactly Q results in the symbol no longer
 * appearing in the Holdings list, while the Transaction history for that symbol
 * still contains every prior Transaction plus the new Sell Transaction.
 *
 * This is the counterpart to Property 7 (Req 1.7), where explicit removal takes
 * the Transactions with it. Here the position closes but the history must
 * outlive it, so the assertions deliberately mirror Property 7's and invert the
 * expectation about `transactionHistory`: a shared "delete the symbol and its
 * rows" shortcut between the two paths would fail exactly one of them.
 *
 * The Sell goes through the real boundary path — `validateTransactionInput`
 * followed by `applyTransaction` — because Req 2.7 is about what happens to a
 * *submitted* Transaction. The submitted quantity is the same decimal string the
 * Holding was seeded from, so "exactly Q" is exact rather than approximately
 * equal, and a value-comparison shortcut on the subtraction cannot hide behind
 * rounding.
 *
 * Values are generated as decimal *strings* and parsed with `Decimal`, never via
 * JavaScript numbers, so the generators cannot lose precision the assertions
 * then blame on the code.
 */

/** Inclusive upper bound for generated quantities and prices, as a bigint. */
const MAX_WHOLE = BigInt(MAX_VALUE);

/** Largest 8-decimal-place fraction, i.e. `.99999999`. */
const MAX_FRACTION = 10 ** MAX_DECIMAL_PLACES - 1;

/** Symbol alphabet from Req 1.11: uppercase letters and digits only. */
const SYMBOL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

/** Size of the symbol pool a scenario draws from. */
const MAX_SYMBOLS = 4;

/** How many Transactions a single scenario may seed across all symbols. */
const MAX_TRANSACTIONS = 8;

/**
 * Decimal strings in `[0, MAX_VALUE]` with up to 8 decimal places, biased
 * towards both ends of the range: small everyday values and the
 * 20-significant-digit extremes where a float-backed subtraction would fail to
 * land on exactly zero.
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
 * A seeded prior Transaction. The symbol is referenced by index into the
 * scenario's symbol pool, weighted towards index 0 (the symbol being sold to
 * zero) so runs regularly exercise the "any prior Transactions recorded against
 * it" case instead of scattering every Transaction across unrelated symbols.
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

/**
 * A Portfolio plus the closing Sell to submit against it.
 *
 * The target is `symbols[0]`, is always held, and the Sell's quantity is exactly
 * its quantity, so the Transaction is always expected to succeed and always
 * lands on zero (Req 2.7 rather than the insufficient-quantity case of Req 2.4).
 * The remaining symbols are held or not according to `held`: a symbol with
 * Transactions but no Holding is the state Req 2.7 itself produces, and it is
 * where an over-eager cleanup would do collateral damage.
 */
const scenarioArbitrary = fc
  .record({
    symbols: fc.uniqueArray(symbolArbitrary, { minLength: 2, maxLength: MAX_SYMBOLS }),
    values: fc.array(valuesArbitrary, { minLength: MAX_SYMBOLS, maxLength: MAX_SYMBOLS }),
    held: fc.array(fc.boolean(), { minLength: MAX_SYMBOLS, maxLength: MAX_SYMBOLS }),
    seeds: fc.array(seedTransactionArbitrary, { minLength: 0, maxLength: MAX_TRANSACTIONS }),
    sellPrice: decimalStrings('nonNegative'),
  })
  .map(({ symbols, values, held, seeds, sellPrice }) => {
    const pool = symbols as [string, string, ...string[]];
    const target = pool[0];
    const targetValues = values[0] as { quantity: string; currentPrice: string };

    const holdings = new Map<string, Holding>();
    pool.forEach((symbol, index) => {
      // The target is always held; the others are optional.
      if (index !== 0 && held[index] !== true) {
        return;
      }
      const value = values[index] as { quantity: string; currentPrice: string };
      holdings.set(symbol, {
        symbol,
        quantity: new Decimal(value.quantity),
        currentPrice: new Decimal(value.currentPrice),
      });
    });

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
      // Exactly Q, taken from the same string the Holding was built from.
      submission: {
        symbol: target,
        type: 'Sell' as const,
        quantity: targetValues.quantity,
        pricePerUnit: sellPrice,
      },
    };
  });

/** Timestamp the closing Sell is pinned to, so ordering is deterministic. */
const CLOSING_SELL_AT = new Date('2100-06-01T12:00:00.000Z');

describe('a Sell transaction that reduces a holding to exactly zero', () => {
  // Feature: crypto-portfolio-core, Property 12: Selling to zero quantity removes the holding but retains its transactions
  it('removes the holding while retaining every transaction for that symbol, including the closing sell', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ state, target, submission }) => {
        const before = snapshot(state);
        const priorHistory = transactionHistory(state, target).map(transactionSnapshot);

        const validated = validateTransactionInput(submission);
        // The generated Sell is inside the Req 2.6 ranges, so a rejection here
        // would itself be a defect.
        expect(validated.ok).toBe(true);
        if (!validated.ok) {
          return;
        }

        const applied = applyTransaction(state, validated.value, {
          newId: () => 'closing-sell',
          now: () => CLOSING_SELL_AT,
        });
        // The Sell is exactly the held quantity, so it is never insufficient
        // (Req 2.4 does not apply).
        expect(applied.ok).toBe(true);
        if (!applied.ok) {
          return;
        }

        const next = applied.value.state;

        // Req 2.7, first half: the Holding is gone from the Portfolio, as seen
        // through the listing the user actually reads (Req 1.8).
        expect(next.holdings.has(target)).toBe(false);
        expect(listHoldings(next).map((holding) => holding.symbol)).not.toContain(target);

        // Req 2.7, second half: the history survives — every prior Transaction,
        // in order, plus the closing Sell appended.
        const history = transactionHistory(next, target);
        expect(history.length).toBeGreaterThan(0);
        expect(history.map(transactionSnapshot)).toEqual([
          ...priorHistory,
          transactionSnapshot(applied.value.transaction),
        ]);

        // The closing Sell itself was recorded with the submitted values.
        expect(applied.value.transaction.type).toBe('Sell');
        expect(applied.value.transaction.symbol).toBe(target);
        expect(applied.value.transaction.quantity.toFixed()).toBe(
          new Decimal(submission.quantity).toFixed(),
        );
        expect(applied.value.transaction.pricePerUnit.toFixed()).toBe(
          new Decimal(submission.pricePerUnit).toFixed(),
        );

        // Nothing else was disturbed: every other Holding keeps its exact
        // quantity and Current_Price...
        expect(next.holdings.size).toBe(state.holdings.size - 1);
        for (const existing of state.holdings.values()) {
          if (existing.symbol === target) {
            continue;
          }
          const carried = next.holdings.get(existing.symbol);
          expect(carried).toBeDefined();
          expect(carried?.quantity.toFixed()).toBe(existing.quantity.toFixed());
          expect(carried?.currentPrice.toFixed()).toBe(existing.currentPrice.toFixed());
        }

        // ...and every other symbol's history survives in full, in order.
        const otherSymbols = new Set(
          state.transactions
            .map((transaction) => transaction.symbol)
            .filter((symbol) => symbol !== target),
        );
        for (const symbol of otherSymbols) {
          expect(transactionHistory(next, symbol).map(transactionSnapshot)).toEqual(
            transactionHistory(state, symbol).map(transactionSnapshot),
          );
        }

        // The transition is pure: the state handed in is the rollback value the
        // service layer keeps holding (Req 5.4), so it must be untouched.
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
