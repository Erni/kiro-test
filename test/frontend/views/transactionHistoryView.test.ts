/** @jest-environment jsdom */

import * as apiClient from '../../../src/frontend/apiClient';
import { init } from '../../../src/frontend/views/transactionHistoryView';

import type { ApiResult } from '../../../src/frontend/apiClient';
import type { TransactionResponse } from '../../../src/frontend/types';

/**
 * Unit tests for the Transaction history view (task 9.2).
 *
 * `apiClient.getTransactionHistory` is stubbed with `jest.spyOn` (this
 * repo's established convention for faking a single function, e.g.
 * `test/frontend/views/transactionForm.test.ts`), so the test drives the
 * real form markup and submit handling in `transactionHistoryView.ts` end
 * to end and only fakes the network boundary.
 *
 * **Validates: Requirements 6.2, 6.3, 6.4**
 */
describe('transactionHistoryView', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    init(container);
  });

  afterEach(() => {
    container.remove();
  });

  /** Fills in the symbol input and submits the lookup form. */
  function lookup(symbol: string): void {
    const symbolInput = container.querySelector<HTMLInputElement>('input[name="symbol"]');
    const form = container.querySelector<HTMLFormElement>('form');

    if (!symbolInput || !form) {
      throw new Error('transaction history lookup form did not render as expected');
    }

    symbolInput.value = symbol;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
  }

  it('renders the returned Transactions in the exact order the backend returned them', async () => {
    // Req 6.2
    const tx1: TransactionResponse = {
      id: 'txn-1',
      symbol: 'BTC',
      type: 'Buy',
      quantity: '1',
      pricePerUnit: '50000',
      timestamp: '2024-01-31T12:00:00.000Z',
    };
    const tx2: TransactionResponse = {
      id: 'txn-2',
      symbol: 'BTC',
      type: 'Sell',
      quantity: '0.5',
      pricePerUnit: '55000',
      timestamp: '2024-02-15T08:30:00.000Z',
    };
    jest.spyOn(apiClient, 'getTransactionHistory').mockResolvedValue({ ok: true, value: { transactions: [tx1, tx2] } });

    lookup('BTC');
    await flushPromises();

    expect(apiClient.getTransactionHistory).toHaveBeenCalledWith('BTC');

    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);

    const firstRowCells = rows[0]?.querySelectorAll('td') ?? [];
    expect(firstRowCells[0]?.textContent).toBe('Buy');
    expect(firstRowCells[1]?.textContent).toBe('1');
    expect(firstRowCells[2]?.textContent).toBe('50000');

    const secondRowCells = rows[1]?.querySelectorAll('td') ?? [];
    expect(secondRowCells[0]?.textContent).toBe('Sell');
    expect(secondRowCells[1]?.textContent).toBe('0.5');
    expect(secondRowCells[2]?.textContent).toBe('55000');
  });

  it('renders the empty-state message and no table when no Transactions are returned', async () => {
    // Req 6.3
    jest.spyOn(apiClient, 'getTransactionHistory').mockResolvedValue({ ok: true, value: { transactions: [] } });

    lookup('ETH');
    await flushPromises();

    const emptyState = container.querySelector<HTMLElement>('.empty-state');
    expect(emptyState?.textContent).toBe('No transactions found for this symbol.');
    expect(container.querySelector('table')).toBeNull();
  });

  it('renders the returned error message on failure, without a table or empty-state message', async () => {
    // Req 6.4
    jest.spyOn(apiClient, 'getTransactionHistory').mockResolvedValue({
      ok: false,
      error: { kind: 'ApiError', status: 404, code: 'NotFoundError', message: 'No cryptoasset found for symbol DOGE' },
    } as ApiResult<{ transactions: TransactionResponse[] }>);

    lookup('DOGE');
    await flushPromises();

    const errorMessage = container.querySelector<HTMLElement>('.error-message');
    expect(errorMessage?.textContent).toBe('No cryptoasset found for symbol DOGE');
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('.empty-state')).toBeNull();
  });
});

/** Waits for any pending promise microtasks (e.g. the form's `.then` chain) to settle. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
