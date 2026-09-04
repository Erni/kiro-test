import { Router } from 'express';

import { sendDomainError } from '../errorMapping';

import type { Holding, HoldingView, PortfolioOverview } from '../../domain/types';
import type { PortfolioService } from '../../service/portfolioService';
import type { Request } from 'express';

/**
 * Portfolio overview and price-update routes: `GET /portfolio/overview`
 * (Req 3.1-3.4), `PATCH /holdings/:symbol/price` (Req 4.1-4.3).
 *
 * These two endpoints live together because they are the read and write halves
 * of the same concern: the overview is only as good as the Current_Prices behind
 * it, and repricing is the one operation whose entire purpose is to move the
 * numbers the overview reports. That is why the price route sits here rather
 * than in `holdings.ts` despite sharing the `/holdings` prefix — see the note in
 * `app.ts` on why every router declares full paths instead of using a mount
 * prefix.
 *
 * Same shape as the other route modules: shape the request, await the service,
 * render the `Result`. No validation happens here — the domain validator is the
 * authority on what a valid Current_Price is (Req 4.2) — and no status codes are
 * chosen here either, since {@link sendDomainError} owns the mapping.
 *
 * Handlers are `async` and are allowed to reject: Express 5 forwards a rejected
 * handler promise to the error boundary in `app.ts`, so an unexpected throw
 * becomes a 500 there rather than needing a `try`/`catch` per route.
 */
export function createPortfolioRouter(service: PortfolioService): Router {
  const router = Router();

  /**
   * Returns every Holding with its Holding_Value, plus the Portfolio_Value
   * (Req 3.1, 3.2), or an empty list and a zero total for an empty Portfolio
   * (Req 3.3). A read, so it cannot fail with a domain error.
   *
   * Both values are derived by the domain layer from the state as of this call
   * (Req 3.4), so nothing is cached here and no `If-Modified-Since`-style
   * conditional handling applies — a repeat request after a reprice reports the
   * new numbers.
   *
   * Amounts carry no currency field: the Portfolio has a single
   * Reference_Currency, so every price and value in the response is already
   * expressed in it.
   */
  router.get('/portfolio/overview', async (_req, res) => {
    const overview = await service.getPortfolioOverview();

    res.status(200).json(serializeOverview(overview));
  });

  /**
   * Replaces a Holding's Current_Price, leaving its quantity untouched
   * (Req 4.1), 400s on a missing, non-numeric, or negative price (Req 4.2), and
   * 404s when no Holding exists for the symbol (Req 4.3).
   *
   * `PATCH` rather than `PUT`, because the request carries one field of a
   * Holding and deliberately leaves the quantity alone; `PUT /holdings/:symbol`
   * is the full replacement of both fields.
   *
   * 200 with the repriced Holding as stored — read back out of the new state by
   * the service — so a client can confirm the new price took effect and that the
   * quantity is unchanged, without a follow-up read.
   *
   * The symbol comes from the path and is used exactly as it appears there, with
   * no normalization: symbols are stored as submitted (uppercase, per Req 1.1),
   * so `/holdings/btc/price` correctly 404s rather than silently repricing `BTC`.
   */
  router.patch('/holdings/:symbol/price', async (req, res) => {
    const body = requestBody(req);

    const result = await service.updatePrice(req.params.symbol, {
      currentPrice: body['currentPrice'],
    });

    if (!result.ok) {
      sendDomainError(res, result.error);
      return;
    }

    res.status(200).json(serializeHolding(result.value));
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

/** A Holding plus its derived Holding_Value, as returned by the overview. */
interface HoldingViewResponse extends HoldingResponse {
  /** Decimal in plain notation: `quantity * currentPrice` (Req 3.1). */
  readonly holdingValue: string;
}

/** The Portfolio overview as returned by this API. */
interface PortfolioOverviewResponse {
  readonly holdings: readonly HoldingViewResponse[];
  /** Decimal in plain notation: sum of every Holding_Value (Req 3.2, 3.3). */
  readonly portfolioValue: string;
}

/**
 * Renders the Portfolio overview for the wire.
 *
 * The Portfolio_Value is serialized even when there are no Holdings, so an empty
 * Portfolio answers with `"0"` rather than omitting the field (Req 3.3) — a
 * client never has to treat "absent" as "zero".
 */
function serializeOverview(overview: PortfolioOverview): PortfolioOverviewResponse {
  return {
    holdings: overview.holdings.map(serializeHoldingView),
    portfolioValue: overview.portfolioValue.toFixed(),
  };
}

/**
 * Renders a Holding_Value-bearing Holding view for the wire.
 *
 * Holding_Value is the strongest reason the whole API serializes decimals as
 * strings: it is a product of two values with up to 8 decimal places each, so it
 * can carry up to 16, which a JSON number cannot represent exactly. Sending it
 * as a string preserves the exact figure the domain computed without rounding.
 */
function serializeHoldingView(view: HoldingView): HoldingViewResponse {
  return {
    symbol: view.symbol,
    quantity: view.quantity.toFixed(),
    currentPrice: view.currentPrice.toFixed(),
    holdingValue: view.holdingValue.toFixed(),
  };
}

/**
 * Renders a Holding for the wire.
 *
 * Quantities and prices are strings, never JSON numbers, for the same reason as
 * in the other route modules: a JSON number would push each value through an
 * IEEE-754 double on the way out and silently lose precision the rest of the
 * system takes care to preserve. `toFixed()` keeps the plain form, so a small
 * quantity reads as `"0.00000001"` instead of `"1e-8"`.
 */
function serializeHolding(holding: Holding): HoldingResponse {
  return {
    symbol: holding.symbol,
    quantity: holding.quantity.toFixed(),
    currentPrice: holding.currentPrice.toFixed(),
  };
}

/**
 * The parsed request body as a field bag.
 *
 * `express.json()` leaves `req.body` as whatever the client sent, which may be a
 * JSON array, string, number, or nothing at all. Anything that is not an object
 * has no fields to read, so it is treated as an empty body: the missing
 * `currentPrice` then fails domain validation and produces the same field-level
 * 400 as an explicitly invalid value (Req 4.2), instead of a 500 from reading a
 * property off a non-object.
 */
function requestBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {};
  }
  return body as Record<string, unknown>;
}
