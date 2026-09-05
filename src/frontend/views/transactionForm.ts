/**
 * The buy/sell Transaction form (Req 5): collects a Cryptoasset symbol,
 * Transaction_Type, quantity, and price per unit, and submits them via
 * `apiClient.recordTransaction`.
 *
 * On a successful submission, displays a confirmation showing the recorded
 * Transaction's symbol, Transaction_Type, quantity, and price per unit, then
 * publishes `portfolioChanged` (Req 5.4, 5.5 are satisfied entirely by that
 * publish: `overviewView.ts`'s subscriber re-fetches and re-renders the
 * Holdings_List and Portfolio_Value, so this form never touches them
 * directly). On a rejected submission, displays the returned error message
 * instead of a confirmation.
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6**
 */

import * as apiClient from '../apiClient.js';
import { messageForApiError, messageForNetworkFailure } from '../errorPresentation.js';
import * as portfolioEvents from '../portfolioEvents.js';
import type { TransactionRequest, TransactionResponse } from '../types.js';

const FORM_HTML = `
  <form id="transaction-form">
    <label for="transaction-symbol">
      Symbol
      <input id="transaction-symbol" name="symbol" type="text" required />
    </label>
    <label for="transaction-type">
      Type
      <select id="transaction-type" name="type" required>
        <option value="Buy">Buy</option>
        <option value="Sell">Sell</option>
      </select>
    </label>
    <label for="transaction-quantity">
      Quantity
      <input id="transaction-quantity" name="quantity" type="text" required />
    </label>
    <label for="transaction-price">
      Price per unit
      <input id="transaction-price" name="pricePerUnit" type="text" required />
    </label>
    <button type="submit">Record transaction</button>
  </form>
  <p id="transaction-confirmation" class="confirmation-message" hidden></p>
  <p id="transaction-error" class="error-message" hidden></p>
`;

/** Reads the current field values from `form` into a `TransactionRequest`. */
function readInput(form: HTMLFormElement): TransactionRequest {
  const symbolField = form.elements.namedItem('symbol') as HTMLInputElement;
  const typeField = form.elements.namedItem('type') as HTMLSelectElement;
  const quantityField = form.elements.namedItem('quantity') as HTMLInputElement;
  const pricePerUnitField = form.elements.namedItem('pricePerUnit') as HTMLInputElement;

  return {
    symbol: symbolField.value,
    type: typeField.value === 'Sell' ? 'Sell' : 'Buy',
    quantity: quantityField.value,
    pricePerUnit: pricePerUnitField.value,
  };
}

/** Renders the confirmation for a successfully recorded Transaction (Req 5.3). */
function showConfirmation(confirmationElement: HTMLElement, transaction: TransactionResponse): void {
  confirmationElement.textContent = `Recorded ${transaction.type} of ${transaction.quantity} ${transaction.symbol} at ${transaction.pricePerUnit} per unit.`;
  confirmationElement.removeAttribute('hidden');
}

/** Renders `message` in the form's error area, per Req 5.6. */
function showError(errorElement: HTMLElement, message: string): void {
  errorElement.textContent = message;
  errorElement.removeAttribute('hidden');
}

/** Hides both the confirmation and error areas ahead of a new submission. */
function clearFeedback(confirmationElement: HTMLElement, errorElement: HTMLElement): void {
  confirmationElement.setAttribute('hidden', '');
  errorElement.setAttribute('hidden', '');
}

/**
 * Renders the Transaction form into `container` and wires its submit
 * handler. This is the module's only public entry point.
 */
export function init(container: HTMLElement): void {
  container.innerHTML = FORM_HTML;

  const form = container.querySelector('#transaction-form') as HTMLFormElement;
  const confirmationElement = container.querySelector('#transaction-confirmation') as HTMLElement;
  const errorElement = container.querySelector('#transaction-error') as HTMLElement;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    clearFeedback(confirmationElement, errorElement);

    const input = readInput(form);

    void apiClient.recordTransaction(input).then((result) => {
      if (result.ok) {
        showConfirmation(confirmationElement, result.value);
        portfolioEvents.publish();
        return;
      }

      const message = result.error.kind === 'ApiError' ? messageForApiError(result.error) : messageForNetworkFailure();
      showError(errorElement, message);
    });
  });
}
