import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Decimal } from 'decimal.js';
import fc from 'fast-check';

import { addHolding, removeHolding, updateHolding } from '../../src/domain/holdings';
import { updatePrice } from '../../src/domain/pricing';
import { applyTransaction } from '../../src/domain/transactions';
import { MAX_DECIMAL_PLACES, MAX_VALUE } from '../../src/domain/types';
import type { Holding, PortfolioState, Transaction, TransactionType } from '../../src/domain/types';
import { JsonFilePortfolioRepository } from '../../src/persistence/jsonFilePortfolioRepository';

/**
 * Property 16: Persisted state round-trips through reload
 * (Requirements 5.1, 5.2, 5.3).
 *
 * A sequence of valid Holding and Transaction operations is applied to a
 * Portfolio through the real domain transitions, the resulting state is
 * persisted after *every* operation, and the Portfolio is then loaded back from
 * disk as a restarting application would. The reloaded Holdings and
 * Transactions must be identical to the in-memory state at that moment.
 *
 * The reload is done after each operation rather than only at the end. That is
 * what Req 5.1/5.2 actually promise - the change is on disk by the time the
 * operation is confirmed - and it also pins the failure to the operation that
 * broke the round trip instead of to the whole sequence.
 *
 * Nothing here is mocked: the real `JsonFilePortfolioRepository`, the real
 * serialization helpers, and a real temp directory torn down per test. A stubbed
 * filesystem would only prove that `Decimal` and `Date` survive a JavaScript
 * round trip, while the precision and timezone risks this property guards
 * against live in the encode/decode step through actual JSON text.
 *
 * Values are generated as decimal *strings* and parsed with `Decimal`, never via
 * JavaScript numbers, so the generators themselves cannot lose the precision the
 * property is checking for.
 */

/** Inclusive upper bound for generated quantities and prices, as a bigint. */
const MAX_WHOLE = BigInt(MAX_VALUE);

/** Largest 8-decimal-place fraction, i.e. `.99999999`. */
const MAX_FRACTION = 10 ** MAX_DECIMAL_PLACES - 1;

/** Symbol alphabet from Req 1.11: uppercase letters and digits only. */
const SYMBOL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

/** How many operations a single generated sequence may contain. */
const MAX_OPERATIONS = 6;

/** Size of the symbol pool operations draw from, so they interact. */
const MAX_SYMBOLS = 4;

/**
 * A generated operation. Symbols are referenced by index into the generated
 * symbol pool rather than carried directly, so several operations in one
 * sequence hit the same Holding.
 */
type Operation =
  | { readonly kind: 'addHolding'; readonly at: number; readonly quantity: string; readonly price: string }
  | { readonly kind: 'updateHolding'; readonly at: number; readonly quantity: string; readonly price: string }
  | { readonly kind: 'removeHolding'; readonly at: number }
  | {
      readonly kind: 'transaction';
      readonly at: number;
      readonly type: TransactionType;
      readonly quantity: string;
      readonly pricePerUnit: string;
    }
  /** Sells the Holding's entire quantity, exercising removal-at-zero (Req 2.7). */
  | { readonly kind: 'sellAll'; readonly at: number; readonly pricePerUnit: string }
  | { readonly kind: 'updatePrice'; readonly at: number; readonly price: string };

/**
 * Decimal strings in `[0, MAX_VALUE]` with up to 8 decimal places, biased
 * towards both ends of the range: small everyday values and the 21-significant-
 * digit extremes that a float-backed encoding would silently mangle.
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

const operationArbitrary: fc.Arbitrary<Operation> = fc.oneof(
  fc.record({
    kind: fc.constant('addHolding' as const),
    at: fc.nat({ max: MAX_SYMBOLS - 1 }),
    quantity: decimalStrings('positive'),
    price: decimalStrings('nonNegative'),
  }),
  fc.record({
    kind: fc.constant('updateHolding' as const),
    at: fc.nat({ max: MAX_SYMBOLS - 1 }),
    quantity: decimalStrings('positive'),
    price: decimalStrings('nonNegative'),
  }),
  fc.record({
    kind: fc.constant('removeHolding' as const),
    at: fc.nat({ max: MAX_SYMBOLS - 1 }),
  }),
  fc.record({
    kind: fc.constant('transaction' as const),
    at: fc.nat({ max: MAX_SYMBOLS - 1 }),
    type: fc.constantFrom<TransactionType>('Buy', 'Sell'),
    quantity: decimalStrings('positive'),
    pricePerUnit: decimalStrings('nonNegative'),
  }),
  fc.record({
    kind: fc.constant('sellAll' as const),
    at: fc.nat({ max: MAX_SYMBOLS - 1 }),
    pricePerUnit: decimalStrings('nonNegative'),
  }),
  fc.record({
    kind: fc.constant('updatePrice' as const),
    at: fc.nat({ max: MAX_SYMBOLS - 1 }),
    price: decimalStrings('nonNegative'),
  }),
);

/** A symbol pool plus the operations to run against it. */
const scenarioArbitrary = fc.record({
  symbols: fc.uniqueArray(symbolArbitrary, { minLength: 1, maxLength: MAX_SYMBOLS }),
  operations: fc.array(operationArbitrary, { minLength: 1, maxLength: MAX_OPERATIONS }),
  /**
   * Recording instants, kept to a realistic range: the round trip must survive
   * ISO-8601 encoding, not exotic calendar formats.
   */
  timestamps: fc.array(
    fc.date({
      min: new Date('2000-01-01T00:00:00.000Z'),
      max: new Date('2100-01-01T00:00:00.000Z'),
      noInvalidDate: true,
    }),
    { minLength: MAX_OPERATIONS, maxLength: MAX_OPERATIONS },
  ),
});

const emptyState: PortfolioState = { holdings: new Map(), transactions: [] };

describe('JsonFilePortfolioRepository round trip', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-round-trip-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  // Feature: crypto-portfolio-core, Property 16: Persisted state round-trips through reload
  it('reloads holdings and transactions identical to the in-memory state after every operation', async () => {
    let run = 0;

    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async ({ symbols, operations, timestamps }) => {
        // A fresh file per run, so one run can never read another's document.
        const repository = new JsonFilePortfolioRepository(
          path.join(directory, `portfolio-${(run += 1)}.json`),
        );

        let state = emptyState;
        let recorded = 0;

        for (const [index, operation] of operations.entries()) {
          const next = apply(state, operation, symbols, {
            newId: () => `t-${index}`,
            now: () => timestamps[index] as Date,
          });

          // Rejected operations (duplicate symbol, missing Holding, oversized
          // Sell) change nothing, so there is nothing new to persist.
          if (next === undefined) {
            continue;
          }

          state = next;
          recorded += 1;

          await repository.save(state);
          expect(snapshot(await repository.load())).toEqual(snapshot(state));
        }

        // Guards the generators: a sequence whose every operation was rejected
        // would sail through the loop above without persisting anything, making
        // the run vacuous. A Holding creation or a Buy can never be rejected on
        // the state that precedes it, so at least one of those means at least one
        // save must have happened.
        const mustPersist = operations.some(
          (operation) =>
            operation.kind === 'addHolding' ||
            (operation.kind === 'transaction' && operation.type === 'Buy'),
        );
        expect(recorded > 0 || !mustPersist).toBe(true);
      }),
      { numRuns: 100 },
    );
  }, 120_000);
});

/**
 * Runs one generated operation through the real domain transition, returning the
 * next state, or `undefined` when the domain rejected it.
 */
function apply(
  state: PortfolioState,
  operation: Operation,
  symbols: readonly string[],
  clock: { newId: () => string; now: () => Date },
): PortfolioState | undefined {
  const symbol = symbols[operation.at % symbols.length] as string;

  switch (operation.kind) {
    case 'addHolding': {
      const result = addHolding(state, {
        symbol,
        quantity: new Decimal(operation.quantity),
        currentPrice: new Decimal(operation.price),
      });
      return result.ok ? result.value : undefined;
    }
    case 'updateHolding': {
      const result = updateHolding(state, symbol, {
        quantity: new Decimal(operation.quantity),
        currentPrice: new Decimal(operation.price),
      });
      return result.ok ? result.value : undefined;
    }
    case 'removeHolding': {
      const result = removeHolding(state, symbol);
      return result.ok ? result.value : undefined;
    }
    case 'transaction': {
      const result = applyTransaction(
        state,
        {
          symbol,
          type: operation.type,
          quantity: new Decimal(operation.quantity),
          pricePerUnit: new Decimal(operation.pricePerUnit),
        },
        clock,
      );
      return result.ok ? result.value.state : undefined;
    }
    case 'sellAll': {
      const held = state.holdings.get(symbol);
      if (held === undefined) {
        return undefined;
      }
      const result = applyTransaction(
        state,
        {
          symbol,
          type: 'Sell',
          quantity: held.quantity,
          pricePerUnit: new Decimal(operation.pricePerUnit),
        },
        clock,
      );
      return result.ok ? result.value.state : undefined;
    }
    case 'updatePrice': {
      const result = updatePrice(state, symbol, { currentPrice: new Decimal(operation.price) });
      return result.ok ? result.value : undefined;
    }
  }
}

/**
 * A comparable view of a Portfolio.
 *
 * `Decimal` and `Date` are reduced to their exact textual forms because two
 * `Decimal` instances holding the same value are not structurally equal (they
 * differ in internal digit representation), and `toFixed()` compares the value
 * itself rather than how it happens to be stored. Holdings are sorted by symbol:
 * map iteration order is an implementation detail, not part of "identical
 * Holdings". Transaction order, by contrast, is preserved and compared, since
 * history ordering is observable behavior (Req 2.8).
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
    transactions: state.transactions.map((transaction: Transaction) => ({
      id: transaction.id,
      symbol: transaction.symbol,
      type: transaction.type,
      quantity: transaction.quantity.toFixed(),
      pricePerUnit: transaction.pricePerUnit.toFixed(),
      timestamp: transaction.timestamp.toISOString(),
    })),
  };
}
