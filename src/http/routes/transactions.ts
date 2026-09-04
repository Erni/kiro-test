import { Router } from 'express';

import { sendDomainError } from '../errorMapping';

import type { Transaction } from '../../domain/types';
import type { PortfolioService } from '../../service/portfolioService';
import type { Request } from 'express';

/**
 * Transaction routes: `POST /transactions`, `GET /transactions/:symbol`
 * (Req 2.1-2.9).
 *
 * Same shape as the holdings router: each handler shapes the request into the
 * service's input type, awaits the service, and renders the `Result`. No
 * validation and no branching on *why* an operation failed happens here — the
 * domain validators own what a valid Transaction_Type, quantity, and price per
 * unit are (Req 2.5, 2.6), and {@link sendDomainError} owns the status codes,
 * including the 409 that distinguishes a Sell exceeding the position on hand
 * (Req 2.4) from a malformed request.
 *
 * Paths are declared in full inside the router rather than via a mount prefix,
 * matching the other route modules (see the note in `app.ts`).
 *
 * Handlers are `async` and are allowed to reject: Express 5 forwards a rejected
 * handler promise to the error boundary in `app.ts`, so an unexpected throw
 * becomes a 500 there rather than needing a `try`/`catch` per route.
 */
export function createTransactionsRouter(service: PortfolioService): Router {
  const router = Router();

  /**
   * Records a Buy or Sell Transaction and applies its effect on the Holding
   * (Req 2.1, 2.2, 2.3, 2.7).
   *
   * 201 with the Transaction as recorded, so the response carries the id and
   * the timestamp the System assigned (Req 2.9) rather than an echo of the
   * request. The symbol comes from the body, not the path: a Transaction is
   * created as a new resource in its own collection, and its symbol is one of
   * its fields — including for a symbol with no Holding, which a Buy creates
   * (Req 2.3).
   *
   * `Location` points at the symbol's history, which is where the new
   * Transaction is retrievable; individual Transactions have no endpoint of
   * their own.
   *
   * The Holding change is not returned. It is derivable from the Transaction
   * plus `GET /holdings`, and a Sell that took the position to zero leaves no
   * Holding to return at all (Req 2.7), so the Transaction is the one thing
   * every outcome has in common.
   */
  router.post('/transactions', async (req, res) => {
    const body = requestBody(req);

    const result = await service.recordTransaction({
      symbol: body['symbol'],
      type: body['type'],
      quantity: body['quantity'],
      pricePerUnit: body['pricePerUnit'],
    });

    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }

    res
      .status(201)
      .location(transactionHistoryPath(result.value.symbol))
      .json(serializeTransaction(result.value));
  });

  /**
   * Returns every Transaction recorded for a symbol, oldest first (Req 2.8). A
   * read, so it cannot fail with a domain error.
   *
   * Never 404s: a symbol with no Holding can still have history — a Sell to
   * zero removes the Holding but keeps its Transactions (Req 2.7) — so an
   * absent Holding is not an absent history. A symbol nothing was ever recorded
   * for gets an empty list, matching how `GET /holdings` answers for an empty
   * Portfolio.
   *
   * The symbol is used exactly as it appears in the path, with no
   * normalization, so `/transactions/btc` correctly reports no history rather
   * than silently resolving to `BTC`.
   */
  router.get('/transactions/:symbol', async (req, res) => {
    const transactions = await service.getTransactionHistory(req.params.symbol);

    res.status(200).json({ transactions: transactions.map(serializeTransaction) });
  });

  return router;
}

/** A Transaction as returned by this API. */
interface TransactionResponse {
  readonly id: string;
  readonly symbol: string;
  readonly type: string;
  /** Decimal in plain notation, e.g. `"0.00000001"`. */
  readonly quantity: string;
  /** Decimal in plain notation. */
  readonly pricePerUnit: string;
  /** ISO 8601 instant in UTC, e.g. `"2024-01-31T12:00:00.000Z"`. */
  readonly timestamp: string;
}

/**
 * Renders a Transaction for the wire.
 *
 * Quantities and prices are strings, never JSON numbers, for the same reason as
 * in the holdings router: a JSON number would push each value through an
 * IEEE-754 double on the way out and silently lose precision the rest of the
 * system takes care to preserve. `toFixed()` keeps the plain form, so a small
 * quantity reads as `"0.00000001"` instead of `"1e-8"`.
 *
 * The timestamp is an ISO 8601 string in UTC. It is what clients sort history
 * by (Req 2.8), so it has to survive the round trip unambiguously — a
 * locale-dependent or offset-free rendering would not.
 */
function serializeTransaction(transaction: Transaction): TransactionResponse {
  return {
    id: transaction.id,
    symbol: transaction.symbol,
    type: transaction.type,
    quantity: transaction.quantity.toFixed(),
    pricePerUnit: transaction.pricePerUnit.toFixed(),
    timestamp: transaction.timestamp.toISOString(),
  };
}

/** The path of the Transaction history for `symbol`. */
function transactionHistoryPath(symbol: string): string {
  return `/transactions/${encodeURIComponent(symbol)}`;
}

/**
 * The parsed request body as a field bag.
 *
 * `express.json()` leaves `req.body` as whatever the client sent, which may be
 * a JSON array, string, number, or nothing at all. Anything that is not an
 * object has no fields to read, so it is treated as an empty body: the missing
 * fields then fail domain validation and produce the same field-level 400 as an
 * explicitly invalid value (Req 2.5, 2.6), instead of a 500 from reading a
 * property off a non-object.
 */
function requestBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {};
  }
  return body as Record<string, unknown>;
}
