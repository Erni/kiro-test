import {
  DuplicateHoldingError,
  InsufficientQuantityError,
  NotFoundError,
  PersistenceError,
  ValidationError,
} from '../../src/domain/errors';
import type { Result } from '../../src/domain/result';
import type { PortfolioState } from '../../src/domain/types';
import type { PortfolioRepository } from '../../src/persistence/portfolioRepository';
import { PortfolioService } from '../../src/service/portfolioService';

/**
 * `PortfolioService` mutating operations (Req 5.1, 5.2, 5.4).
 *
 * The service is the only place where "validate, compute, persist, then swap"
 * lives, so these tests pin the *ordering* guarantees rather than the domain
 * rules themselves — those are covered where they are implemented. Concretely:
 * every accepted change reaches the repository before the caller is told it
 * succeeded; every rejected change reaches the repository not at all; and a
 * failing `save()` leaves the in-memory Portfolio exactly as it was.
 *
 * A recording fake repository is used instead of the JSON-file one: what matters
 * here is *what* was handed to `save()` and *when*, plus the ability to fail a
 * save on demand, none of which needs a real disk. The service's contract is the
 * `PortfolioRepository` interface, so the fake is a complete stand-in.
 *
 * Because the read-only operations are not part of this slice, the in-memory
 * state is observed indirectly, through what later operations see: a symbol that
 * is still absent can be added without a duplicate error, and a Sell can only
 * draw on a quantity the service actually holds. That is a fair proxy — it is
 * the same state the next request would be served from.
 */
describe('PortfolioService mutating operations', () => {
  let repository: RecordingRepository;
  let service: PortfolioService;

  beforeEach(() => {
    repository = new RecordingRepository();
    service = new PortfolioService(repository, emptyState());
  });

  describe('addHolding', () => {
    it('persists the new Holding and returns it with exactly the submitted values', async () => {
      const holding = expectOk(
        await service.addHolding({ symbol: 'BTC', quantity: '1.23456789', currentPrice: '50000' }),
      );

      expect(holding.symbol).toBe('BTC');
      expect(holding.quantity.toFixed()).toBe('1.23456789');
      expect(holding.currentPrice.toFixed()).toBe('50000');

      // Persisted before the result came back, so Req 5.1's "persist before
      // confirming" holds for the caller, not just eventually.
      expect(repository.saves).toHaveLength(1);
      expect(repository.persisted().holdings.get('BTC')?.quantity.toFixed()).toBe('1.23456789');
    });

    it('rejects invalid input with a ValidationError and persists nothing', async () => {
      const error = expectErr(
        await service.addHolding({ symbol: 'btc', quantity: '1', currentPrice: '50000' }),
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect(repository.saves).toHaveLength(0);
    });

    it('rejects a symbol already held with a DuplicateHoldingError and persists nothing', async () => {
      expectOk(await service.addHolding({ symbol: 'BTC', quantity: '1', currentPrice: '50000' }));

      const error = expectErr(
        await service.addHolding({ symbol: 'BTC', quantity: '9', currentPrice: '60000' }),
      );

      expect(error).toBeInstanceOf(DuplicateHoldingError);
      // Only the first, accepted add was persisted; the existing Holding stands.
      expect(repository.saves).toHaveLength(1);
      expect(repository.persisted().holdings.get('BTC')?.quantity.toFixed()).toBe('1');
    });

    it('returns a PersistenceError and leaves the in-memory Portfolio untouched when the save fails', async () => {
      repository.failNextSaves(new PersistenceError('disk full'));

      const error = expectErr(
        await service.addHolding({ symbol: 'BTC', quantity: '1', currentPrice: '50000' }),
      );

      expect(error).toBeInstanceOf(PersistenceError);

      // The failed add left no trace: adding the same symbol again is accepted
      // rather than reported as a duplicate (Req 5.4).
      repository.stopFailing();
      const holding = expectOk(
        await service.addHolding({ symbol: 'BTC', quantity: '2', currentPrice: '60000' }),
      );

      expect(holding.quantity.toFixed()).toBe('2');
      expect(repository.saves).toHaveLength(1);
    });
  });

  describe('updateHolding', () => {
    beforeEach(async () => {
      expectOk(await service.addHolding({ symbol: 'BTC', quantity: '1', currentPrice: '50000' }));
    });

    it('persists the replaced quantity and Current_Price', async () => {
      const holding = expectOk(
        await service.updateHolding('BTC', { quantity: '3.5', currentPrice: '51000' }),
      );

      expect(holding.quantity.toFixed()).toBe('3.5');
      expect(holding.currentPrice.toFixed()).toBe('51000');
      expect(repository.persisted().holdings.get('BTC')?.quantity.toFixed()).toBe('3.5');
    });

    it('rejects an unknown symbol with a NotFoundError and persists nothing', async () => {
      const error = expectErr(
        await service.updateHolding('ETH', { quantity: '3.5', currentPrice: '51000' }),
      );

      expect(error).toBeInstanceOf(NotFoundError);
      expect(repository.saves).toHaveLength(1);
    });

    it('leaves the Holding at its previous values when the save fails', async () => {
      repository.failNextSaves(new PersistenceError('disk full'));

      expectErr(await service.updateHolding('BTC', { quantity: '3.5', currentPrice: '51000' }));

      repository.stopFailing();
      // A Sell of 1 can only succeed if the service still holds the pre-update
      // quantity; had the failed update been applied in memory, 3.5 would remain.
      expectOk(
        await service.recordTransaction({
          symbol: 'BTC',
          type: 'Sell',
          quantity: '1',
          pricePerUnit: '50000',
        }),
      );

      expect(repository.persisted().holdings.has('BTC')).toBe(false);
    });
  });

  describe('removeHolding', () => {
    it('persists the removal along with the Holding\u2019s Transactions', async () => {
      expectOk(await service.addHolding({ symbol: 'BTC', quantity: '1', currentPrice: '50000' }));
      expectOk(
        await service.recordTransaction({
          symbol: 'BTC',
          type: 'Buy',
          quantity: '2',
          pricePerUnit: '50000',
        }),
      );

      expectOk(await service.removeHolding('BTC'));

      expect(repository.persisted().holdings.has('BTC')).toBe(false);
      expect(repository.persisted().transactions).toHaveLength(0);
    });

    it('rejects an unknown symbol with a NotFoundError and persists nothing', async () => {
      const error = expectErr(await service.removeHolding('BTC'));

      expect(error).toBeInstanceOf(NotFoundError);
      expect(repository.saves).toHaveLength(0);
    });
  });

  describe('recordTransaction', () => {
    it('persists the Transaction and the resulting Holding change together', async () => {
      const transaction = expectOk(
        await service.recordTransaction({
          symbol: 'BTC',
          type: 'Buy',
          quantity: '1.5',
          pricePerUnit: '48000',
        }),
      );

      expect(transaction.id).not.toBe('');
      expect(transaction.type).toBe('Buy');

      // One save carries both effects, so the Transaction and the Holding it
      // produced can never diverge on disk (Req 5.2).
      expect(repository.saves).toHaveLength(1);
      const persisted = repository.persisted();
      expect(persisted.transactions.map((entry) => entry.id)).toEqual([transaction.id]);
      expect(persisted.holdings.get('BTC')?.quantity.toFixed()).toBe('1.5');
    });

    it('rejects a Sell larger than the position with an InsufficientQuantityError and persists nothing', async () => {
      expectOk(await service.addHolding({ symbol: 'BTC', quantity: '1', currentPrice: '50000' }));

      const error = expectErr(
        await service.recordTransaction({
          symbol: 'BTC',
          type: 'Sell',
          quantity: '2',
          pricePerUnit: '50000',
        }),
      );

      expect(error).toBeInstanceOf(InsufficientQuantityError);
      expect(repository.saves).toHaveLength(1);
    });

    it('rejects an unknown Transaction_Type with a ValidationError and persists nothing', async () => {
      const error = expectErr(
        await service.recordTransaction({
          symbol: 'BTC',
          type: 'Transfer',
          quantity: '1',
          pricePerUnit: '50000',
        }),
      );

      expect(error).toBeInstanceOf(ValidationError);
      expect(repository.saves).toHaveLength(0);
    });

    it('records neither the Transaction nor the Holding change when the save fails', async () => {
      repository.failNextSaves(new PersistenceError('disk full'));

      expectErr(
        await service.recordTransaction({
          symbol: 'BTC',
          type: 'Buy',
          quantity: '1.5',
          pricePerUnit: '48000',
        }),
      );

      repository.stopFailing();
      // The Buy left nothing behind in memory either, so BTC is still unheld and
      // a Sell against it is insufficient rather than partially satisfiable.
      const error = expectErr(
        await service.recordTransaction({
          symbol: 'BTC',
          type: 'Sell',
          quantity: '1.5',
          pricePerUnit: '48000',
        }),
      );

      expect(error).toBeInstanceOf(InsufficientQuantityError);
      expect((error as InsufficientQuantityError).available.toFixed()).toBe('0');
      expect(repository.saves).toHaveLength(0);
    });
  });

  describe('updatePrice', () => {
    it('persists the new Current_Price and leaves the quantity unchanged', async () => {
      expectOk(await service.addHolding({ symbol: 'BTC', quantity: '1.5', currentPrice: '50000' }));

      const holding = expectOk(await service.updatePrice('BTC', { currentPrice: '51234.5678' }));

      expect(holding.currentPrice.toFixed()).toBe('51234.5678');
      expect(holding.quantity.toFixed()).toBe('1.5');
      expect(repository.persisted().holdings.get('BTC')?.currentPrice.toFixed()).toBe('51234.5678');
    });

    it('rejects a negative price with a ValidationError and persists nothing', async () => {
      expectOk(await service.addHolding({ symbol: 'BTC', quantity: '1.5', currentPrice: '50000' }));

      const error = expectErr(await service.updatePrice('BTC', { currentPrice: '-1' }));

      expect(error).toBeInstanceOf(ValidationError);
      expect(repository.saves).toHaveLength(1);
    });

    it('rejects an unknown symbol with a NotFoundError', async () => {
      const error = expectErr(await service.updatePrice('BTC', { currentPrice: '51000' }));

      expect(error).toBeInstanceOf(NotFoundError);
      expect(repository.saves).toHaveLength(0);
    });
  });

  describe('concurrency', () => {
    it('serializes overlapping mutations so no update is lost', async () => {
      // Each save resolves only after a macrotask, so both operations are in
      // flight at once: without the mutex the second would compute its new
      // quantity from the same empty state as the first and overwrite it.
      repository.delaySaves(true);

      const results = await Promise.all([
        service.recordTransaction({
          symbol: 'BTC',
          type: 'Buy',
          quantity: '1',
          pricePerUnit: '48000',
        }),
        service.recordTransaction({
          symbol: 'BTC',
          type: 'Buy',
          quantity: '2',
          pricePerUnit: '49000',
        }),
      ]);

      for (const result of results) {
        expectOk(result);
      }

      expect(repository.saves).toHaveLength(2);
      expect(repository.persisted().holdings.get('BTC')?.quantity.toFixed()).toBe('3');
      expect(repository.persisted().transactions).toHaveLength(2);
    });

    it('keeps serving later mutations after one of them fails to persist', async () => {
      repository.delaySaves(true);
      repository.failNextSaves(new PersistenceError('disk full'));

      const failing = service.addHolding({ symbol: 'BTC', quantity: '1', currentPrice: '50000' });
      // Queued behind the failing operation: a rejected save must not poison the
      // mutex and strand everything after it.
      const queued = service.addHolding({ symbol: 'ETH', quantity: '10', currentPrice: '3000' });

      expect(expectErr(await failing)).toBeInstanceOf(PersistenceError);
      expect(expectErr(await queued)).toBeInstanceOf(PersistenceError);

      repository.stopFailing();
      const third = expectOk(
        await service.addHolding({ symbol: 'SOL', quantity: '5', currentPrice: '150' }),
      );
      expect(third.symbol).toBe('SOL');
      expect([...repository.persisted().holdings.keys()]).toEqual(['SOL']);
    });
  });
});

/**
 * A `PortfolioRepository` that keeps every state handed to `save()` in memory,
 * can be made to fail on demand, and can defer its saves by a macrotask so two
 * operations genuinely overlap.
 */
class RecordingRepository implements PortfolioRepository {
  /** Every state passed to a *successful* `save()`, oldest first. */
  readonly saves: PortfolioState[] = [];

  private failure: Error | undefined = undefined;

  private delayed = false;

  async load(): Promise<PortfolioState> {
    return this.persisted();
  }

  async save(state: PortfolioState): Promise<void> {
    if (this.delayed) {
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
    }
    if (this.failure !== undefined) {
      throw this.failure;
    }
    this.saves.push(state);
  }

  /** The most recently persisted state, or an empty Portfolio if there is none. */
  persisted(): PortfolioState {
    return this.saves.at(-1) ?? emptyState();
  }

  /** Makes every subsequent `save()` reject until {@link stopFailing}. */
  failNextSaves(failure: Error): void {
    this.failure = failure;
  }

  stopFailing(): void {
    this.failure = undefined;
  }

  delaySaves(delayed: boolean): void {
    this.delayed = delayed;
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

/** Unwraps a failed `Result`, failing the test on success. */
function expectErr<T, E>(result: Result<T, E>): E {
  if (result.ok) {
    throw new Error('Expected a failed result, got a successful one');
  }
  return result.error;
}
