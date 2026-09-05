/**
 * @jest-environment jsdom
 */

/**
 * Unit tests for the base Portfolio_Overview_View rendering behavior
 * implemented by task 5.1: fetch-on-init, rendering every Holding's fields
 * and the Portfolio_Value, the empty state, the load-failure message, and
 * re-rendering on a `portfolioChanged` event.
 *
 * `apiClient` is mocked via `jest.spyOn` (the pattern this repo already uses
 * for mocking a sibling module's exports, see `test/persistence/atomic-write.test.ts`),
 * so no real `fetch` call is made. `portfolioEvents` is used for real so that
 * publishing `portfolioChanged` exercises the same subscription path a real
 * mutating view would trigger.
 *
 * These tests intentionally only assert on the fields task 5.1 owns (symbol,
 * quantity, current price, holding value, portfolio value, empty state, and
 * error state) and make no assumption about the contents of the
 * `holding-actions` cell, which later tasks (5.3, 5.5, 5.7) populate.
 *
 * **Validates: Requirements 1.2, 1.3, 1.4, 1.5**
 */

import * as apiClient from '../../../src/frontend/apiClient';
import * as portfolioEvents from '../../../src/frontend/portfolioEvents';
import { init } from '../../../src/frontend/views/overviewView';

import type { PortfolioOverviewResponse } from '../../../src/frontend/types';

function sampleOverview(): PortfolioOverviewResponse {
  return {
    holdings: [
      { symbol: 'BTC', quantity: '1.5', currentPrice: '50000', holdingValue: '75000' },
      { symbol: 'ETH', quantity: '10', currentPrice: '3000', holdingValue: '30000' },
    ],
    portfolioValue: '105000',
  };
}

function emptyOverview(): PortfolioOverviewResponse {
  return { holdings: [], portfolioValue: '0' };
}

/** Flushes the microtask queue so the async fetch-and-render sequence completes. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('overviewView', () => {
  let getOverviewSpy: jest.SpiedFunction<typeof apiClient.getOverview>;

  beforeEach(() => {
    getOverviewSpy = jest.spyOn(apiClient, 'getOverview');
  });

  it("renders every Holding's fields and the Portfolio_Value from a sample response", async () => {
    getOverviewSpy.mockResolvedValue({ ok: true, value: sampleOverview() });

    const container = document.createElement('div');
    init(container);
    await flush();

    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);

    const btcRow = container.querySelector('tr[data-symbol="BTC"]');
    expect(btcRow?.querySelector('.holding-symbol')?.textContent).toBe('BTC');
    expect(btcRow?.querySelector('.holding-quantity')?.textContent).toBe('1.5');
    expect(btcRow?.querySelector('.holding-current-price')?.textContent).toBe('50000');
    expect(btcRow?.querySelector('.holding-value')?.textContent).toBe('75000');

    const ethRow = container.querySelector('tr[data-symbol="ETH"]');
    expect(ethRow?.querySelector('.holding-symbol')?.textContent).toBe('ETH');
    expect(ethRow?.querySelector('.holding-quantity')?.textContent).toBe('10');
    expect(ethRow?.querySelector('.holding-current-price')?.textContent).toBe('3000');
    expect(ethRow?.querySelector('.holding-value')?.textContent).toBe('30000');

    expect(container.querySelector('.portfolio-value')?.textContent).toBe('Portfolio value: 105000');
  });

  it('renders the empty-state message and zero Portfolio_Value for an empty response', async () => {
    getOverviewSpy.mockResolvedValue({ ok: true, value: emptyOverview() });

    const container = document.createElement('div');
    init(container);
    await flush();

    expect(container.querySelector('.empty-state')?.textContent).toBe('This portfolio has no holdings yet.');
    expect(container.querySelector('.portfolio-value')?.textContent).toBe('Portfolio value: 0');
    expect(container.querySelector('table')).toBeNull();
  });

  it('renders the load-failure message on an ApiError', async () => {
    getOverviewSpy.mockResolvedValue({
      ok: false,
      error: { kind: 'ApiError', status: 500, code: 'InternalError', message: 'Something went wrong on the server.' },
    });

    const container = document.createElement('div');
    init(container);
    await flush();

    expect(container.querySelector('.error-message')?.textContent).toBe(
      'The portfolio overview could not be loaded: Something went wrong on the server.',
    );
  });

  it('re-renders after a portfolioChanged event', async () => {
    getOverviewSpy.mockResolvedValue({ ok: true, value: emptyOverview() });

    const container = document.createElement('div');
    init(container);
    await flush();

    expect(container.querySelector('.empty-state')).not.toBeNull();

    getOverviewSpy.mockResolvedValue({ ok: true, value: sampleOverview() });

    portfolioEvents.publish();
    await flush();

    expect(container.querySelector('.empty-state')).toBeNull();
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.querySelector('.portfolio-value')?.textContent).toBe('Portfolio value: 105000');
  });
});
