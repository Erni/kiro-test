import { Decimal } from 'decimal.js';
import fc from 'fast-check';

import { NotFoundError } from '../../src/domain/errors';
import { listHoldings, removeHolding, updateHolding } from '../../src/domain/holdings';
import { updatePrice } from '../../src/domain/pricing';
import { transactionHistory } from '../../src/domain/transactions';
import { MAX_DECIMAL_PLACES, MAX_VALUE } from '../../src/domain/types';
import type {
  Holding,
  PortfolioState,
  Transaction,
  TransactionType,
} from '../../src/domain/types';
import { validateHoldingUpdateInput, validatePriceUpdateInput } from '../../src/domain/validation';

/**
 * Property 6: Operations on a nonexistent holding are always rejected without
 * side effects (Requirements 1.9, 1.10, 4.3).
 *
 * For any symbol with no existing Holding in the Portfolio, attempting to update
 * it, remove it, or update its price is rejected with a "does not exist" error,
 * and the Portfolio is left unchanged.
 *
 * All three operations named by the property are exercised against the same
 * missing symbol in every run, because the three requirements are one rule seen
 * from three entry points and a regression is just as likely to appear in one of
 * them as in all three.
 *
 * The payloads are always *valid* — they go through `validateHoldingUpdateInput`
 * and `validatePriceUpdateInput` first, exactly as the service layer does, and a
 * rejection there would fail the run. That is what makes the resulting
 * `NotFoundError` attributable to the missing Holding rather than to the input:
 * an implementation that rejected everything would not satisfy this property.
 *
 * "The Portfolio is left unchanged" is checked as a full before/after snapshot of
 * both Holdings and Transactions, not just the absence of the target symbol. Two
 * plausible defects hide in the remainder: a transition that clears history while
 * bailing out, and one that reports not-found only after having already mutated
 * the map it was handed. The domain transitions are pure, so the state passed in
 * is also the rollback value the service keeps holding when persistence fails
 * (Req 5.4) — it must come back byte-for-byte identical.
 *
 * The missing symbol deliberately carries Transactions in some runs. A symbol
 * with history but no current Holding is reachable (Req 2.7 removes the Holding
 * on a Sell to zero while retaining its Transactions), and it is the state where
 * a rejected `removeHolding` could still do collateral damage by filtering the
 * transactions list before checking whether the Holding exists at all.
 *
 * Values are generated as decimal *strings* and parsed with `Decimal`, never
 * through a JavaScript number, so the generators cannot lose the precision the
 * comparisons would then blame on the code.
 */

/** Inclusive upper bound for generated quantities and prices, as a bigint. */
const MAX_WHOLE = BigInt(MAX_VALUE);

/** Largest 8-decimal-place fraction, i.e. `.99999999`. */
const MAX_FRACTION = 10 ** MAX_DECIMAL_PLACES - 1;

/** Symbol alphabet from Req 1.11: uppercase letters and digits only. */
const SYMBOL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

/** Size of the symbol pool a scenario draws from, missing target included. */
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
 * A seeded Transaction. Its symbol is referenced by index into the scenario's
 * symbol pool, weighted towards index 0 — the missing target — so runs regularly
 * produce the history-without-a-Holding case rather than spreading every
 * Transaction across symbols that are still held.
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
 * A populated Portfolio, a symbol guaranteed *not* to be held, and valid
 * payloads for each of the three operations.
 *
 * The symbols are drawn as one unique set and then split: `symbols[0]` is the
 * target and is never inserted into the holdings map, while the rest are held so
 * the rejection is checked against a populated Portfolio rather than an empty
 * one — a not-found that only holds when there is nothing to find would prove
 * very little.
 */
const scenarioArbitrary = fc
  .record({
    symbols: fc.uniqueArray(symbolArbitrary, { minLength: 2, maxLength: MAX_SYMBOLS }),
    values: fc.array(valuesArbitrary, { minLength: MAX_SYMBOLS, maxLength: MAX_SYMBOLS }),
    seeds: fc.array(seedTransactionArbitrary, { minLength: 0, maxLength: MAX_TRANSACTIONS }),
    update: valuesArbitrary,
    newPrice: decimalStrings('nonNegative'),
  })
  .map(({ symbols, values, seeds, update, newPrice }) => {
    const pool = symbols as [string, string, ...string[]];
    const missing = pool[0];

    const holdings = new Map<string, Holding>();
    pool.forEach((symbol, index) => {
      // Index 0 is the target: it is never held, which is the whole point.
      if (index === 0) {
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
      missing,
      update,
      priceUpdate: { currentPrice: newPrice },
    };
  });

describe('operations targeting a symbol with no Holding', () => {
  // Feature: crypto-portfolio-core, Property 6: Operations on a nonexistent holding are always rejected without side effects
  it('rejects update, removal, and price update with a not-found error and leaves the Portfolio unchanged', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ state, missing, update, priceUpdate }) => {
        // The target is absent by construction; if it were present the run would
        // be testing the success paths of Req 1.5/1.7/4.1 instead.
        expect(state.holdings.has(missing)).toBe(false);

        const before = snapshot(state);
        const historyBefore = transactionHistory(state, missing).map(transactionSnapshot);

        // Req 1.9: updating a Holding that does not exist.
        const validatedUpdate = validateHoldingUpdateInput(update);
        expect(validatedUpdate.ok).toBe(true);
        if (!validatedUpdate.ok) {
          return;
        }
        expectNotFound(updateHolding(state, missing, validatedUpdate.value), missing);

        // Req 1.10: removing a Holding that does not exist.
        expectNotFound(removeHolding(state, missing), missing);

        // Req 4.3: updating the Current_Price of a Holding that does not exist.
        const validatedPrice = validatePriceUpdateInput(priceUpdate);
        expect(validatedPrice.ok).toBe(true);
        if (!validatedPrice.ok) {
          return;
        }
        expectNotFound(updatePrice(state, missing, validatedPrice.value), missing);

        // None of the three rejections touched the Portfolio: same Holdings with
        // the same quantities and prices, same Transactions in the same order.
        expect(snapshot(state)).toEqual(before);

        // ...including as seen through the readers the user actually calls, so
        // "unchanged" covers observable behavior and not just the raw state.
        expect(listHoldings(state).map((holding) => holding.symbol)).not.toContain(missing);
        expect(listHoldings(state)).toHaveLength(state.holdings.size);

        // The missing symbol's own history is untouched too — a rejected removal
        // must not quietly discard the Transactions Req 2.7 kept alive.
        expect(transactionHistory(state, missing).map(transactionSnapshot)).toEqual(historyBefore);
      }),
      { numRuns: 100 },
    );
  });

  // The rejections above are only meaningful if the very same payloads succeed
  // against a symbol that *is* held: that pins the cause on the missing Holding
  // rather than on the input or on a blanket refusal.
  it('accepts the same payloads for a held symbol, confirming the rejection came from the missing Holding', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ state, update, priceUpdate }) => {
        const held = listHoldings(state)[0] as Holding;

        const validatedUpdate = validateHoldingUpdateInput(update);
        expect(validatedUpdate.ok).toBe(true);
        if (!validatedUpdate.ok) {
          return;
        }
        expect(updateHolding(state, held.symbol, validatedUpdate.value).ok).toBe(true);

        expect(removeHolding(state, held.symbol).ok).toBe(true);

        const validatedPrice = validatePriceUpdateInput(priceUpdate);
        expect(validatedPrice.ok).toBe(true);
        if (!validatedPrice.ok) {
          return;
        }
        expect(updatePrice(state, held.symbol, validatedPrice.value).ok).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Asserts a transition rejected with the "does not exist" error for `symbol`,
 * and that it produced no replacement state to swap in.
 */
function expectNotFound(
  result: { ok: true; value: PortfolioState } | { ok: false; error: NotFoundError },
  symbol: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    return;
  }
  expect(result.error).toBeInstanceOf(NotFoundError);
  expect(result.error.kind).toBe('NotFoundError');
  expect(result.error.symbol).toBe(symbol);
  // The message identifies the symbol, as the 404 response body relies on.
  expect(result.error.message).toContain(symbol);
  expect(result.error.message).toContain('does not exist');
}

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
 * A comparable view of a whole Portfolio, used to detect any mutation of the
 * input state. Holdings are sorted by symbol because map iteration order is an
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
