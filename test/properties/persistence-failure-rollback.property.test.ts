import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import fc from 'fast-check';

import { PersistenceError } from '../../src/domain/errors';
import { MAX_DECIMAL_PLACES, MAX_VALUE } from '../../src/domain/types';
import type { PortfolioState, Symbol as AssetSymbol } from '../../src/domain/types';
import type { Result } from '../../src/domain/result';
import { JsonFilePortfolioRepository } from '../../src/persistence/jsonFilePortfolioRepository';
import type { PortfolioRepository } from '../../src/persistence/portfolioRepository';
import { PortfolioService } from '../../src/service/portfolioService';

/**
 * Property 17: A persistence failure leaves both in-memory and persisted state
 * unchanged (Requirement 5.4).
 *
 * A Portfolio is arranged by running a generated sequence of valid operations
 * through a real `PortfolioService` against a real `JsonFilePortfolioRepository`
 * in a temp directory. The repository is then forced to fail its next `save()`,
 * and one more *valid* operation is attempted. That operation must report an
 * error, and both what the service serves from memory and what is on disk must
 * be exactly what they were the instant before the attempt.
 *
 * The attempted operation is valid by construction rather than by luck: each
 * generated operation is resolved against the arranged state (an `addHolding`
 * picks a symbol that is not held, a Sell picks one that is and never asks for
 * more than the position on hand). Without that, most generated attempts would
 * be rejected by validation or by the domain before persistence was ever
 * reached, and the run would prove nothing about a persistence failure. The
 * final replay - the same operation, re-attempted once the repository stops
 * failing, which must succeed - keeps that guarantee honest: it can only pass
 * if the operation really was one the System would otherwise have accepted, on
 * a state that really was left at its pre-attempt value.
 *
 * Persistence is real, not stubbed. The claim is about *both* copies of the
 * Portfolio, and the on-disk copy is compared as raw file bytes, which is the
 * literal reading of "as it was immediately before the change was attempted"
 * and would catch a partial or reordered rewrite that a state-level comparison
 * could normalize away. The only thing wrapped is the failure trigger.
 *
 * The in-memory copy is observed through the service's own read operations,
 * since that is the state the next request would be served from - the point of
 * Req 5.4 is that a caller cannot tell a failed operation was ever attempted.
 */

/** Inclusive upper bound for generated quantities and prices, as a bigint. */
const MAX_WHOLE = BigInt(MAX_VALUE);

/** Largest 8-decimal-place fraction, i.e. `.99999999`. */
const MAX_FRACTION = 10 ** MAX_DECIMAL_PLACES - 1;

/** Symbol alphabet from Req 1.11: uppercase letters and digits only. */
const SYMBOL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

/** Size of the symbol pool operations draw from, so they interact. */
const MAX_SYMBOLS = 3;

/** How many operations may be used to arrange the Portfolio before the attempt. */
const MAX_ARRANGE_OPERATIONS = 4;

/** The kinds of mutating operation Req 5.4 covers. */
type OperationKind =
  | 'addHolding'
  | 'updateHolding'
  | 'removeHolding'
  | 'buy'
  | 'sell'
  | 'updatePrice';

/**
 * A generated operation, before it is resolved against a concrete Portfolio.
 *
 * The symbol is an index into the symbol pool rather than a symbol, and a Sell
 * carries a divisor rather than a quantity, so the same seed stays valid however
 * the arranged state turned out.
 */
interface OperationSeed {
  readonly kind: OperationKind;
  /** Selects a symbol from whichever pool the resolved operation needs. */
  readonly at: number;
  readonly quantity: string;
  readonly price: string;
  /** `1` sells the entire position; larger values sell a fraction of it. */
  readonly sellDivisor: number;
}

/** How the wrapped repository fails. */
type FailureKind =
  /** Rejects with the documented `PersistenceError` (Req 5.4). */
  | 'persistenceError'
  /** Rejects with something else, e.g. a bug in a repository implementation. */
  | 'unexpected';

/**
 * Decimal strings in `[0, MAX_VALUE]` with up to 8 decimal places, biased
 * towards both small everyday values and the bounds, where an off-by-one in a
 * range check would hide. `positive` additionally guarantees `> 0`, as Holding
 * and Transaction quantities require.
 */
function amounts(bound: 'positive' | 'nonNegative'): fc.Arbitrary<string> {
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
const symbolArbitrary: fc.Arbitrary<AssetSymbol> = fc
  .array(fc.constantFrom(...SYMBOL_CHARS), { minLength: 1, maxLength: 10 })
  .map((characters) => characters.join(''));

const seedArbitrary: fc.Arbitrary<OperationSeed> = fc.record({
  kind: fc.constantFrom<OperationKind>(
    'addHolding',
    'updateHolding',
    'removeHolding',
    'buy',
    'sell',
    'updatePrice',
  ),
  at: fc.nat({ max: MAX_SYMBOLS * 4 }),
  quantity: amounts('positive'),
  price: amounts('nonNegative'),
  sellDivisor: fc.integer({ min: 1, max: 4 }),
});

/** A symbol pool, the operations that arrange the Portfolio, and the attempt. */
const scenarioArbitrary = fc.record({
  symbols: fc.uniqueArray(symbolArbitrary, { minLength: 1, maxLength: MAX_SYMBOLS }),
  arrange: fc.array(seedArbitrary, { minLength: 0, maxLength: MAX_ARRANGE_OPERATIONS }),
  attempted: seedArbitrary,
  failure: fc.constantFrom<FailureKind>('persistenceError', 'unexpected'),
});

describe('PortfolioService persistence failure', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-rollback-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  // Feature: crypto-portfolio-core, Property 17: A persistence failure leaves both in-memory and persisted state unchanged
  it('reports an error and changes neither the in-memory nor the persisted Portfolio', async () => {
    let run = 0;

    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async ({ symbols, arrange, attempted, failure }) => {
        // A fresh file per run, so one run can never observe another's document.
        const filePath = path.join(directory, `portfolio-${(run += 1)}.json`);
        const repository = new FailableRepository(new JsonFilePortfolioRepository(filePath));
        const service = new PortfolioService(repository, emptyState());

        for (const seed of arrange) {
          expectOk(await perform(service, seed, symbols));
        }

        const inMemoryBefore = await observe(service, symbols);
        const persistedBefore = await readDocument(filePath);

        repository.failSaves(failure);
        const result = await perform(service, attempted, symbols);

        // Not reported as successful, and reported as a failure to persist
        // whatever the repository actually threw.
        expect(result.ok).toBe(false);
        expect(result.ok ? undefined : result.error).toBeInstanceOf(PersistenceError);

        expect(await observe(service, symbols)).toEqual(inMemoryBefore);
        expect(await readDocument(filePath)).toEqual(persistedBefore);

        // The attempt was an operation the System would have accepted, so the
        // error above came from persistence alone - and the state it is retried
        // against is genuinely the pre-attempt one.
        repository.stopFailing();
        expectOk(await perform(service, attempted, symbols));
      }),
      { numRuns: 100 },
    );
  }, 120_000);
});

/**
 * Resolves `seed` against the Portfolio the service currently holds and runs the
 * resulting operation, which is always one the domain accepts.
 *
 * Operations that need an existing Holding fall back to a Buy when the Portfolio
 * is empty, and an `addHolding` falls back to a Buy when every pooled symbol is
 * already held. A Buy is the one operation that is valid on any state, so it is
 * the natural fallback - and it keeps the fallback from quietly becoming a no-op.
 */
async function perform(
  service: PortfolioService,
  seed: OperationSeed,
  symbols: readonly AssetSymbol[],
): Promise<Result<unknown, unknown>> {
  const holdings = await service.listHoldings();
  const held = holdings.length === 0 ? undefined : holdings[seed.at % holdings.length];
  const unheld = symbols.filter(
    (symbol) => !holdings.some((holding) => holding.symbol === symbol),
  );

  switch (seed.kind) {
    case 'addHolding': {
      if (unheld.length === 0) {
        return buy(service, seed, symbols);
      }
      return service.addHolding({
        symbol: unheld[seed.at % unheld.length] as AssetSymbol,
        quantity: seed.quantity,
        currentPrice: seed.price,
      });
    }
    case 'updateHolding': {
      if (held === undefined) {
        return buy(service, seed, symbols);
      }
      return service.updateHolding(held.symbol, {
        quantity: seed.quantity,
        currentPrice: seed.price,
      });
    }
    case 'removeHolding': {
      if (held === undefined) {
        return buy(service, seed, symbols);
      }
      return service.removeHolding(held.symbol);
    }
    case 'buy': {
      return buy(service, seed, symbols);
    }
    case 'sell': {
      if (held === undefined) {
        return buy(service, seed, symbols);
      }
      // Dividing a positive quantity can never reach zero or exceed the
      // position, so the Sell is always within what is on hand (Req 2.4). A
      // divisor of 1 sells the position out entirely, exercising Req 2.7's
      // removal-at-zero on the failing path too.
      const quantity =
        seed.sellDivisor === 1 ? held.quantity : held.quantity.div(seed.sellDivisor);
      return service.recordTransaction({
        symbol: held.symbol,
        type: 'Sell',
        quantity: quantity.toFixed(),
        pricePerUnit: seed.price,
      });
    }
    case 'updatePrice': {
      if (held === undefined) {
        return buy(service, seed, symbols);
      }
      return service.updatePrice(held.symbol, { currentPrice: seed.price });
    }
  }
}

/** A Buy, which is valid whether or not the symbol is currently held (Req 2.1, 2.3). */
async function buy(
  service: PortfolioService,
  seed: OperationSeed,
  symbols: readonly AssetSymbol[],
): Promise<Result<unknown, unknown>> {
  return service.recordTransaction({
    symbol: symbols[seed.at % symbols.length] as AssetSymbol,
    type: 'Buy',
    quantity: seed.quantity,
    pricePerUnit: seed.price,
  });
}

/**
 * Everything a caller can observe of the in-memory Portfolio: the Holdings, the
 * derived values, and the Transaction history of every pooled symbol.
 *
 * `Decimal` values are reduced to their exact textual form because two
 * `Decimal` instances holding the same value are not structurally equal.
 * Holdings and history are compared in the order the service returns them,
 * since ordering is observable too (Req 2.8).
 */
async function observe(
  service: PortfolioService,
  symbols: readonly AssetSymbol[],
): Promise<unknown> {
  const overview = await service.getPortfolioOverview();
  const history: Record<string, unknown[]> = {};

  for (const symbol of symbols) {
    history[symbol] = (await service.getTransactionHistory(symbol)).map((transaction) => ({
      id: transaction.id,
      type: transaction.type,
      quantity: transaction.quantity.toFixed(),
      pricePerUnit: transaction.pricePerUnit.toFixed(),
      timestamp: transaction.timestamp.toISOString(),
    }));
  }

  return {
    holdings: (await service.listHoldings()).map((holding) => ({
      symbol: holding.symbol,
      quantity: holding.quantity.toFixed(),
      currentPrice: holding.currentPrice.toFixed(),
    })),
    overview: overview.holdings.map((view) => ({
      symbol: view.symbol,
      holdingValue: view.holdingValue.toFixed(),
    })),
    portfolioValue: overview.portfolioValue.toFixed(),
    history,
  };
}

/**
 * The persisted document verbatim, or `undefined` when nothing has been
 * persisted yet - which is itself a state the failed attempt must not change.
 */
async function readDocument(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (cause) {
    if ((cause as { code?: unknown } | null)?.code === 'ENOENT') {
      return undefined;
    }
    throw cause;
  }
}

/**
 * A repository that delegates to a real one until its `save()` is armed to fail.
 *
 * The failure is raised *before* delegating, so the wrapped store is never
 * touched on a failing save - the point being to test the service's behavior
 * when persistence fails, not the store's own atomicity, which
 * `test/persistence/atomic-write.test.ts` covers.
 */
class FailableRepository implements PortfolioRepository {
  private readonly inner: PortfolioRepository;

  private failure: FailureKind | undefined = undefined;

  constructor(inner: PortfolioRepository) {
    this.inner = inner;
  }

  async load(): Promise<PortfolioState> {
    return this.inner.load();
  }

  async save(state: PortfolioState): Promise<void> {
    if (this.failure === 'persistenceError') {
      throw new PersistenceError('Simulated failure to persist the portfolio');
    }
    if (this.failure === 'unexpected') {
      throw new Error('Simulated unexpected repository failure');
    }
    return this.inner.save(state);
  }

  /** Makes every subsequent `save()` reject until {@link stopFailing}. */
  failSaves(failure: FailureKind): void {
    this.failure = failure;
  }

  stopFailing(): void {
    this.failure = undefined;
  }
}

function emptyState(): PortfolioState {
  return { holdings: new Map(), transactions: [] };
}

/** Unwraps a successful `Result`, failing the test with the error otherwise. */
function expectOk<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`Expected a successful result, got: ${String(result.error)}`);
  }
  return result.value;
}
