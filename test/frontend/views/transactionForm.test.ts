/** @jest-environment jsdom */

import * as apiClient from '../../../src/frontend/apiClient';
import * as portfolioEvents from '../../../src/frontend/portfolioEvents';
import { init } from '../../../src/frontend/views/transactionForm';

import type { ApiResult } from '../../../src/frontend/apiClient';
import type { TransactionResponse } from '../../../src/frontend/types';

/**
 * Unit tests for the Transaction form (task 8.2).
 *
 * `apiClient.recordTransaction` is stubbed with `jest.spyOn` (this repo's
 * established convention for faking a single function, e.g.
 * `test/persistence/atomic-write.test.ts`), so the test drives the real form
 * markup and submit handling in `transactionForm.ts` end to end and only
 * fakes the network boundary.
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.6**
 */
describe('transactionForm', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    init(container);
  });

  afterEach(() => {
    container.remove();
  });

  /** Fills in and submits the form with the given field values. */
  function submitForm(fields: { symbol: string; type: string; quantity: string; pricePerUnit: string }): void {
    const symbolInput = container.querySelector<HTMLInputElement>('#transaction-symbol');
    const typeSelect = container.querySelector<HTMLSelectElement>('#transaction-type');
    const quantityInput = container.querySelector<HTMLInputElement>('#transaction-quantity');
    const priceInput = container.querySelector<HTMLInputElement>('#transaction-price');
    const form = container.querySelector<HTMLFormElement>('#transaction-form');

    if (!symbolInput || !typeSelect || !quantityInput || !priceInput || !form) {
      throw new Error('transaction form did not render as expected');
    }

    symbolInput.value = fields.symbol;
    typeSelect.value = fields.type;
    quantityInput.value = fields.quantity;
    priceInput.value = fields.pricePerUnit;

    form.dispatchEvent(new Event('submit', { cancelable: true }));
  }

  it('shows a confirmation with the submitted fields and publishes portfolioChanged on success', async () => {
    // Req 5.1, 5.2, 5.3, 5.4
    const transaction: TransactionResponse = {
      id: 'txn-1',
      symbol: 'BTC',
      type: 'Buy',
      quantity: '1',
      pricePerUnit: '50000',
      timestamp: '2024-01-31T12:00:00.000Z',
    };
    jest.spyOn(apiClient, 'recordTransaction').mockResolvedValue({ ok: true, value: transaction });
    const publishSpy = jest.spyOn(portfolioEvents, 'publish').mockImplementation(() => undefined);

    submitForm({ symbol: 'BTC', type: 'Buy', quantity: '1', pricePerUnit: '50000' });
    await flushPromises();

    const confirmation = container.querySelector<HTMLElement>('#transaction-confirmation');
    const error = container.querySelector<HTMLElement>('#transaction-error');

    expect(confirmation?.hidden).toBe(false);
    expect(confirmation?.textContent).toContain('Buy');
    expect(confirmation?.textContent).toContain('1');
    expect(confirmation?.textContent).toContain('BTC');
    expect(confirmation?.textContent).toContain('50000');
    expect(error?.hidden).toBe(true);
    expect(publishSpy).toHaveBeenCalledTimes(1);

    expect(apiClient.recordTransaction).toHaveBeenCalledWith({
      symbol: 'BTC',
      type: 'Buy',
      quantity: '1',
      pricePerUnit: '50000',
    });
  });

  it('shows the returned error message on a rejected submission, without a confirmation', async () => {
    // Req 5.6
    jest.spyOn(apiClient, 'recordTransaction').mockResolvedValue({
      ok: false,
      error: { kind: 'ApiError', status: 400, code: 'ValidationError', message: 'quantity must be greater than 0' },
    } as ApiResult<TransactionResponse>);
    const publishSpy = jest.spyOn(portfolioEvents, 'publish').mockImplementation(() => undefined);

    submitForm({ symbol: 'BTC', type: 'Sell', quantity: '0', pricePerUnit: '50000' });
    await flushPromises();

    const confirmation = container.querySelector<HTMLElement>('#transaction-confirmation');
    const error = container.querySelector<HTMLElement>('#transaction-error');

    expect(error?.hidden).toBe(false);
    expect(error?.textContent).toBe('quantity must be greater than 0');
    expect(confirmation?.hidden).toBe(true);
    expect(publishSpy).not.toHaveBeenCalled();
  });
});

/** Waits for any pending promise microtasks (e.g. the form's `.then` chain) to settle. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
