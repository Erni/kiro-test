import type { PortfolioState } from '../../src/domain/types';
import type { Result } from '../../src/domain/result';
import type { PortfolioRepository } from '../../src/persistence/portfolioRepository';
import { PortfolioService } from '../../src/service/portfolioService';

/**
 * `PortfolioService` read-only operations (Req 1.8, 2.8, 3.1, 3.2, 3.3, 3.4).
 *
 * The domain rules behind these reads — which Holdings are listed, how history
 * is ordered, how a Holding_Value is computed — are covered where they are
 * implemented. What is only observable here is that the service serves them
 * from the state it currently holds: reads must reflect everything the
 * mutating operations have persisted so far, and nothing they have not.
 *
 * An in-memory repository stands in for the JSON file: reads never touch it,
 * and the writes used to arrange state only need `save()` to resolve.
 */
describe('PortfolioService read-only operations', () => {
  let service: PortfolioService;

  beforeEach(() => {
    service = new PortfolioService(new InMemoryRepository(), emptyState());
  });

  describe('listHoldings', () => {
    it('returns an empty array for an empty Portfolio', async () => {
      await expect(service.listHoldings()).resolves.toEqual([]);
    });

    it('reflects the Holdings as of the call', async () => {
      expectOk(await service.addHolding({ symbol: 'BTC', quantity: '1.5', currentPrice: '50000' }));
      expectOk(await service.addHolding({ symbol: 'ETH', quantity: '10', currentPrice: '3000' }));
      expectOk(await service.removeHolding('BTC'));

      const holdings = await service.listHoldings();

      expect(holdings.map((holding) => holding.symbol)).toEqual(['ETH']);
      expect(holdings[0]?.quantity.toFixed()).toBe('10');
    });
  });

  describe('getTransactionHistory', () => {
    it('returns every Transaction recorded for the symbol, oldest first', async () => {
      expectOk(await service.recordTransaction(buy('BTC', '1')));
      expectOk(await service.recordTransaction(buy('ETH', '5')));
      expectOk(await service.recordTransaction(buy('BTC', '2')));

      const history = await service.getTransactionHistory('BTC');

      expect(history.map((entry) => entry.quantity.toFixed())).toEqual(['1', '2']);
      expect(history[0]?.timestamp.getTime()).toBeLessThanOrEqual(
        history[1]?.timestamp.getTime() ?? 0,
      );
    });

    it('still returns the history of a symbol whose Holding was sold down to zero', async () => {
      expectOk(await service.recordTransaction(buy('BTC', '1')));
      expectOk(
        await service.recordTransaction({
          symbol: 'BTC',
          type: 'Sell',
          quantity: '1',
          pricePerUnit: '51000',
        }),
      );

      await expect(service.listHoldings()).resolves.toEqual([]);
      await expect(service.getTransactionHistory('BTC')).resolves.toHaveLength(2);
    });

    it('returns an empty array for a symbol with no recorded Transactions', async () => {
      await expect(service.getTransactionHistory('BTC')).resolves.toEqual([]);
    });
  });

  describe('getPortfolioOverview', () => {
    it('reports a zero Portfolio_Value and no Holdings for an empty Portfolio', async () => {
      const overview = await service.getPortfolioOverview();

      expect(overview.holdings).toEqual([]);
      expect(overview.portfolioValue.toFixed()).toBe('0');
    });

    it('values each Holding at quantity times Current_Price and sums them', async () => {
      expectOk(await service.addHolding({ symbol: 'BTC', quantity: '1.5', currentPrice: '50000' }));
      expectOk(await service.addHolding({ symbol: 'ETH', quantity: '10', currentPrice: '3000' }));

      const overview = await service.getPortfolioOverview();

      expect(
        overview.holdings.map((view) => [view.symbol, view.holdingValue.toFixed()]),
      ).toEqual([
        ['BTC', '75000'],
        ['ETH', '30000'],
      ]);
      expect(overview.portfolioValue.toFixed()).toBe('105000');
    });

    it('reflects a repricing that happened after an earlier overview', async () => {
      expectOk(await service.addHolding({ symbol: 'BTC', quantity: '2', currentPrice: '50000' }));
      const before = await service.getPortfolioOverview();

      expectOk(await service.updatePrice('BTC', { currentPrice: '60000' }));
      const after = await service.getPortfolioOverview();

      expect(before.portfolioValue.toFixed()).toBe('100000');
      expect(after.portfolioValue.toFixed()).toBe('120000');
    });
  });
});

/** A repository that simply keeps the last persisted state in memory. */
class InMemoryRepository implements PortfolioRepository {
  private state: PortfolioState = emptyState();

  async load(): Promise<PortfolioState> {
    return this.state;
  }

  async save(state: PortfolioState): Promise<void> {
    this.state = state;
  }
}

function emptyState(): PortfolioState {
  return { holdings: new Map(), transactions: [] };
}

function buy(symbol: string, quantity: string) {
  return { symbol, type: 'Buy', quantity, pricePerUnit: '50000' };
}

/** Unwraps a successful `Result`, failing the test with the error otherwise. */
function expectOk<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`Expected a successful result, got: ${String(result.error)}`);
  }
  return result.value;
}
