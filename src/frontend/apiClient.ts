/**
 * Every HTTP call to the `crypto-portfolio-core` Backend_API. This is the
 * only module that calls `fetch()` — every other frontend module goes
 * through the functions exported here, so there is exactly one place that
 * has to know how to tell a timeout apart from a rejected request or a
 * successful one.
 *
 * Every function below follows the same template: wrap the `fetch` call in
 * an `AbortController` timed out at {@link REQUEST_TIMEOUT_MS}, route the
 * call through `loadingIndicator`'s show/hide (Req 8.1, 8.2), and classify
 * the outcome into exactly one of three buckets:
 *
 * 1. HTTP success (2xx) — parse the JSON body as the typed response.
 * 2. HTTP failure (any 4xx/5xx, the Backend_API's documented error shape) —
 *    parse `{ error: { code, message, field? } }` into an {@link ApiError}.
 * 3. No response at all — `fetch` rejects (offline, DNS, connection
 *    refused) or the timeout fires at 30 s — into a {@link NetworkError}.
 *
 * **Validates: Requirements 1.1, 1.5, 2.2, 2.4, 3.3, 3.5, 4.3, 4.6, 5.2, 5.6,
 * 6.2, 6.4, 7.2, 7.5, 8.1, 8.2, 8.3**
 */

import * as loadingIndicator from './loadingIndicator.js';

import type {
  HoldingResponse,
  HoldingUpdateRequest,
  NewHoldingRequest,
  PortfolioOverviewResponse,
  PriceUpdateRequest,
  TransactionRequest,
  TransactionResponse,
} from './types.js';

/** The outcome of a Backend_API call: either the parsed value or a reason it failed. */
export type ApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ApiError | NetworkError };

/** A response the Backend_API returned and rejected, per its documented error shape. */
export interface ApiError {
  readonly kind: 'ApiError';
  /** 400 / 404 / 409 / 500, as documented in crypto-portfolio-core. */
  readonly status: number;
  /** e.g. "ValidationError", "DuplicateHoldingError". */
  readonly code: string;
  readonly message: string;
  /** Present for a `ValidationError`. */
  readonly field?: string;
}

/** No response was received at all: timeout, DNS failure, connection refused, offline, etc. */
export interface NetworkError {
  readonly kind: 'NetworkError';
}

/** Req 8.3: how long a request is given to complete before it is treated as unreachable. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** The Backend_API's documented shape for a rejected request (see `src/http/errorMapping.ts`). */
interface ErrorResponseBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly field?: string;
  };
}

const JSON_HEADERS: HeadersInit = { 'Content-Type': 'application/json' };

/**
 * Runs one Backend_API call end to end: shows/hides the loading indicator
 * (Req 8.1, 8.2) around the attempt, enforces {@link REQUEST_TIMEOUT_MS}, and
 * classifies the outcome into exactly one of the three buckets described
 * above.
 */
async function request<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  loadingIndicator.requestStarted();
  try {
    let response: Response;
    try {
      response = await fetch(path, { ...init, signal: controller.signal });
    } catch {
      // fetch rejects for exactly the "no response at all" cases: offline,
      // DNS failure, connection refused, or the AbortController firing at
      // the timeout — none of them distinguishable from one another here,
      // and none of them needing to be (Req 8.3).
      return { ok: false, error: { kind: 'NetworkError' } };
    }

    if (response.ok) {
      // A 204 (e.g. holding removal) has no body to parse.
      const value = response.status === 204 ? (undefined as T) : ((await response.json()) as T);
      return { ok: true, value };
    }

    const body = (await response.json()) as ErrorResponseBody;
    return {
      ok: false,
      error:
        body.error.field === undefined
          ? { kind: 'ApiError', status: response.status, code: body.error.code, message: body.error.message }
          : {
              kind: 'ApiError',
              status: response.status,
              code: body.error.code,
              message: body.error.message,
              field: body.error.field,
            },
    };
  } finally {
    clearTimeout(timeoutHandle);
    loadingIndicator.requestFinished();
  }
}

/** `GET /portfolio/overview` (Req 1.1). */
export function getOverview(): Promise<ApiResult<PortfolioOverviewResponse>> {
  return request<PortfolioOverviewResponse>('/portfolio/overview', { method: 'GET' });
}

/** `GET /holdings`. */
export function listHoldings(): Promise<ApiResult<{ holdings: HoldingResponse[] }>> {
  return request<{ holdings: HoldingResponse[] }>('/holdings', { method: 'GET' });
}

/** `POST /holdings` (Req 2.2, 2.4). */
export function addHolding(input: NewHoldingRequest): Promise<ApiResult<HoldingResponse>> {
  return request<HoldingResponse>('/holdings', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
}

/** `PUT /holdings/:symbol` (Req 3.3, 3.5). */
export function updateHolding(symbol: string, input: HoldingUpdateRequest): Promise<ApiResult<HoldingResponse>> {
  return request<HoldingResponse>(`/holdings/${encodeURIComponent(symbol)}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
}

/** `DELETE /holdings/:symbol` (Req 4.3, 4.6). */
export function removeHolding(symbol: string): Promise<ApiResult<void>> {
  return request<void>(`/holdings/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
}

/** `PATCH /holdings/:symbol/price` (Req 7.2, 7.5). */
export function updatePrice(symbol: string, input: PriceUpdateRequest): Promise<ApiResult<HoldingResponse>> {
  return request<HoldingResponse>(`/holdings/${encodeURIComponent(symbol)}/price`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
}

/** `POST /transactions` (Req 5.2, 5.6). */
export function recordTransaction(input: TransactionRequest): Promise<ApiResult<TransactionResponse>> {
  return request<TransactionResponse>('/transactions', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
}

/** `GET /transactions/:symbol` (Req 6.2, 6.4). */
export function getTransactionHistory(symbol: string): Promise<ApiResult<{ transactions: TransactionResponse[] }>> {
  return request<{ transactions: TransactionResponse[] }>(`/transactions/${encodeURIComponent(symbol)}`, {
    method: 'GET',
  });
}
