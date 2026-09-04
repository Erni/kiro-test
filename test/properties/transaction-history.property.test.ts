import fc from 'fast-check';

import { applyTransaction, transactionHistory } from '../../src/domain/transactions';
import { MAX_DECIMAL_PLACES } from '../../src/domain/types';
import type { PortfolioState, Transaction, TransactionType } from '../../src/domain/types';
import { validateTransactionInput } from '../../src/domain/validation';

/**
 * Property 13: Transaction history is complete and ordered by timestamp
 * (Requirement 2.8).
 *
 * For any sequence of valid Buy/Sell Transactions recorded for a symbol
 * (including sequences that reduce a Holding to zero and later recreate it via a
 * new Buy), requesting the Transaction history for that symbol returns exactly
 * the Transactions recorded for it, ordered by timestamp from earliest to
 * latest.
 *
 * The scenario builds state the way production does: every Transaction goes
 * through `validateTransactionInput` and then `applyTransaction`, with `newId`
 * and `now` pinned so each recorded Transaction has a known identity and a
 * timestamp chosen by the generator rather than by the clock. That is what makes
 * the ordering claim testable — recording order and timestamp order are
 * deliberately decorrelated, so a `transactionHistory` that simply returned the
 * append-only list unsorted would be caught.
 *
 * Timestamps are drawn mostly from a small pool of fixed instants, so ties are
 * common. Ties are where an unstable or sign-confused comparator shows up, and
 * `transactions.ts` documents the tie-break: Transactions sharing a timestamp
 * keep their recording order.
 *
 * Completeness is checked against an expectation accumulated from the values
 * `applyTransaction` returned, not by re-filtering `state.transactions` with the
 * same predicate the implementation uses — otherwise the assertion would restate
 * the implementation instead of the requirement. Three things must hold: nothing
 * recorded for the symbol is missing, nothing appears twice, and nothing
 * belonging to another symbol leaks in.
 *
 * The scenario also forces the two boundary shapes Req 2.8 calls out explicitly:
 * a symbol whose Holding was closed by a zero-quantity Sell (history must
 * outlive the position) and a symbol that was never traded (empty history).
 *
 * Values are generated as decimal *strings* and parsed by the validator, never
 * via JavaScript numbers, so the generators cannot lose precision the assertions
 * then blame on the code.
 */

/**
 * Upper bound for a single generated quantity, as a bigint.
 *
 * Well below `MAX_VALUE` on purpose: a scenario may Buy up to
 * `MAX_OPERATIONS + 1` times for the same symbol, and the accumulated quantity
 * has to stay inside the Req 2.6 range so the closing Sell of the full position
 * is itself a valid submission. Extreme-magnitude arithmetic is Property 14's
 * and Property 9/10's concern; this property is about which Transactions come
 * back and in what order.
 */
const MAX_WHOLE = 1_000_000_000n;

/** Largest 8-decimal-place fraction, i.e. `.99999999`. */
const MAX_FRACTION = 10 ** MAX_DECIMAL_PLACES - 1;

/** Symbol alphabet from Req 1.11: uppercase letters and digits only. */
const SYMBOL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

/** Number of traded symbols in a scenario, plus one never-traded symbol. */
const MAX_SYMBOLS = 3;

/** How many Transactions a single scenario may attempt across all symbols. */
const MAX_OPERATIONS = 10;

/**
 * Instants the generator reuses, so several Transactions share a timestamp
 * within one scenario. Deliberately not in ascending textual order relative to
 * each other's use: which instant an operation gets is independent of when the
 * operation runs.
 */
const TIE_INSTANTS: readonly Date[] = [
  new Date('2021-03-04T09:15:00.000Z'),
  new Date('2020-01-01T00:00:00.000Z'),
  new Date('2023-11-30T23:59:59.999Z'),
];

/**
 * Decimal strings in `(0, MAX_WHOLE]` with up to 8 decimal places, biased
 * towards small everyday values so repeated Buys and Sells for one symbol are
 * frequent enough to produce interesting histories.
 */
const quantityStrings: fc.Arbitrary<string> = fc
  .tuple(
    fc.oneof(fc.bigInt({ min: 0n, max: 100n }), fc.bigInt({ min: 0n, max: MAX_WHOLE })),
    fc.oneof(fc.integer({ min: 0, max: MAX_FRACTION }), fc.constantFrom(0, 1, MAX_FRACTION)),
  )
  .map(([units, hundredMillionths]) => {
    if (units === 0n && hundredMillionths === 0) {
      return '0.00000001';
    }
    if (hundredMillionths === 0) {
      return units.toString();
    }
    return `${units}.${String(hundredMillionths).padStart(MAX_DECIMAL_PLACES, '0')}`;
  });

/** Prices are only carried along here, so a plain non-negative range suffices. */
const priceStrings: fc.Arbitrary<string> = fc
  .tuple(fc.bigInt({ min: 0n, max: MAX_WHOLE }), fc.integer({ min: 0, max: MAX_FRACTION }))
  .map(
    ([units, hundredMillionths]) =>
      `${units}.${String(hundredMillionths).padStart(MAX_DECIMAL_PLACES, '0')}`,
  );

/** Symbols matching `[A-Z0-9]{1,10}` (Req 1.11). */
const symbolArbitrary: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...SYMBOL_CHARS), { minLength: 1, maxLength: 10 })
  .map((characters) => characters.join(''));

/**
 * Timestamps: mostly repeats of {@link TIE_INSTANTS}, occasionally an arbitrary
 * instant, and never correlated with recording order.
 */
const timestampArbitrary: fc.Arbitrary<Date> = fc.oneof(
  fc.constantFrom(...TIE_INSTANTS),
  fc.constantFrom(...TIE_INSTANTS),
  fc.date({
    min: new Date('2000-01-01T00:00:00.000Z'),
    max: new Date('2099-12-31T23:59:59.999Z'),
    noInvalidDate: true,
  }),
);

/**
 * One attempted Transaction.
 *
 * `kind` is `'SellAll'` for a Sell of the symbol's entire current quantity: that
 * is how a scenario reaches zero and drops the Holding, after which a later Buy
 * for the same symbol recreates it — the sequence Property 13 names explicitly.
 * Plain `'Sell'` operations use a generated quantity and are simply rejected
 * when the position is too small (Req 2.4), which is a useful control: a
 * rejected Transaction must not appear in any history.
 */
const operationArbitrary = fc.record({
  at: fc.nat({ max: MAX_SYMBOLS - 1 }),
  kind: fc.constantFrom<'Buy' | 'Sell' | 'SellAll'>('Buy', 'Buy', 'Sell', 'SellAll'),
  quantity: quantityStrings,
  pricePerUnit: priceStrings,
  timestamp: timestampArbitrary,
});

/** Operations plus the symbol pool they address. */
const scenarioArbitrary = fc.record({
  // MAX_SYMBOLS traded symbols plus one that is never traded, so the empty
  // history case is always exercised.
  symbols: fc.uniqueArray(symbolArbitrary, {
    minLength: MAX_SYMBOLS + 1,
    maxLength: MAX_SYMBOLS + 1,
  }),
  operations: fc.array(operationArbitrary, { minLength: 1, maxLength: MAX_OPERATIONS }),
  closingTimestamp: timestampArbitrary,
  closingPrice: priceStrings,
});

interface Operation {
  readonly at: number;
  readonly kind: 'Buy' | 'Sell' | 'SellAll';
  readonly quantity: string;
  readonly pricePerUnit: string;
  readonly timestamp: Date;
}

/** The state a scenario produced, plus the Transactions it actually recorded. */
interface Recording {
  readonly state: PortfolioState;
  /** Every Transaction `applyTransaction` reported as recorded, in that order. */
  readonly recorded: readonly Transaction[];
}

/**
 * Replays the operations against an empty Portfolio through the real boundary
 * path, collecting the Transactions that were actually recorded.
 *
 * Rejected Sells (Req 2.4) contribute nothing: the state carries on unchanged
 * and the Transaction is never added to `recorded`, so the expectation stays in
 * step with reality.
 */
function record(symbols: readonly string[], operations: readonly Operation[]): Recording {
  let state: PortfolioState = { holdings: new Map(), transactions: [] };
  const recorded: Transaction[] = [];

  operations.forEach((operation, index) => {
    const symbol = symbols[operation.at] as string;
    const held = state.holdings.get(symbol);

    let quantity = operation.quantity;
    if (operation.kind === 'SellAll') {
      if (held === undefined) {
        // Nothing to close; a Sell here would only repeat the rejection case.
        return;
      }
      quantity = held.quantity.toFixed();
    }

    const type: TransactionType = operation.kind === 'Buy' ? 'Buy' : 'Sell';
    const submitted = { symbol, type, quantity, pricePerUnit: operation.pricePerUnit };

    const validated = validateTransactionInput(submitted);
    // Generated values sit inside the Req 2.6 ranges, and a SellAll quantity is
    // a sum of such values kept below MAX_VALUE by construction, so a rejection
    // here would itself be a defect.
    expect(validated.ok).toBe(true);
    if (!validated.ok) {
      return;
    }

    const applied = applyTransaction(state, validated.value, {
      newId: () => `tx-${index}`,
      now: () => operation.timestamp,
    });

    if (!applied.ok) {
      // Only an insufficient-quantity Sell may fail, and it leaves no trace.
      expect(operation.kind).toBe('Sell');
      return;
    }

    state = applied.value.state;
    recorded.push(applied.value.transaction);
  });

  return { state, recorded };
}

describe('the transaction history for a symbol', () => {
  // Feature: crypto-portfolio-core, Property 13: Transaction history is complete and ordered by timestamp
  it('returns exactly that symbol\u2019s transactions, earliest timestamp first', () => {
    fc.assert(
      fc.property(
        scenarioArbitrary,
        ({ symbols, operations, closingTimestamp, closingPrice }) => {
          const traded = symbols.slice(0, MAX_SYMBOLS);
          const untraded = symbols[MAX_SYMBOLS] as string;
          const target = traded[0] as string;

          const replayed = record(symbols, operations as readonly Operation[]);
          let state = replayed.state;
          const recorded = [...replayed.recorded];

          // Force the Req 2.8 case that matters most: a symbol whose Holding was
          // removed by a zero-quantity Sell must still have a history. The
          // closing Sell is timestamped by the generator like any other, so it
          // is not necessarily the latest entry.
          const open = state.holdings.get(target);
          if (open !== undefined) {
            const closing = validateTransactionInput({
              symbol: target,
              type: 'Sell',
              quantity: open.quantity.toFixed(),
              pricePerUnit: closingPrice,
            });
            expect(closing.ok).toBe(true);
            if (closing.ok) {
              const applied = applyTransaction(state, closing.value, {
                newId: () => 'closing-sell',
                now: () => closingTimestamp,
              });
              expect(applied.ok).toBe(true);
              if (applied.ok) {
                state = applied.value.state;
                recorded.push(applied.value.transaction);
              }
            }
          }

          // The target now has no Holding, yet may well have a history.
          expect(state.holdings.has(target)).toBe(false);

          let covered = 0;
          for (const symbol of traded) {
            const history = transactionHistory(state, symbol);
            const expected = expectedHistory(recorded, symbol);

            // Complete and exact: the same Transactions, in timestamp order,
            // with ties resolved by recording order.
            expect(history.map(view)).toEqual(expected.map(view));

            // Nothing missing and nothing extra, stated over identities so a
            // duplicated or dropped entry cannot hide behind equal values.
            expect(history.map((transaction) => transaction.id).sort()).toEqual(
              expected.map((transaction) => transaction.id).sort(),
            );

            // Nothing belonging to another symbol leaked in.
            for (const transaction of history) {
              expect(transaction.symbol).toBe(symbol);
            }

            // Ordered earliest to latest.
            for (let index = 1; index < history.length; index += 1) {
              const previous = history[index - 1] as Transaction;
              const current = history[index] as Transaction;
              expect(previous.timestamp.getTime()).toBeLessThanOrEqual(
                current.timestamp.getTime(),
              );
            }

            covered += history.length;
          }

          // Every recorded Transaction is accounted for by exactly one symbol's
          // history: no Transaction is silently unreachable.
          expect(covered).toBe(recorded.length);

          // A symbol that was never traded has an empty history, not an error.
          expect(transactionHistory(state, untraded)).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
  });
});

/**
 * The history the requirement asks for, derived from what `applyTransaction`
 * reported rather than from the stored list: earliest timestamp first, ties in
 * recording order.
 */
function expectedHistory(recorded: readonly Transaction[], symbol: string): Transaction[] {
  return recorded
    .map((transaction, order) => ({ transaction, order }))
    .filter((entry) => entry.transaction.symbol === symbol)
    .sort(
      (left, right) =>
        left.transaction.timestamp.getTime() - right.transaction.timestamp.getTime() ||
        left.order - right.order,
    )
    .map((entry) => entry.transaction);
}

/**
 * A comparable view of a Transaction.
 *
 * `Decimal` and `Date` are reduced to their exact textual forms: two `Decimal`
 * instances holding the same value are not structurally equal (they differ in
 * internal digit representation), and it is the value that matters here.
 */
function view(transaction: Transaction): unknown {
  return {
    id: transaction.id,
    symbol: transaction.symbol,
    type: transaction.type,
    quantity: transaction.quantity.toFixed(),
    pricePerUnit: transaction.pricePerUnit.toFixed(),
    timestamp: transaction.timestamp.toISOString(),
  };
}
