import type { PortfolioState } from '../domain/types';

/**
 * The persistence boundary for the Portfolio.
 *
 * The service layer depends on this interface only, never on a concrete
 * implementation, so the JSON-file store used today can be replaced by a
 * database-backed one without touching the domain or service layers.
 *
 * Persistence failures are *not* modelled as `Result` values here: unlike
 * validation or not-found outcomes, an I/O failure is genuinely exceptional, so
 * implementations reject the returned promise instead. Implementations reject
 * with `PersistenceError` from `save()` (Req 5.4) and with `StartupError` from
 * `load()` (Req 5.6) so callers can still discriminate on `error.kind`.
 */
export interface PortfolioRepository {
  /**
   * Loads the previously persisted Portfolio, including all Holdings and
   * Transactions (Req 5.3).
   *
   * Resolves with an empty `PortfolioState` — zero Holdings, zero Transactions
   * — when nothing has been persisted yet (Req 5.5). Rejects with a
   * `StartupError` when persisted data exists but cannot be read or parsed
   * (Req 5.6).
   */
  load(): Promise<PortfolioState>;

  /**
   * Persists `state` in full, all-or-nothing (Req 5.1, 5.2).
   *
   * Resolving means the state is durably stored, which is what lets the service
   * layer confirm an operation to the user only after a successful save.
   * Rejects with a `PersistenceError` on failure, leaving the previously
   * persisted state exactly as it was (Req 5.4).
   */
  save(state: PortfolioState): Promise<void>;
}
