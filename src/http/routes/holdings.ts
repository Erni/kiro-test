import { Router } from 'express';

import { sendDomainError } from '../errorMapping';

import type { Holding } from '../../domain/types';
import type { PortfolioService } from '../../service/portfolioService';
import type { Request } from 'express';

/**
 * Holding CRUD routes: `POST /holdings`, `PUT /holdings/:symbol`,
 * `DELETE /holdings/:symbol`, `GET /holdings` (Req 1.1-1.11).
 *
 * Each handler does exactly three things: shape the request into the service's
 * input type, await the service, and render the `Result`. There is no branching
 * on *why* an operation failed — {@link sendDomainError} owns the status codes —
 * and no validation, because the domain validators are the single authority on
 * what a valid symbol, quantity, or Current_Price is (Req 1.3, 1.4, 1.6, 1.11).
 * Re-checking anything here would create a second, drifting copy of those rules.
 *
 * Paths are declared in full inside the router rather than via a mount prefix,
 * because `/holdings` is shared with `PATCH /holdings/:symbol/price` in
 * `portfolio.ts`.
 *
 * Handlers are `async` and are allowed to reject: Express 5 forwards a rejected
 * handler promise to the error boundary in `app.ts`, so a bug or an unexpected
 * throw becomes a 500 there rather than needing a `try`/`catch` per route.
 */
export function createHoldingsRouter(service: PortfolioService): Router {
  const router = Router();

  /**
   * Creates a Holding (Req 1.1).
   *
   * 201 with the Holding as stored — read back out of the new state by the
   * service, so the response shows what was actually persisted rather than an
   * echo of the request. `Location` points at the created resource, whose
   * identity is its symbol.
   */
  router.post('/holdings', async (req, res) => {
    const body = requestBody(req);

    const result = await service.addHolding({
      symbol: body['symbol'],
      quantity: body['quantity'],
      currentPrice: body['currentPrice'],
    });

    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }

    res
      .status(201)
      .location(holdingPath(result.value.symbol))
      .json(serializeHolding(result.value));
  });

  /**
   * Replaces a Holding's quantity and Current_Price (Req 1.5).
   *
   * `PUT` rather than `PATCH` because both fields are always required and the
   * Holding is fully specified by them plus its symbol — which comes from the
   * path and is therefore not read from the body. A body symbol is ignored, so
   * the URL is the only thing that can decide which Holding is addressed.
   *
   * The symbol is used exactly as it appears in the path, with no
   * normalization: symbols are stored as submitted (uppercase, per Req 1.1), so
   * `/holdings/btc` correctly addresses nothing and gets a 404 (Req 1.9) rather
   * than silently resolving to `BTC`.
   */
  router.put('/holdings/:symbol', async (req, res) => {
    const body = requestBody(req);

    const result = await service.updateHolding(req.params.symbol, {
      quantity: body['quantity'],
      currentPrice: body['currentPrice'],
    });

    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }

    res.status(200).json(serializeHolding(result.value));
  });

  /**
   * Deletes a Holding and every Transaction recorded for it (Req 1.7), or 404s
   * when no such Holding exists (Req 1.10).
   *
   * 204 with no body: the resource is gone, so there is nothing left to
   * represent.
   */
  router.delete('/holdings/:symbol', async (req, res) => {
    const result = await service.removeHolding(req.params.symbol);

    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }

    res.status(204).end();
  });

  /**
   * Lists every Holding in the Portfolio, or an empty list when there are none
   * (Req 1.8). A read, so it cannot fail with a domain error.
   *
   * The collection is wrapped in an object rather than returned as a bare JSON
   * array, matching the shape of `GET /portfolio/overview`, which pairs the same
   * list with a total.
   */
  router.get('/holdings', async (_req, res) => {
    const holdings = await service.listHoldings();

    res.status(200).json({ holdings: holdings.map(serializeHolding) });
  });

  return router;
}

/** A Holding as returned by this API. */
interface HoldingResponse {
  readonly symbol: string;
  /** Decimal in plain notation, e.g. `"0.00000001"`. */
  readonly quantity: string;
  /** Decimal in plain notation. */
  readonly currentPrice: string;
}

/**
 * Renders a Holding for the wire.
 *
 * Quantities and prices are strings, never JSON numbers: the domain handles
 * 12-digit values with 8 decimal places exactly, and a JSON number would push
 * each one through an IEEE-754 double on the way out (and again in any client
 * that parses it), silently losing precision the rest of the system takes care
 * to preserve. `toFixed()` rather than `toString()` keeps the plain form, so a
 * small quantity reads as `"0.00000001"` instead of `"1e-8"`.
 */
function serializeHolding(holding: Holding): HoldingResponse {
  return {
    symbol: holding.symbol,
    quantity: holding.quantity.toFixed(),
    currentPrice: holding.currentPrice.toFixed(),
  };
}

/** The canonical path of the Holding for `symbol`. */
function holdingPath(symbol: string): string {
  return `/holdings/${encodeURIComponent(symbol)}`;
}

/**
 * The parsed request body as a field bag.
 *
 * `express.json()` leaves `req.body` as whatever the client sent, which may be
 * a JSON array, string, number, or nothing at all. Anything that is not an
 * object has no fields to read, so it is treated as an empty body: the missing
 * fields then fail domain validation and produce the same field-level 400 as an
 * explicitly invalid value (Req 1.3, 1.4, 1.6, 1.11), instead of a 500 from
 * reading a property off a non-object.
 */
function requestBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {};
  }
  return body as Record<string, unknown>;
}
