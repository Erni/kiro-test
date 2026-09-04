import { Decimal } from 'decimal.js';
import fc from 'fast-check';

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
 * Property 9: Buy transactions increase quantity, creating the holding if needed
 * (Requirements 2.1, 2.3).
 *
 * For any Portfolio, symbol, and valid Buy Transaction (quantity `> 0`, price
 * `>= 0`), recording the Transaction results in a Holding for that symbol whose
 * quantity equals the prior quantity (or zero, if no Holding existed) plus the
 * Transaction's quantity; if no Holding existed, its Current_Price is set to the
 * Transaction's price per unit.
 *
 * Both branches are generated: the target symbol is held about half the time, so
 * every run exercises either the accumulating path (Req 2.1) or the
 * holding-creation path (Req 2.3). The submission goes through the real boundary
 * path — `validateTransactionInput` followed by `applyTransaction` — because
 * Req 2.1/2.3 describe what happens to a *submitted* Transaction, and parsing is
 * exactly where precision can be lost.
 *
 * The expected quantity is computed with `BigInt` arithmetic in units of
 * `10^-8`, not with `Decimal.plus`, so the oracle does not simply re-run the
 * implementation's own addition. Every generated value carries at most 8 decimal
 * places, which makes that scaling exact. Comparisons are on `toFixed()` output
 * rather than structural equality, since two `Decimal` instances holding the same
 * value can differ in internal digit representation.
 *
 * A Buy is a position change, not a price quote: when the Holding already
 * exists, its Current_Price must survive untouched (revisions go through
 * `updatePrice`, Req 4.1). Transaction quantities are also deliberately
 * unbounded — Req 2.6 constrains only `> 0` — so the generator reaches past the
 * Holding data model's 1,000,000,000,000 ceiling, which is where a rounded sum
 * on the write path would surface.
 *
 * The Portfolio is seeded with unrelated Holdings and with Transactions for
 * symbols that have no current Holding (a reachable state per Req 2.7), so a
 * transition that clobbered the remainder could not pass. The input state is
 * snapshotted and re-checked because the transitions are pure: the pre-attempt
 * state is what the service layer rolls back to when persistence fails (Req 5.4).
 */

/** Inclusive upper bound for generated Holding quantities and prices, as a bigint. */
const MAX_WHOLE = BigInt(MAX_VALUE);

/** Largest 8-decimal-place fraction, i.e. `.99999999`. */
const MAX_FRACTION = 10 ** MAX_DECIMAL_PLACES - 1;

/** Scaling factor between a decimal string and its `10^-8` integer units. */
const SCALE = 10n ** BigInt(MAX_DECIMAL_PLACES);

/** Symbol alphabet from Req 1.11: uppercase letters and digits only. */
const SYMBOL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

/** Size of the symbol pool a scenario draws from. */
const MAX_SYMBOLS = 4;

/** How many Transactions a single scenario may seed across all symbols. */
const MAX_TRANSACTIONS = 6;

/**
 * Decimal strings with up to 8 decimal places, biased towards both ends of the
 * range: small everyday values and the 20-significant-digit extremes a
 * float-backed path would silently mangle.
 *
 * `positive` guarantees `> 0`, as Holding and Transaction quantities require.
 * `unbounded` additionally reaches past `MAX_VALUE`, which Transaction
 * quantities are allowed to do (Req 2.6 constrains only the sign).
 */
function decimalStrings(bound: 'positive' | 'nonNegative' | 'unbounded'): fc.Arbitrary<string> {
  const whole = fc.oneof(
    fc.bigInt({ min: 0n, max: 1000n }),
    fc.bigInt({ min: 0n, max: MAX_WHOLE }),
    fc.constantFrom(0n, 1n, MAX_WHOLE),
    ...(bound === 'unbounded'
      ? [fc.bigInt({ min: MAX_WHOLE, max: MAX_WHOLE * 1000n }), fc.constant(MAX_WHOLE * 1000n)]
      : []),
  );
  const fraction = fc.oneof(
    fc.integer({ min: 0, max: MAX_FRACTION }),
    fc.constantFrom(0, 1, MAX_FRACTION),
  );

  return fc.tuple(whole, fraction).map(([units, hundredMillionths]) => {
    // A bounded value at the upper bound would be pushed over MAX_VALUE by any
    // fraction; an unbounded one has no such ceiling to respect.
    const digits = units === MAX_WHOLE && bound !== 'unbounded' ? 0 : hundredMillionths;
    if (units === 0n && digits === 0) {
      return bound === 'nonNegative' ? '0' : '0.00000001';
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
 * A seeded Transaction, its symbol referenced by index into the scenario's
 * symbol pool. These only ever form the history the Buy is recorded against;
 * they are not replayed through `applyTransaction`.
 */
const seedTransactionArbitrary = fc.record({
  at: fc.nat({ max: MAX_SYMBOLS - 1 }),
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
 * A Portfolio plus the Buy Transaction to record against it.
 *
 * The target symbol is `symbols[0]`; `targetHeld` decides whether it already has
 * a Holding, which selects between Req 2.1's accumulate branch and Req 2.3's
 * create branch. The other symbols are held or not at random, so unrelated
 * Holdings and orphaned histories are both present.
 */
const scenarioArbitrary = fc
  .record({
    symbols: fc.uniqueArray(symbolArbitrary, { minLength: 2, maxLength: MAX_SYMBOLS }),
    values: fc.array(valuesArbitrary, { minLength: MAX_SYMBOLS, maxLength: MAX_SYMBOLS }),
    held: fc.array(fc.boolean(), { minLength: MAX_SYMBOLS, maxLength: MAX_SYMBOLS }),
    targetHeld: fc.boolean(),
    seeds: fc.array(seedTransactionArbitrary, { minLength: 0, maxLength: MAX_TRANSACTIONS }),
    submission: fc.record({
      quantity: decimalStrings('unbounded'),
      pricePerUnit: decimalStrings('nonNegative'),
    }),
  })
  .map(({ symbols, values, held, targetHeld, seeds, submission }) => {
    const pool = symbols as [string, string, ...string[]];
    const target = pool[0];

    const holdings = new Map<string, Holding>();
    pool.forEach((symbol, index) => {
      const include = index === 0 ? targetHeld : held[index] === true;
      if (!include) {
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
      input: {
        symbol: target,
        type: 'Buy' as const,
        quantity: submission.quantity,
        pricePerUnit: submission.pricePerUnit,
      },
    };
  });

describe('applyTransaction with a valid Buy transaction', () => {
  // Feature: crypto-portfolio-core, Property 9: Buy transactions increase quantity, creating the holding if needed
  it('increases the holding quantity by the transaction quantity, creating the holding at the transaction price when none exists', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ state, input }) => {
        const before = snapshot(state);
        const prior = state.holdings.get(input.symbol);

        const validated = validateTransactionInput(input);
        // Every generated submission satisfies Req 2.6, so a rejection here
        // would itself be a defect.
        expect(validated.ok).toBe(true);
        if (!validated.ok) {
          return;
        }

        const applied = applyTransaction(state, validated.value);
        // A Buy has no state-dependent failure mode; only a Sell can be refused.
        expect(applied.ok).toBe(true);
        if (!applied.ok) {
          return;
        }

        const { state: next, transaction } = applied.value;
        const stored = next.holdings.get(input.symbol);
        expect(stored).toBeDefined();
        expect(stored?.symbol).toBe(input.symbol);

        // Req 2.1 / 2.3: quantity is the prior quantity, or zero when there was
        // no Holding, plus the Transaction's quantity — exactly.
        const expectedQuantity = fromScaled(
          (prior === undefined ? 0n : toScaled(prior.quantity.toFixed())) +
            toScaled(input.quantity),
        );
        expect(stored?.quantity.toFixed()).toBe(new Decimal(expectedQuantity).toFixed());

        if (prior === undefined) {
          // Req 2.3: a created Holding takes the Transaction's price per unit.
          expect(stored?.currentPrice.toFixed()).toBe(new Decimal(input.pricePerUnit).toFixed());
        } else {
          // A Buy is a position change, not a price quote (Req 4.1 owns price).
          expect(stored?.currentPrice.toFixed()).toBe(prior.currentPrice.toFixed());
        }

        // The Transaction is recorded as submitted, with a generated id, and
        // appended to the append-only history (Req 2.8).
        expect(typeof transaction.id).toBe('string');
        expect(transaction.id.length).toBeGreaterThan(0);
        expect(state.transactions.map((seeded) => seeded.id)).not.toContain(transaction.id);
        expect(transaction.symbol).toBe(input.symbol);
        expect(transaction.type).toBe('Buy');
        expect(transaction.quantity.toFixed()).toBe(new Decimal(input.quantity).toFixed());
        expect(transaction.pricePerUnit.toFixed()).toBe(new Decimal(input.pricePerUnit).toFixed());
        expect(next.transactions.map(transactionSnapshot)).toEqual([
          ...state.transactions.map(transactionSnapshot),
          transactionSnapshot(transaction),
        ]);
        expect(transactionHistory(next, input.symbol).map((recorded) => recorded.id)).toContain(
          transaction.id,
        );

        // Nothing else moved: every other Holding keeps its exact quantity and
        // Current_Price, and no Holding appeared or vanished.
        expect(next.holdings.size).toBe(state.holdings.size + (prior === undefined ? 1 : 0));
        for (const existing of state.holdings.values()) {
          if (existing.symbol === input.symbol) {
            continue;
          }
          const carried = next.holdings.get(existing.symbol);
          expect(carried).toBeDefined();
          expect(carried?.quantity.toFixed()).toBe(existing.quantity.toFixed());
          expect(carried?.currentPrice.toFixed()).toBe(existing.currentPrice.toFixed());
        }

        // The input state is the rollback value the service layer keeps holding
        // (Req 5.4), so the transition must not have touched it.
        expect(snapshot(state)).toEqual(before);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Converts a non-negative plain decimal string with at most 8 decimal places
 * into exact integer units of `10^-8`, so sums can be checked with `BigInt`
 * arithmetic instead of the library under test.
 */
function toScaled(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole as string) * SCALE + BigInt(fraction.padEnd(MAX_DECIMAL_PLACES, '0'));
}

/** Renders integer units of `10^-8` back into a plain decimal string. */
function fromScaled(units: bigint): string {
  const fraction = String(units % SCALE).padStart(MAX_DECIMAL_PLACES, '0');
  return `${units / SCALE}.${fraction}`;
}

/**
 * A comparable view of a Transaction. `Decimal` and `Date` are reduced to their
 * exact textual forms: two `Decimal` instances holding the same value are not
 * structurally equal, and it is the value that matters here.
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
