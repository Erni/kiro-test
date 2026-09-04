import express from 'express';
import request from 'supertest';

import { Decimal } from '../../src/domain/decimalConfig';
import {
  DuplicateHoldingError,
  InsufficientQuantityError,
  NotFoundError,
  PersistenceError,
  StartupError,
  ValidationError,
} from '../../src/domain/errors';
import { createApp } from '../../src/http/app';
import {
  errorHandler,
  errorResponseBody,
  isHttpDomainError,
  statusCodeFor,
} from '../../src/http/errorMapping';

import type { HttpDomainError } from '../../src/http/errorMapping';
import type { PortfolioService } from '../../src/service/portfolioService';

/**
 * Task 11.1 covers the app wiring and the error-to-status-code mapping, so these
 * tests exercise exactly that: the mapping table itself, and the app-level
 * boundaries that exist independently of any route (body parsing, unmatched
 * paths, the error handler). Per-route success and failure cases belong to the
 * route tasks and their own test file.
 *
 * The mapping is asserted directly against the design's Error Handling table
 * rather than through a route, so a wrong status code is reported as a mapping
 * failure and not as a route failure.
 */
describe('domain error to HTTP status mapping', () => {
  const cases: ReadonlyArray<{ name: string; error: HttpDomainError; status: number }> = [
    {
      name: 'ValidationError',
      error: new ValidationError('quantity', 'must be greater than 0'),
      status: 400,
    },
    { name: 'DuplicateHoldingError', error: new DuplicateHoldingError('BTC'), status: 409 },
    { name: 'NotFoundError', error: new NotFoundError('ETH'), status: 404 },
    {
      name: 'InsufficientQuantityError',
      error: new InsufficientQuantityError('BTC', new Decimal('2'), new Decimal('1')),
      status: 409,
    },
    { name: 'PersistenceError', error: new PersistenceError('disk full'), status: 500 },
  ];

  it.each(cases)('maps $name to $status', ({ error, status }) => {
    expect(statusCodeFor(error)).toBe(status);
  });

  it.each(cases)('reports $name with its kind as the response code', ({ error }) => {
    const body = errorResponseBody(error);

    expect(body.error.code).toBe(error.kind);
    expect(body.error.message).toBe(error.message);
  });

  it('carries the offending field only for a validation error', () => {
    const validation = errorResponseBody(new ValidationError('currentPrice', 'must be numeric'));
    const notFound = errorResponseBody(new NotFoundError('ETH'));

    expect(validation.error.field).toBe('currentPrice');
    expect(notFound.error).not.toHaveProperty('field');
  });

  it('does not treat a startup error as an HTTP-mappable failure', () => {
    // Req 5.6: a load failure stops startup, so it must never become a response.
    expect(isHttpDomainError(new StartupError('corrupted'))).toBe(false);
    expect(isHttpDomainError(new Error('boom'))).toBe(false);
    expect(isHttpDomainError(new NotFoundError('BTC'))).toBe(true);
  });
});

describe('the app error boundary', () => {
  /**
   * Builds a minimal app whose single route rejects with `thrown`, to check that
   * an error reaching the boundary as an exception is mapped identically to one
   * returned in a `Result`.
   */
  function appThrowing(thrown: unknown): express.Express {
    const app = express();
    app.get('/boom', () => {
      throw thrown;
    });
    app.use(errorHandler);
    return app;
  }

  it('maps a thrown domain error the same way as a returned one', async () => {
    const response = await request(appThrowing(new DuplicateHoldingError('BTC'))).get('/boom');

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: { code: 'DuplicateHoldingError', message: 'Cryptoasset BTC is already held' },
    });
  });

  it('reports an unexpected failure as 500 without leaking its detail', async () => {
    const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await request(appThrowing(new Error('connection string is s3cret'))).get(
      '/boom',
    );

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'InternalError', message: 'An unexpected error occurred' },
    });
    expect(JSON.stringify(response.body)).not.toContain('s3cret');
    expect(logged).toHaveBeenCalled();
  });
});

describe('createApp', () => {
  /**
   * The route modules are stubs at this task, and none of them is reached by the
   * cases below: body parsing fails before routing, and an unmatched path never
   * enters a handler. So no service behavior is needed here.
   */
  const service = {} as PortfolioService;

  it('rejects a malformed JSON body as a validation error on the body', async () => {
    const response = await request(createApp(service))
      .post('/holdings')
      .set('Content-Type', 'application/json')
      .send('{"symbol": "BTC",');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('ValidationError');
    expect(response.body.error.field).toBe('body');
  });

  it('answers an unmatched path with the standard error body', async () => {
    const response = await request(createApp(service)).get('/nope');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'RouteNotFound', message: 'No route for GET /nope' },
    });
  });

  it('does not advertise the framework', async () => {
    const response = await request(createApp(service)).get('/nope');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
