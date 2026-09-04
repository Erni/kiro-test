import request from 'supertest';

import { Decimal } from '../../src/domain/decimalConfig';
import {
  DuplicateHoldingError,
  InsufficientQuantityError,
  NotFoundError,
  PersistenceError,
  ValidationError,
} from '../../src/domain/errors';
import { err, ok } from '../../src/domain/result';
import { createApp } from '../../src/http/app';

import type { Holding, PortfolioOverview, Transaction } from '../../src/domain/types';
import type { PortfolioService } from '../../src/service/portfolioService';

/**
 * Route-level status-code and response-shape tests (task 11.5).
 *
 * The service is stubbed rather than real, on purpose: what is under test here is
 * the translation between HTTP and `PortfolioService` — which method a route
 * calls, with which arguments, and how each `Result` becomes a status code and a
 * body. Driving a real service through a repository would make these tests
 * depend on domain and persistence behavior that already has its own tests, and
 * would make it impossible to exercise a `PersistenceError` at all.
 *
 * Each route gets one success case and one case per error type it can actually
 * return, per the design's Error Handling table (ValidationError→400,
 * DuplicateHoldingError→409, NotFoundError→404, InsufficientQuantityError→409,
 * PersistenceError→500).
 */

/** The public surface of `PortfolioService`, i.e. what a route can call. */
type ServiceMethods = { [K in keyof PortfolioService]: PortfolioService[K] };

/**
 * A `PortfolioService` with only the methods a test needs.
 *
 * Anything left unstubbed throws, so a route calling a method the test did not
 * expect surfaces as a failure naming that method rather than as a confusing
 * `undefined is not a function`.
 */
function stubService(overrides: Partial<ServiceMethods>): PortfolioService {
  const unexpected =
    (name: keyof ServiceMethods) =>
    (): never => {
      throw new Error(`Route called ${name}, which this test did not stub`);
    };

  const stub: ServiceMethods = {
    addHolding: unexpected('addHolding'),
    updateHolding: unexpected('updateHolding'),
    removeHolding: unexpected('removeHolding'),
    listHoldings: unexpected('listHoldings'),
    recordTransaction: unexpected('recordTransaction'),
    getTransactionHistory: unexpected('getTransactionHistory'),
    getPortfolioOverview: unexpected('getPortfolioOverview'),
    updatePrice: unexpected('updatePrice'),
    ...overrides,
  };

  // The real class has private fields, so a structural stub needs the cast.
  return stub as unknown as PortfolioService;
}

/** A Holding, from plain-notation decimal strings. */
function holding(symbol: string, quantity: string, currentPrice: string): Holding {
  return { symbol, quantity: new Decimal(quantity), currentPrice: new Decimal(currentPrice) };
}

/** A Transaction with a fixed id and timestamp, as the System would have stored it. */
function transaction(
  symbol: string,
  type: Transaction['type'],
  quantity: string,
  pricePerUnit: string,
): Transaction {
  return {
    id: 'txn-1',
    symbol,
    type,
    quantity: new Decimal(quantity),
    pricePerUnit: new Decimal(pricePerUnit),
    timestamp: new Date('2024-01-31T12:00:00.000Z'),
  };
}

/** The overview the domain layer would derive for `holdings`. */
function overviewOf(holdings: readonly Holding[]): PortfolioOverview {
  const views = holdings.map((h) => ({
    symbol: h.symbol,
    quantity: h.quantity,
    currentPrice: h.currentPrice,
    holdingValue: h.quantity.times(h.currentPrice),
  }));

  return {
    holdings: views,
    portfolioValue: views.reduce((sum, v) => sum.plus(v.holdingValue), new Decimal(0)),
  };
}

describe('POST /holdings', () => {
  it('creates a holding and returns it as stored', async () => {
    // Req 1.1
    let received: unknown;
    const service = stubService({
      addHolding: async (input) => {
        received = input;
        return ok(holding('BTC', '0.00000001', '42000.5'));
      },
    });

    const response = await request(createApp(service))
      .post('/holdings')
      .send({ symbol: 'BTC', quantity: '0.00000001', currentPrice: '42000.5' });

    expect(response.status).toBe(201);
    expect(response.headers['location']).toBe('/holdings/BTC');
    expect(response.body).toEqual({
      symbol: 'BTC',
      quantity: '0.00000001',
      currentPrice: '42000.5',
    });
    expect(received).toEqual({
      symbol: 'BTC',
      quantity: '0.00000001',
      currentPrice: '42000.5',
    });
  });

  it('reports an invalid quantity as 400 with the offending field', async () => {
    // Req 1.3
    const service = stubService({
      addHolding: async () => err(new ValidationError('quantity', 'must be greater than 0')),
    });

    const response = await request(createApp(service))
      .post('/holdings')
      .send({ symbol: 'BTC', quantity: '0', currentPrice: '1' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: 'ValidationError',
        message: 'quantity: must be greater than 0',
        field: 'quantity',
      },
    });
  });

  it('reports an already-held symbol as 409', async () => {
    // Req 1.2
    const service = stubService({
      addHolding: async () => err(new DuplicateHoldingError('BTC')),
    });

    const response = await request(createApp(service))
      .post('/holdings')
      .send({ symbol: 'BTC', quantity: '1', currentPrice: '1' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: { code: 'DuplicateHoldingError', message: 'Cryptoasset BTC is already held' },
    });
  });

  it('reports a failure to persist as 500', async () => {
    // Req 5.4
    const service = stubService({
      addHolding: async () => err(new PersistenceError('Unable to persist the portfolio')),
    });

    const response = await request(createApp(service))
      .post('/holdings')
      .send({ symbol: 'BTC', quantity: '1', currentPrice: '1' });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'PersistenceError', message: 'Unable to persist the portfolio' },
    });
  });
});

describe('PUT /holdings/:symbol', () => {
  it('replaces quantity and price, taking the symbol from the path', async () => {
    // Req 1.5
    const calls: unknown[] = [];
    const service = stubService({
      updateHolding: async (symbol, input) => {
        calls.push([symbol, input]);
        return ok(holding('BTC', '2', '43000'));
      },
    });

    const response = await request(createApp(service))
      .put('/holdings/BTC')
      // A body symbol is ignored: the URL decides which Holding is addressed.
      .send({ symbol: 'ETH', quantity: '2', currentPrice: '43000' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ symbol: 'BTC', quantity: '2', currentPrice: '43000' });
    expect(calls).toEqual([['BTC', { quantity: '2', currentPrice: '43000' }]]);
  });

  it('reports an unknown symbol as 404', async () => {
    // Req 1.9
    const service = stubService({
      updateHolding: async () => err(new NotFoundError('btc')),
    });

    // Symbols are stored as submitted, so a lowercase path addresses nothing.
    const response = await request(createApp(service))
      .put('/holdings/btc')
      .send({ quantity: '2', currentPrice: '43000' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'NotFoundError', message: 'Holding for btc does not exist' },
    });
  });

  it('reports an invalid price as 400', async () => {
    // Req 1.6
    const service = stubService({
      updateHolding: async () => err(new ValidationError('currentPrice', 'must be numeric')),
    });

    const response = await request(createApp(service))
      .put('/holdings/BTC')
      .send({ quantity: '2', currentPrice: 'abc' });

    expect(response.status).toBe(400);
    expect(response.body.error.field).toBe('currentPrice');
  });
});

describe('DELETE /holdings/:symbol', () => {
  it('removes the holding and answers with no content', async () => {
    // Req 1.7
    const removed: string[] = [];
    const service = stubService({
      removeHolding: async (symbol) => {
        removed.push(symbol);
        return ok(undefined);
      },
    });

    const response = await request(createApp(service)).delete('/holdings/BTC');

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(removed).toEqual(['BTC']);
  });

  it('reports an unknown symbol as 404', async () => {
    // Req 1.10
    const service = stubService({
      removeHolding: async () => err(new NotFoundError('ETH')),
    });

    const response = await request(createApp(service)).delete('/holdings/ETH');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NotFoundError');
  });
});

describe('GET /holdings', () => {
  it('returns every holding, decimals as strings', async () => {
    // Req 1.8
    const service = stubService({
      listHoldings: async () => [holding('BTC', '1.5', '42000'), holding('ETH', '10', '2500')],
    });

    const response = await request(createApp(service)).get('/holdings');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      holdings: [
        { symbol: 'BTC', quantity: '1.5', currentPrice: '42000' },
        { symbol: 'ETH', quantity: '10', currentPrice: '2500' },
      ],
    });
  });

  it('returns an empty list for an empty portfolio', async () => {
    // Req 1.8
    const service = stubService({ listHoldings: async () => [] });

    const response = await request(createApp(service)).get('/holdings');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ holdings: [] });
  });
});

describe('POST /transactions', () => {
  it('records a transaction and returns it with its id and timestamp', async () => {
    // Req 2.1, 2.9
    let received: unknown;
    const service = stubService({
      recordTransaction: async (input) => {
        received = input;
        return ok(transaction('BTC', 'Buy', '0.5', '42000'));
      },
    });

    const response = await request(createApp(service))
      .post('/transactions')
      .send({ symbol: 'BTC', type: 'Buy', quantity: '0.5', pricePerUnit: '42000' });

    expect(response.status).toBe(201);
    expect(response.headers['location']).toBe('/transactions/BTC');
    expect(response.body).toEqual({
      id: 'txn-1',
      symbol: 'BTC',
      type: 'Buy',
      quantity: '0.5',
      pricePerUnit: '42000',
      timestamp: '2024-01-31T12:00:00.000Z',
    });
    expect(received).toEqual({
      symbol: 'BTC',
      type: 'Buy',
      quantity: '0.5',
      pricePerUnit: '42000',
    });
  });

  it('reports a sell beyond the position on hand as 409', async () => {
    // Req 2.4
    const service = stubService({
      recordTransaction: async () =>
        err(new InsufficientQuantityError('BTC', new Decimal('2'), new Decimal('1'))),
    });

    const response = await request(createApp(service))
      .post('/transactions')
      .send({ symbol: 'BTC', type: 'Sell', quantity: '2', pricePerUnit: '42000' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: {
        code: 'InsufficientQuantityError',
        message: 'Insufficient quantity of BTC: requested 2, available 1',
      },
    });
  });

  it('reports an unknown transaction type as 400', async () => {
    // Req 2.5
    const service = stubService({
      recordTransaction: async () => err(new ValidationError('type', 'must be "Buy" or "Sell"')),
    });

    const response = await request(createApp(service))
      .post('/transactions')
      .send({ symbol: 'BTC', type: 'Gift', quantity: '1', pricePerUnit: '42000' });

    expect(response.status).toBe(400);
    expect(response.body.error.field).toBe('type');
  });
});

describe('GET /transactions/:symbol', () => {
  it('returns the recorded history for a symbol', async () => {
    // Req 2.8
    const requested: string[] = [];
    const service = stubService({
      getTransactionHistory: async (symbol) => {
        requested.push(symbol);
        return [transaction('BTC', 'Buy', '1', '40000')];
      },
    });

    const response = await request(createApp(service)).get('/transactions/BTC');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      transactions: [
        {
          id: 'txn-1',
          symbol: 'BTC',
          type: 'Buy',
          quantity: '1',
          pricePerUnit: '40000',
          timestamp: '2024-01-31T12:00:00.000Z',
        },
      ],
    });
    expect(requested).toEqual(['BTC']);
  });

  it('returns an empty history rather than 404 for a symbol with no holding', async () => {
    // Req 2.7, 2.8: no Holding is not the same as no history.
    const service = stubService({ getTransactionHistory: async () => [] });

    const response = await request(createApp(service)).get('/transactions/DOGE');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ transactions: [] });
  });
});

describe('GET /portfolio/overview', () => {
  it('returns each holding with its value plus the portfolio value', async () => {
    // Req 3.1, 3.2
    const service = stubService({
      getPortfolioOverview: async () =>
        overviewOf([holding('BTC', '1.5', '42000'), holding('ETH', '10', '2500')]),
    });

    const response = await request(createApp(service)).get('/portfolio/overview');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      holdings: [
        { symbol: 'BTC', quantity: '1.5', currentPrice: '42000', holdingValue: '63000' },
        { symbol: 'ETH', quantity: '10', currentPrice: '2500', holdingValue: '25000' },
      ],
      portfolioValue: '88000',
    });
  });

  it('returns an empty list and a zero value for an empty portfolio', async () => {
    // Req 3.3
    const service = stubService({ getPortfolioOverview: async () => overviewOf([]) });

    const response = await request(createApp(service)).get('/portfolio/overview');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ holdings: [], portfolioValue: '0' });
  });
});

describe('PATCH /holdings/:symbol/price', () => {
  it('reprices the holding and leaves its quantity alone', async () => {
    // Req 4.1
    const calls: unknown[] = [];
    const service = stubService({
      updatePrice: async (symbol, input) => {
        calls.push([symbol, input]);
        return ok(holding('BTC', '1.5', '45000.25'));
      },
    });

    const response = await request(createApp(service))
      .patch('/holdings/BTC/price')
      .send({ currentPrice: '45000.25' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      symbol: 'BTC',
      quantity: '1.5',
      currentPrice: '45000.25',
    });
    expect(calls).toEqual([['BTC', { currentPrice: '45000.25' }]]);
  });

  it('reports a missing price as 400 on that field', async () => {
    // Req 4.2
    const service = stubService({
      updatePrice: async () => err(new ValidationError('currentPrice', 'is required')),
    });

    const response = await request(createApp(service)).patch('/holdings/BTC/price').send({});

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: 'ValidationError',
        message: 'currentPrice: is required',
        field: 'currentPrice',
      },
    });
  });

  it('reports an unknown symbol as 404', async () => {
    // Req 4.3
    const service = stubService({
      updatePrice: async () => err(new NotFoundError('DOGE')),
    });

    const response = await request(createApp(service))
      .patch('/holdings/DOGE/price')
      .send({ currentPrice: '0.1' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'NotFoundError', message: 'Holding for DOGE does not exist' },
    });
  });
});
