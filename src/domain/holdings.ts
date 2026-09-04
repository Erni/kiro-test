import { DuplicateHoldingError, NotFoundError } from './errors';
import { err, ok } from './result';

import type { Result } from './result';
import type {
  Holding,
  PortfolioState,
  Symbol as AssetSymbol,
  ValidHoldingInput,
  ValidHoldingUpdateInput,
} from './types';

/**
 * Holding state transitions (Req 1.1, 1.2, 1.5, 1.7, 1.8, 1.9, 1.10).
 *
 * Every function here is pure: the input `PortfolioState` is never mutated, and
 * each transition returns a brand-new state with fresh `holdings` map and
 * `transactions` array instances. That keeps the previous state usable as the
 * rollback value when persistence fails (Req 5.4), which is why the service
 * layer can simply keep holding its old reference.
 *
 * Inputs are already validated: these functions take `Valid…Input` values
 * produced by `validation.ts`, so the only failures left are the state-dependent
 * ones (duplicate symbol, missing Holding).
 */

/** Copies the holdings map so callers can mutate the copy freely. */
function copyHoldings(state: PortfolioState): Map<AssetSymbol, Holding> {
  return new Map(state.holdings);
}

/**
 * Creates a Holding from validated input (Req 1.1).
 *
 * Rejects with `DuplicateHoldingError` when the symbol is already held
 * (Req 1.2). On success the stored Holding carries exactly the submitted
 * symbol, quantity, and Current_Price, with no rounding or normalization.
 */
export function addHolding(
  state: PortfolioState,
  input: ValidHoldingInput,
): Result<PortfolioState, DuplicateHoldingError> {
  if (state.holdings.has(input.symbol)) {
    return err(new DuplicateHoldingError(input.symbol));
  }

  const holding: Holding = {
    symbol: input.symbol,
    quantity: input.quantity,
    currentPrice: input.currentPrice,
  };

  const holdings = copyHoldings(state);
  holdings.set(holding.symbol, holding);

  return ok({ holdings, transactions: [...state.transactions] });
}

/**
 * Replaces an existing Holding's quantity and Current_Price with the submitted
 * values (Req 1.5).
 *
 * Rejects with `NotFoundError` when no Holding exists for the symbol
 * (Req 1.9). Transactions are untouched: an update revises the Holding's
 * current position, it does not rewrite its history.
 */
export function updateHolding(
  state: PortfolioState,
  symbol: AssetSymbol,
  input: ValidHoldingUpdateInput,
): Result<PortfolioState, NotFoundError> {
  const existing = state.holdings.get(symbol);
  if (existing === undefined) {
    return err(new NotFoundError(symbol));
  }

  const updated: Holding = {
    symbol: existing.symbol,
    quantity: input.quantity,
    currentPrice: input.currentPrice,
  };

  const holdings = copyHoldings(state);
  holdings.set(existing.symbol, updated);

  return ok({ holdings, transactions: [...state.transactions] });
}

/**
 * Deletes a Holding and every Transaction recorded for it (Req 1.7).
 *
 * Rejects with `NotFoundError` when no Holding exists for the symbol
 * (Req 1.10). Note the contrast with a Sell that reduces a Holding to zero,
 * which removes the Holding but *keeps* its Transactions (Req 2.7): manual
 * removal is the user discarding the asset from the Portfolio entirely, so its
 * history goes with it.
 */
export function removeHolding(
  state: PortfolioState,
  symbol: AssetSymbol,
): Result<PortfolioState, NotFoundError> {
  if (!state.holdings.has(symbol)) {
    return err(new NotFoundError(symbol));
  }

  const holdings = copyHoldings(state);
  holdings.delete(symbol);

  const transactions = state.transactions.filter((transaction) => transaction.symbol !== symbol);

  return ok({ holdings, transactions });
}

/**
 * Returns every Holding currently in the Portfolio, or an empty array when
 * there are none (Req 1.8).
 */
export function listHoldings(state: PortfolioState): Holding[] {
  return [...state.holdings.values()];
}
