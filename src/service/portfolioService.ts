import { PersistenceError } from '../domain/errors';
import {
  addHolding as addHoldingToState,
  listHoldings as listHoldingsOf,
  removeHolding as removeHoldingFromState,
  updateHolding as updateHoldingInState,
} from '../domain/holdings';
import { updatePrice as updatePriceInState } from '../domain/pricing';
import { err, ok } from '../domain/result';
import { applyTransaction, transactionHistory } from '../domain/transactions';
import { portfolioOverview } from '../domain/valuation';
import {
  validateHoldingUpdateInput,
  validateNewHoldingInput,
  validatePriceUpdateInput,
  validateTransactionInput,
} from '../domain/validation';

import type {
  DuplicateHoldingError,
  InsufficientQuantityError,
  NotFoundError,
  ValidationError,
} from '../domain/errors';
import type { Result } from '../domain/result';
import type {
  Holding,
  HoldingUpdateInput,
  NewHoldingInput,
  PortfolioOverview,
  PortfolioState,
  PriceUpdateInput,
  Symbol as AssetSymbol,
  Transaction,
  TransactionInput,
} from '../domain/types';
import type { PortfolioRepository } from '../persistence/portfolioRepository';

/**
 * The application layer: the sole owner of the in-memory `PortfolioState`, the
 * mutex that serializes writes, and the `PortfolioRepository` it persists
 * through.
 *
 * Every mutating operation follows one template (see {@link PortfolioService.mutate}):
 * validate the input, compute the next state through the pure domain layer,
 * persist it, and only then swap it in as the current in-memory state. That
 * order is what Req 5.1 and 5.2 ask for — the change is persisted *before* the
 * operation is confirmed — and it makes Req 5.4 structural rather than something
 * the code has to remember to do: there is no path that persists without
 * swapping, or swaps without persisting, so a failure anywhere before the swap
 * leaves the in-memory state at exactly its pre-attempt value with no rollback
 * step to get wrong.
 *
 * The domain transitions help here by being pure: they return a brand-new state
 * and never touch the one handed in, so the state this service is still holding
 * *is* the rollback value.
 */
export class PortfolioService {
  /** Where the Portfolio is persisted. */
  private readonly repository: PortfolioRepository;

  /**
   * The Portfolio as last successfully persisted. Reassigned only by
   * {@link mutate}, only after a successful `save()`, and only while the mutex
   * is held.
   */
  private state: PortfolioState;

  /**
   * Tail of the mutex chain: resolves when the operation currently in flight has
   * finished. Never rejects — see {@link runExclusive}.
   */
  private pending: Promise<void> = Promise.resolve();

  /**
   * @param repository persistence for the Portfolio.
   * @param initialState the Portfolio loaded from `repository` at startup, which
   *   is an empty Portfolio on a first run (Req 5.3, 5.5). Loading happens in
   *   the caller rather than here so a `StartupError` can stop startup before a
   *   service exists at all (Req 5.6).
   */
  constructor(repository: PortfolioRepository, initialState: PortfolioState) {
    this.repository = repository;
    this.state = initialState;
  }

  /**
   * Creates a Holding from untrusted input (Req 1.1).
   *
   * Returns the Holding as stored, carrying exactly the submitted values. Fails
   * with a `ValidationError` for a malformed symbol, quantity, or Current_Price
   * (Req 1.3, 1.4, 1.11), a `DuplicateHoldingError` when the symbol is already
   * held (Req 1.2), or a `PersistenceError` when the change cannot be persisted
   * (Req 5.4).
   */
  async addHolding(
    input: NewHoldingInput,
  ): Promise<Result<Holding, ValidationError | DuplicateHoldingError | PersistenceError>> {
    return this.mutate<Holding, ValidationError | DuplicateHoldingError>((state) => {
      const valid = validateNewHoldingInput(input);
      if (!valid.ok) {
        return err(valid.error);
      }

      const next = addHoldingToState(state, valid.value);
      if (!next.ok) {
        return err(next.error);
      }

      return ok({ state: next.value, value: holdingOf(next.value, valid.value.symbol) });
    });
  }

  /**
   * Replaces an existing Holding's quantity and Current_Price (Req 1.5).
   *
   * Returns the updated Holding. Fails with a `ValidationError` for an invalid
   * quantity or Current_Price (Req 1.6), a `NotFoundError` when no Holding
   * exists for the symbol (Req 1.9), or a `PersistenceError` (Req 5.4). In every
   * failure case the Holding keeps its pre-update values.
   */
  async updateHolding(
    symbol: AssetSymbol,
    input: HoldingUpdateInput,
  ): Promise<Result<Holding, ValidationError | NotFoundError | PersistenceError>> {
    return this.mutate<Holding, ValidationError | NotFoundError>((state) => {
      const valid = validateHoldingUpdateInput(input);
      if (!valid.ok) {
        return err(valid.error);
      }

      const next = updateHoldingInState(state, symbol, valid.value);
      if (!next.ok) {
        return err(next.error);
      }

      return ok({ state: next.value, value: holdingOf(next.value, symbol) });
    });
  }

  /**
   * Deletes a Holding and every Transaction recorded for it (Req 1.7).
   *
   * Fails with a `NotFoundError` when no Holding exists for the symbol
   * (Req 1.10) or a `PersistenceError` when the removal cannot be persisted
   * (Req 5.4) — in which case the Holding and its Transactions are still there.
   */
  async removeHolding(
    symbol: AssetSymbol,
  ): Promise<Result<void, NotFoundError | PersistenceError>> {
    return this.mutate<void, NotFoundError>((state) => {
      const next = removeHoldingFromState(state, symbol);
      if (!next.ok) {
        return err(next.error);
      }

      return ok({ state: next.value, value: undefined });
    });
  }

  /**
   * Returns every Holding currently in the Portfolio, or an empty array when
   * there are none (Req 1.8).
   *
   * Read-only, so it does not take the mutex — see the note on
   * {@link PortfolioService.snapshot}.
   */
  async listHoldings(): Promise<Holding[]> {
    return listHoldingsOf(this.snapshot());
  }

  /**
   * Records a Buy or Sell Transaction and applies its effect on the Holding
   * (Req 2.1, 2.2, 2.3, 2.7).
   *
   * Returns the Transaction as recorded, including the id and timestamp assigned
   * by the System (Req 2.9). Fails with a `ValidationError` for an unknown
   * Transaction_Type, a non-positive quantity, or a negative price per unit
   * (Req 2.5, 2.6), an `InsufficientQuantityError` when a Sell exceeds the
   * position on hand or targets a symbol with no Holding (Req 2.4), or a
   * `PersistenceError` (Req 5.4).
   *
   * The Transaction and the resulting Holding change are persisted together in a
   * single `save()`, so the two can never diverge (Req 5.2).
   */
  async recordTransaction(
    input: TransactionInput,
  ): Promise<
    Result<Transaction, ValidationError | InsufficientQuantityError | PersistenceError>
  > {
    return this.mutate<Transaction, ValidationError | InsufficientQuantityError>((state) => {
      const valid = validateTransactionInput(input);
      if (!valid.ok) {
        return err(valid.error);
      }

      const applied = applyTransaction(state, valid.value);
      if (!applied.ok) {
        return err(applied.error);
      }

      return ok({ state: applied.value.state, value: applied.value.transaction });
    });
  }

  /**
   * Returns every Transaction recorded for a symbol, oldest first (Req 2.8).
   *
   * Independent of whether a Holding currently exists for the symbol: a Sell
   * that took a position to zero removes the Holding but keeps its history
   * (Req 2.7), so an empty array means "nothing was ever recorded", not
   * "nothing is held".
   */
  async getTransactionHistory(symbol: AssetSymbol): Promise<Transaction[]> {
    return transactionHistory(this.snapshot(), symbol);
  }

  /**
   * Returns every Holding with its Holding_Value plus the Portfolio_Value
   * (Req 3.1, 3.2), which is zero for an empty Portfolio (Req 3.3).
   *
   * Both values are derived at call time from the state this read observes, so
   * the overview reflects the quantities and Current_Prices as of the call
   * (Req 3.4) rather than anything cached.
   */
  async getPortfolioOverview(): Promise<PortfolioOverview> {
    return portfolioOverview(this.snapshot());
  }

  /**
   * Replaces an existing Holding's Current_Price, leaving its quantity
   * unchanged (Req 4.1).
   *
   * Returns the repriced Holding. Fails with a `ValidationError` when the
   * Current_Price is missing, non-numeric, or negative (Req 4.2), a
   * `NotFoundError` when no Holding exists for the symbol (Req 4.3), or a
   * `PersistenceError` (Req 5.4) — leaving the previous price in place in each
   * case.
   */
  async updatePrice(
    symbol: AssetSymbol,
    input: PriceUpdateInput,
  ): Promise<Result<Holding, ValidationError | NotFoundError | PersistenceError>> {
    return this.mutate<Holding, ValidationError | NotFoundError>((state) => {
      const valid = validatePriceUpdateInput(input);
      if (!valid.ok) {
        return err(valid.error);
      }

      const next = updatePriceInState(state, symbol, valid.value);
      if (!next.ok) {
        return err(next.error);
      }

      return ok({ state: next.value, value: holdingOf(next.value, symbol) });
    });
  }

  /**
   * The state a read observes: whatever was last successfully persisted at the
   * moment of the call.
   *
   * Reads deliberately skip the mutex. The mutex exists to stop two *writes*
   * from computing against the same state, and taking it for reads would only
   * make every read wait behind the queued writes to return the exact same
   * value. Reading the field is safe without it because {@link mutate}
   * reassigns `this.state` in a single synchronous step and the domain
   * transitions never mutate a state in place, so a read either sees the state
   * before an operation or the state after it, never a half-applied one.
   *
   * The consequence is that a read taken while a write is in flight may return
   * the pre-write Portfolio. That is the correct answer to "what is the
   * Portfolio right now": the in-flight change is not persisted yet, and may
   * still fail (Req 5.4).
   */
  private snapshot(): PortfolioState {
    return this.state;
  }

  /**
   * Runs one mutating operation: validate and compute under the mutex, persist,
   * then swap in the new state.
   *
   * `compute` receives the current in-memory state and is expected to be pure —
   * it returns the next state plus the value to hand back to the caller, or a
   * typed domain error. It runs *inside* the mutex, so the state it reads is the
   * state its result is persisted against: two concurrent Buys for the same
   * symbol both land, rather than the second overwriting the first with a total
   * computed from a stale quantity.
   *
   * The swap is the last step, and it only happens on a resolved `save()`. That
   * single ordering is what satisfies Req 5.1, 5.2, and 5.4 for every operation
   * at once.
   */
  private mutate<T, E>(
    compute: (state: PortfolioState) => Result<Mutation<T>, E>,
  ): Promise<Result<T, E | PersistenceError>> {
    return this.runExclusive(async (): Promise<Result<T, E | PersistenceError>> => {
      const computed = compute(this.state);
      if (!computed.ok) {
        // Nothing persisted, nothing swapped: the Portfolio is untouched.
        return err(computed.error);
      }

      try {
        await this.repository.save(computed.value.state);
      } catch (cause) {
        // The computed state is dropped on the floor here, which is the whole
        // point: `this.state` was never reassigned, so both the in-memory and
        // the persisted Portfolio are still exactly as they were (Req 5.4).
        return err(asPersistenceError(cause));
      }

      this.state = computed.value.state;
      return ok(computed.value.value);
    });
  }

  /**
   * Serializes `operation` against every other exclusive operation, in call
   * order.
   *
   * The mutex is a promise chain rather than a lock with a queue: each caller
   * hangs its work off the tail and becomes the new tail. The tail is normalized
   * so it never rejects, otherwise one failed operation would poison every
   * operation queued behind it. The caller's own promise is returned unmodified,
   * so it still sees the real result or rejection.
   */
  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(settled, settled);
    return result;
  }
}

/** What a mutating operation produces: the next state and the caller's value. */
interface Mutation<T> {
  readonly state: PortfolioState;
  readonly value: T;
}

/** Collapses a settled outcome to `void` so the mutex tail never rejects. */
function settled(): void {
  return undefined;
}

/**
 * Reads back the Holding an operation just wrote.
 *
 * Returning the Holding out of the resulting state, rather than rebuilding it
 * from the input, means callers always see what was actually stored.
 *
 * The absence of the Holding is a broken invariant, not an expected outcome — a
 * successful add / update / reprice leaves a Holding for that symbol by
 * definition — so it throws rather than returning a `Result`.
 */
function holdingOf(state: PortfolioState, symbol: AssetSymbol): Holding {
  const holding = state.holdings.get(symbol);
  if (holding === undefined) {
    throw new Error(
      `Invariant violated: no Holding for ${symbol} after a successful state transition`,
    );
  }
  return holding;
}

/**
 * Normalizes a rejected `save()` into a `PersistenceError`.
 *
 * A repository is documented to reject with `PersistenceError`, and that error
 * is passed through untouched. Anything else — a bug in a repository
 * implementation, a serialization failure — is still a failure to persist from
 * the caller's point of view, so it is wrapped rather than thrown: the operation
 * has already been made safe by not swapping the state, and turning that into an
 * unhandled rejection would only hide which operation failed. The original is
 * kept as the `cause`.
 */
function asPersistenceError(cause: unknown): PersistenceError {
  if (cause instanceof PersistenceError) {
    return cause;
  }
  return new PersistenceError(
    `Unable to persist the portfolio: ${cause instanceof Error ? cause.message : String(cause)}`,
    cause,
  );
}
