/** @jest-environment jsdom */

import * as apiClient from '../../../src/frontend/apiClient';
import * as portfolioEvents from '../../../src/frontend/portfolioEvents';
import { init } from '../../../src/frontend/views/addHoldingForm';

import type { ApiResult } from '../../../src/frontend/apiClient';
import type { HoldingResponse } from '../../../src/frontend/types';

/**
 * Unit tests for the add-Holding form (task 7.2).
 *
 * `apiClient.addHolding` is stubbed with `jest.spyOn` (this repo's
 * established convention for faking a single function, e.g.
 * `test/frontend/views/transactionForm.test.ts`), so the test drives the
 * real form markup and submit handling in `addHoldingForm.ts` end to end and
 * only fakes the network boundary.
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6**
 */
describe('addHoldingForm', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    init(container);
  });

  afterEach(() => {
    container.remove();
  });

  function elements(): {
    form: HTMLFormElement;
    symbolInput: HTMLInputElement;
    quantityInput: HTMLInputElement;
    currentPriceInput: HTMLInputElement;
    errorMessage: HTMLElement;
  } {
    const form = container.querySelector<HTMLFormElement>('form');
    const symbolInput = container.querySelector<HTMLInputElement>('input[name="symbol"]');
    const quantityInput = container.querySelector<HTMLInputElement>('input[name="quantity"]');
    const currentPriceInput = container.querySelector<HTMLInputElement>('input[name="currentPrice"]');
    const errorMessage = container.querySelector<HTMLElement>('.error-message');

    if (!form || !symbolInput || !quantityInput || !currentPriceInput || !errorMessage) {
      throw new Error('add-holding form did not render as expected');
    }

    return { form, symbolInput, quantityInput, currentPriceInput, errorMessage };
  }

  /** Fills in the form's fields without submitting it. */
  function fillForm(fields: { symbol: string; quantity: string; currentPrice: string }): void {
    const { symbolInput, quantityInput, currentPriceInput } = elements();

    symbolInput.value = fields.symbol;
    quantityInput.value = fields.quantity;
    currentPriceInput.value = fields.currentPrice;
  }

  it('requires a value for symbol, quantity, and currentPrice before it can be submitted', () => {
    // Req 2.1
    const { symbolInput, quantityInput, currentPriceInput } = elements();

    expect(symbolInput.required).toBe(true);
    expect(quantityInput.required).toBe(true);
    expect(currentPriceInput.required).toBe(true);
  });

  it('does not call apiClient.addHolding when required fields are left empty', () => {
    // Req 2.1
    const addHoldingSpy = jest.spyOn(apiClient, 'addHolding');
    const { form } = elements();

    // All three fields are left blank; native constraint validation should
    // report the form as invalid and block requestSubmit() from dispatching
    // a submit event at all.
    expect(form.checkValidity()).toBe(false);

    form.requestSubmit();

    expect(addHoldingSpy).not.toHaveBeenCalled();
  });

  it('sends the expected request and clears the form on a successful submission', async () => {
    // Req 2.2, 2.3, 2.5
    const holding: HoldingResponse = { symbol: 'BTC', quantity: '1.5', currentPrice: '50000' };
    jest.spyOn(apiClient, 'addHolding').mockResolvedValue({ ok: true, value: holding });
    const publishSpy = jest.spyOn(portfolioEvents, 'publish').mockImplementation(() => undefined);

    fillForm({ symbol: 'BTC', quantity: '1.5', currentPrice: '50000' });
    const { form, symbolInput, quantityInput, currentPriceInput, errorMessage } = elements();
    form.requestSubmit();
    await flushPromises();

    expect(apiClient.addHolding).toHaveBeenCalledWith({
      symbol: 'BTC',
      quantity: '1.5',
      currentPrice: '50000',
    });
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(symbolInput.value).toBe('');
    expect(quantityInput.value).toBe('');
    expect(currentPriceInput.value).toBe('');
    expect(errorMessage.hidden).toBe(true);
  });

  it('shows the backend message and retains the entered values on a rejected submission', async () => {
    // Req 2.4, 2.6
    jest.spyOn(apiClient, 'addHolding').mockResolvedValue({
      ok: false,
      error: { kind: 'ApiError', status: 409, code: 'DuplicateHoldingError', message: 'Cryptoasset BTC is already held' },
    } as ApiResult<HoldingResponse>);
    const publishSpy = jest.spyOn(portfolioEvents, 'publish').mockImplementation(() => undefined);

    fillForm({ symbol: 'BTC', quantity: '1.5', currentPrice: '50000' });
    const { form, symbolInput, quantityInput, currentPriceInput, errorMessage } = elements();
    form.requestSubmit();
    await flushPromises();

    expect(errorMessage.hidden).toBe(false);
    expect(errorMessage.textContent).toBe('Cryptoasset BTC is already held');
    expect(symbolInput.value).toBe('BTC');
    expect(quantityInput.value).toBe('1.5');
    expect(currentPriceInput.value).toBe('50000');
    expect(publishSpy).not.toHaveBeenCalled();
  });
});

/** Waits for any pending promise microtasks (e.g. the form's `.then` chain) to settle. */
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
