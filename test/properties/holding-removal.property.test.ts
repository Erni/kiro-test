import { Decimal } from 'decimal.js';
import fc from 'fast-check';

import { listHoldings, removeHolding } from '../../src/domain/holdings';
import { transactionHistory } from '../../src/domain/transactions';
import { MAX_DECIMAL_PLACES, MAX_VALUE } from '../../src/domain/types';
import type {
  Holding,
  PortfolioState,
  Transaction,
  TransactionType,
} from '../../src/domain/types';

/**
 * Property 7: Manual removal deletes the holding and all its transactions
 * (Requirement 1.7).
 *
 * For any Holding with any number of associated Transactions, explicitly
 * removing that Holding results in the symbol no longer appearing in the
 * Holdings list, and the Transaction history for that symbol becoming empty.
 *
 * The two halves of Req 1.7 are checked through the readers the user actually
 * calls — `listHoldings` (Req 1.8) and `transactionHistory` (Req 2.8) — rather
 * than by inspecting the state's internals, because "deleted from the Portfolio"
 * is a statement about what is observable afterwards.
 *
 * Deletion is only half the contract: a `removeHolding` that dropped every
 * Holding and every Transaction would satisfy the assertions above on its own.
 * So each run also pins the untouched remainder — all other Holdings with their
 * exact quantity and Current_Price, and every other symbol's full Transaction
 * history in order — and asserts the input state is unchanged, since the domain
 * transitions are pure and the pre-removal state is what the service layer rolls
 * back to when persistence fails (Req 5.4).
 *
 * Transactions are seeded for symbols with no current Holding as well. That is a
 * reachable state (Req 2.7 removes a Holding while keeping its history), and it
 * is where an over-eager filter would do collateral damage.
 *
 * Values are generated as decimal *strings* and parsed with `Decimal`, never via
 * JavaScript numbers, so the generators cannot lose precision the comparisons
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
 * A seeded Transaction. The symbol is referenced by index into the scenario's
 * symbol pool, weighted towards index 0 (the removal target) so that runs
 * regularly exercise the "several associated Transactions" case rather than
 * spreading every Transaction across unrelated symbols.
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
 * A Portfolio plus the symbol to remove from it.
 *
 * The target is `symbols[0]` and is always held, so the removal is always
 * expected to succeed (Req 1.7 rather than the not-found case of Req 1.10). The
 * remaining symbols are held or not according to `held`, which is what produces
 * the history-without-a-Holding case worth protecting.
 */
const scenarioArbitrary = fc
  .record({
    symbols: fc.uniqueArray(symbolArbitrary, { minLength: 2, maxLength: MAX_SYMBOLS }),
    values: fc.array(valuesArbitrary, { minLength: MAX_SYMBOLS, maxLength: MAX_SYMBOLS }),
    held: fc.array(fc.boolean(), { minLength: MAX_SYMBOLS, maxLength: MAX_SYMBOLS }),
    seeds: fc.array(seedTransactionArbitrary, { minLength: 0, maxLength: MAX_TRANSACTIONS }),
  })
  .map(({ symbols, values, held, seeds }) => {
    const pool = symbols as [string, string, ...string[]];
    const target = pool[0];

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
    };
  });

describe('removeHolding on an existing holding', () => {
  // Feature: crypto-portfolio-core, Property 7: Manual removal deletes the holding and all its transactions
  it('deletes the holding and every transaction recorded for it, leaving other symbols intact', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ state, target }) => {
        const before = snapshot(state);

        const removed = removeHolding(state, target);
        // The target is held by construction, so a rejection here is a defect.
        expect(removed.ok).toBe(true);
        if (!removed.ok) {
          return;
        }

        const next = removed.value;

        // Req 1.7, first half: the symbol no longer appears among the Holdings.
        expect(listHoldings(next).map((holding) => holding.symbol)).not.toContain(target);
        expect(next.holdings.has(target)).toBe(false);

        // Req 1.7, second half: its Transaction history is empty.
        expect(transactionHistory(next, target)).toEqual([]);
        expect(next.transactions.some((transaction) => transaction.symbol === target)).toBe(false);

        // Nothing else was removed: every other Holding survives with exactly
        // its previous quantity and Current_Price.
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

        // Every other symbol's history survives in full, in order — including
        // symbols that have Transactions but no current Holding.
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

        // The transitions are pure: the state handed in is the rollback value
        // the service layer keeps holding (Req 5.4), so it must be untouched.
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
