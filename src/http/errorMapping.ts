import {
  DuplicateHoldingError,
  InsufficientQuantityError,
  NotFoundError,
  PersistenceError,
  ValidationError,
} from '../domain/errors';

import type { ErrorRequestHandler, RequestHandler, Response } from 'express';

/**
 * The single place where domain failures become HTTP responses.
 *
 * The HTTP layer holds no business logic, so its only real job on the failure
 * path is this translation. Keeping it in one module rather than inline in each
 * route handler is what makes the mapping documented in the design (Req 1.2,
 * 1.3, 1.4, 1.6, 1.9, 1.10, 1.11, 2.4, 2.5, 2.6, 4.2, 4.3, 5.4) a single fact
 * about the system instead of something each route restates and can get wrong.
 *
 * Mapping is driven by each error's `kind` discriminant rather than by
 * `instanceof` chains, so adding a domain error surfaces as a compile error in
 * {@link STATUS_BY_KIND} rather than as a silent 500 at runtime.
 */

/**
 * The domain errors a `PortfolioService` operation can return, and therefore
 * the ones this module has to map.
 *
 * `StartupError` is deliberately absent: a failure to load the persisted
 * Portfolio stops the process before any route is served (Req 5.6), so it never
 * reaches a response.
 */
export type HttpDomainError =
  | ValidationError
  | DuplicateHoldingError
  | NotFoundError
  | InsufficientQuantityError
  | PersistenceError;

/**
 * Status code per domain error, exactly as documented in the design's Error
 * Handling table.
 *
 * `DuplicateHoldingError` and `InsufficientQuantityError` both map to 409: each
 * describes a well-formed request that conflicts with the current state of the
 * Portfolio, as opposed to a malformed one (400) or one naming something that
 * does not exist (404).
 */
const STATUS_BY_KIND: Readonly<Record<HttpDomainError['kind'], number>> = {
  ValidationError: 400,
  DuplicateHoldingError: 409,
  NotFoundError: 404,
  InsufficientQuantityError: 409,
  PersistenceError: 500,
};

/** Code returned for a failure that is not an expected domain outcome. */
const INTERNAL_ERROR_CODE = 'InternalError';

/**
 * Code reported for a request body that could not be parsed. Typed against the
 * domain kinds so it stays in step with `ValidationError`: an unparseable body
 * is reported as the same class of failure as an invalid field.
 */
const VALIDATION_ERROR_CODE: HttpDomainError['kind'] = 'ValidationError';

/** Code returned when no route matches the request. */
const ROUTE_NOT_FOUND_CODE = 'RouteNotFound';

/**
 * Every error response the API emits has this shape, whatever went wrong, so a
 * client can parse failures without branching on the status code first.
 *
 * `code` is the domain error's `kind` for expected outcomes, letting a client
 * distinguish the two 409s from each other without matching on message text.
 * `field` is present only for a `ValidationError`, carrying the field-level
 * detail the design calls for.
 */
export interface ErrorResponseBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly field?: string;
  };
}

/** The HTTP status code documented for `error`. */
export function statusCodeFor(error: HttpDomainError): number {
  return STATUS_BY_KIND[error.kind];
}

/** The response body documented for `error`. */
export function errorResponseBody(error: HttpDomainError): ErrorResponseBody {
  if (error.kind === 'ValidationError') {
    return { error: { code: error.kind, message: error.message, field: error.field } };
  }
  return { error: { code: error.kind, message: error.message } };
}

/**
 * Writes `error` to the response with its documented status code and body.
 *
 * Route handlers call this on the `!result.ok` branch, which is why they never
 * need to know a status code themselves.
 */
export function sendDomainError(res: Response, error: HttpDomainError): void {
  res.status(statusCodeFor(error)).json(errorResponseBody(error));
}

/** True when `value` is a domain error this module knows how to map. */
export function isHttpDomainError(value: unknown): value is HttpDomainError {
  return (
    value instanceof ValidationError ||
    value instanceof DuplicateHoldingError ||
    value instanceof NotFoundError ||
    value instanceof InsufficientQuantityError ||
    value instanceof PersistenceError
  );
}

/**
 * Terminal handler for requests that matched no route, so an unknown path gets
 * the same JSON error shape as every other failure instead of Express's default
 * HTML page.
 */
export const notFoundHandler: RequestHandler = (req, res) => {
  const body: ErrorResponseBody = {
    error: {
      code: ROUTE_NOT_FOUND_CODE,
      message: `No route for ${req.method} ${req.path}`,
    },
  };
  res.status(404).json(body);
};

/**
 * The app's error boundary: the last middleware, catching anything thrown or
 * rejected rather than returned as a `Result`.
 *
 * Three cases arrive here:
 *
 * - A domain error that was thrown instead of returned — mapped exactly as if it
 *   had come back in a `Result`, so the status code cannot depend on which
 *   mechanism carried it.
 * - A malformed or oversized request body, rejected by `express.json()` before
 *   any handler ran. Body parsing is part of accepting the request, so a body
 *   that is not JSON at all is reported as a validation failure on `body` —
 *   consistent with how a body that *is* JSON but has an invalid field is
 *   reported by the domain validators (Req 1.3, 1.4, 1.6, 1.11, 2.5, 2.6, 4.2).
 * - Anything else, which is a bug rather than an expected outcome. It becomes a
 *   500 with a generic message: the internal detail is logged, not returned,
 *   since it can name internal paths and is of no use to the caller.
 */
export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  // Once the response has started there is no status line left to change, so
  // the only correct move is to let Express tear the connection down.
  if (res.headersSent) {
    next(error);
    return;
  }

  if (isHttpDomainError(error)) {
    sendDomainError(res, error);
    return;
  }

  const malformedBody = bodyParseFailure(error);
  if (malformedBody !== undefined) {
    res.status(malformedBody.status).json({
      error: {
        code: VALIDATION_ERROR_CODE,
        message: malformedBody.message,
        field: 'body',
      },
    } satisfies ErrorResponseBody);
    return;
  }

  console.error('Unhandled error while serving a request:', error);
  res.status(500).json({
    error: { code: INTERNAL_ERROR_CODE, message: 'An unexpected error occurred' },
  } satisfies ErrorResponseBody);
};

/**
 * Recognizes a body-parsing rejection from `express.json()`.
 *
 * Those errors are identified by body-parser's own `type` marker (e.g.
 * `entity.parse.failed`, `entity.too.large`) together with a client-side
 * `status`, rather than by message text. Their status is honoured as given so an
 * oversized body still reports 413 rather than being flattened into 400.
 *
 * @returns the status and message to report, or `undefined` when `error` is not
 *   a body-parsing failure.
 */
function bodyParseFailure(error: unknown): { status: number; message: string } | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const candidate = error as { type?: unknown; status?: unknown; message?: unknown };
  const isBodyParserError =
    typeof candidate.type === 'string' && candidate.type.startsWith('entity.');
  const status = candidate.status;
  const isClientStatus = typeof status === 'number' && status >= 400 && status < 500;

  if (!isBodyParserError || !isClientStatus) {
    return undefined;
  }

  return {
    status,
    message:
      typeof candidate.message === 'string' && candidate.message !== ''
        ? candidate.message
        : 'Request body could not be parsed',
  };
}
