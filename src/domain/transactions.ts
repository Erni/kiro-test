import { randomUUID } from 'node:crypto';

import { Decimal } from './decimalConfig';
import { InsufficientQuantityError } from './errors';
import { err, ok } from './result';

import type { Result } from './result';
import type {
  Holding,
  PortfolioState,
  Symbol as AssetSymbol,
  Transaction,
  ValidTransactionInput,
} from './types';

/**
 * Transaction recording and history (Req 2.1, 2.2, 2.3, 2.4, 2.7, 2.8, 2.9).
 *
 * Like the holding transitions, `applyTransaction` is pure with respect to the
 * `PortfolioState` it is given: the input state is never mutated and a brand-new
 * state is returned, so the caller can keep its old reference as the rollback
 * value if persistence fails (Req 5.4).
 *
 * The Transaction's identity and timestamp are the two pieces of information the
 * System (not the user) supplies (Req 2.9). They are produced by the injectable
 * `newId` / `now` hooks below, which default to a random UUID and the current
 * instant. Injection exists so tests can pin both values; production callers
 * pass nothing.
 *
 * Inputs arrive already validated as `ValidTransactionInput` from
 * `validation.ts`, so the only failure left is the state-dependent one: a Sell
 * larger than the position on hand.
 */

/** System-supplied parts of a Transaction, overridable for deterministic tests. */
export interface ApplyTransactionOptions {
  /** Generates the Transaction's unique id. Defaults to a random UUID. */
  readonly newId?: () => string;
  /** Supplies the recording-time timestamp. Defaults to the current instant. */
  readonly now?: () => Date;
}

/** The new Portfolio state plus the Transaction as it was recorded. */
export interface AppliedTransaction {
  readonly state: PortfolioState;
  readonly transaction: Transaction;
}

/** Copies the holdings map so callers can mutate the copy freely. */
function copyHoldings(state: PortfolioState): Map<AssetSymbol, Holding> {
  return new Map(state.holdings);
}

/**
 * Records a Buy or Sell Transaction and applies its effect on the Holding
 * (Req 2.1, 2.2, 2.3, 2.4, 2.7, 2.9).
 *
 * A Buy increases the Holding's quantity, creating the Holding with its
 * Current_Price set to the Transaction's price per unit when none exists yet
 * (Req 2.3). An existing Holding keeps its Current_Price: a Buy is a position
 * change, not a price quote, and prices are revised through `updatePrice`.
 *
 * A Sell is rejected with `InsufficientQuantityError` when no Holding exists or
 * its quantity is smaller than the Transaction's quantity (Req 2.4). Otherwise
 * the quantity is reduced, and a result of exactly zero removes the Holding from
 * the holdings map (Req 2.7) — but its Transactions, including this final Sell,
 * stay in the transactions list so the history outlives the position (Req 2.8).
 *
 * On success the Transaction is appended to the transactions list, which is
 * append-only; recording order is preserved and used as the tie-breaker when
 * two Transactions share a timestamp.
 */
export function applyTransaction(
  state: PortfolioState,
  input: ValidTransactionInput,
  options: ApplyTransactionOptions = {},
): Result<AppliedTransaction, InsufficientQuantityError> {
  const existing = state.holdings.get(input.symbol);
  const holdings = copyHoldings(state);

  if (input.type === 'Buy') {
    holdings.set(
      input.symbol,
      existing === undefined
        ? {
            symbol: input.symbol,
            quantity: input.quantity,
            currentPrice: input.pricePerUnit,
          }
        : {
            symbol: existing.symbol,
            quantity: existing.quantity.plus(input.quantity),
            currentPrice: existing.currentPrice,
          },
    );
  } else {
    // A missing Holding is "insufficient" with zero available, which is exactly
    // how Req 2.4 groups it with an oversized Sell.
    if (existing === undefined || existing.quantity.lessThan(input.quantity)) {
      const available = existing?.quantity ?? new Decimal(0);
      return err(new InsufficientQuantityError(input.symbol, input.quantity, available));
    }

    const remaining = existing.quantity.minus(input.quantity);
    if (remaining.isZero()) {
      holdings.delete(input.symbol);
    } else {
      holdings.set(existing.symbol, {
        symbol: existing.symbol,
        quantity: remaining,
        currentPrice: existing.currentPrice,
      });
    }
  }

  const transaction: Transaction = {
    id: (options.newId ?? randomUUID)(),
    symbol: input.symbol,
    type: input.type,
    quantity: input.quantity,
    pricePerUnit: input.pricePerUnit,
    timestamp: (options.now ?? (() => new Date()))(),
  };

  return ok({
    state: { holdings, transactions: [...state.transactions, transaction] },
    transaction,
  });
}

/**
 * Returns every Transaction recorded for a symbol, earliest first (Req 2.8).
 *
 * The result is independent of whether a Holding currently exists: Transactions
 * for positions removed by a zero-quantity Sell are still returned, as are those
 * recorded before a symbol was bought again. Sorting is stable, so Transactions
 * sharing a timestamp keep their recording order.
 */
export function transactionHistory(state: PortfolioState, symbol: AssetSymbol): Transaction[] {
  return state.transactions
    .filter((transaction) => transaction.symbol === symbol)
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
}
