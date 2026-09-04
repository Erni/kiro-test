import { NotFoundError } from './errors';
import { err, ok } from './result';

import type { Result } from './result';
import type {
  Holding,
  PortfolioState,
  Symbol as AssetSymbol,
  ValidPriceUpdateInput,
} from './types';

/**
 * Current_Price updates (Req 4.1, 4.3).
 *
 * Like the other state transitions, `updatePrice` is pure: the input
 * `PortfolioState` is never mutated and a brand-new state is returned with fresh
 * `holdings` map and `transactions` array instances, so the caller can keep its
 * old reference as the rollback value when persistence fails (Req 5.4).
 *
 * Inputs arrive already validated as `ValidPriceUpdateInput` from
 * `validation.ts` (Req 4.2), so the only failure left is the state-dependent
 * one: no Holding for the symbol.
 */

/**
 * Replaces an existing Holding's Current_Price with the submitted value,
 * leaving its quantity unchanged (Req 4.1).
 *
 * Rejects with `NotFoundError` when no Holding exists for the symbol (Req 4.3);
 * in that case nothing about the state is touched, so a rejected update cannot
 * leave a stale price behind. Transactions are untouched as well: revising a
 * price quote is not a position change and records no history.
 */
export function updatePrice(
  state: PortfolioState,
  symbol: AssetSymbol,
  input: ValidPriceUpdateInput,
): Result<PortfolioState, NotFoundError> {
  const existing = state.holdings.get(symbol);
  if (existing === undefined) {
    return err(new NotFoundError(symbol));
  }

  const updated: Holding = {
    symbol: existing.symbol,
    quantity: existing.quantity,
    currentPrice: input.currentPrice,
  };

  const holdings = new Map(state.holdings);
  holdings.set(existing.symbol, updated);

  return ok({ holdings, transactions: [...state.transactions] });
}
