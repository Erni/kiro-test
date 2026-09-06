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
 * Per the Vela design this form is the first of the side panel's two tabs;
 * the tab chrome itself lives in `public/index.html` and is wired by
 * `sidePanelTabs.ts`, so this view still owns nothing but its own form.
 *
 * The Cryptoasset symbol is selected from the fixed Cryptoasset_Selection_List
 * (Req 9.2, 9.3, 9.4) rather than typed: the control is a `<select>`
 * populated, in list order, from `cryptoassetSelectionList.ts`'s
 * `CRYPTOASSET_SELECTION_LIST`, with each option's visible text showing the
 * symbol and display name (e.g. `BTC — Bitcoin`) and its value set to the
 * symbol alone, so the submitted symbol value is always exactly one entry's
 * symbol (Req 9.5).
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 9.2, 9.3, 9.4, 9.5**
 */

import * as apiClient from '../apiClient.js';
import { createIcon } from '../icons.js';
import { messageForApiError, messageForNetworkFailure } from '../errorPresentation.js';
import * as portfolioEvents from '../portfolioEvents.js';
import { CRYPTOASSET_SELECTION_LIST } from '../cryptoassetSelectionList.js';
import type { TransactionRequest, TransactionResponse } from '../types.js';

const FORM_HTML = `
  <form id="transaction-form" class="form-stack">
    <label class="field field-required" for="transaction-symbol">
      <span class="field-label">Symbol</span>
      <select id="transaction-symbol" name="symbol" required></select>
    </label>
    <label class="field" for="transaction-type">
      <span class="field-label">Type</span>
      <select id="transaction-type" name="type" required>
        <option value="Buy">Buy</option>
        <option value="Sell">Sell</option>
      </select>
    </label>
    <label class="field field-mono field-required" for="transaction-quantity">
      <span class="field-label">Quantity</span>
      <input id="transaction-quantity" name="quantity" type="text" required autocomplete="off" inputmode="decimal" />
    </label>
    <label class="field field-mono field-required" for="transaction-price">
      <span class="field-label">Price per unit</span>
      <input id="transaction-price" name="pricePerUnit" type="text" required autocomplete="off" inputmode="decimal" />
    </label>
    <button type="submit" class="btn btn-accent" id="transaction-submit">Record transaction</button>
  </form>
  <p id="transaction-confirmation" class="confirmation-message" hidden></p>
  <p id="transaction-error" class="error-message" hidden></p>
`;

/**
 * Populates `select` with one `<option>` per {@link CRYPTOASSET_SELECTION_LIST}
 * entry, in list order (Req 9.3): visible text shows `symbol — displayName`
 * (Req 9.4), and the option's value is the symbol alone (Req 9.5).
 */
function populateSymbolOptions(select: HTMLSelectElement): void {
  for (const entry of CRYPTOASSET_SELECTION_LIST) {
    const option = document.createElement('option');
    option.value = entry.symbol;
    option.textContent = `${entry.symbol} — ${entry.displayName}`;
    select.appendChild(option);
  }
}

/** Reads the current field values from `form` into a `TransactionRequest`. */
function readInput(form: HTMLFormElement): TransactionRequest {
  const symbolField = form.elements.namedItem('symbol') as HTMLSelectElement;
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
  confirmationElement.textContent = `Recorded ${transaction.type} of ${transaction.quantity} ${transaction.symbol} at $${transaction.pricePerUnit} per unit.`;
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
  const submitButton = container.querySelector('#transaction-submit') as HTMLButtonElement;
  const symbolSelect = container.querySelector('#transaction-symbol') as HTMLSelectElement;

  // The design's accent button leads with a swap glyph; it is prepended here
  // rather than written into FORM_HTML so the icon markup stays in `icons.ts`.
  submitButton.insertBefore(createIcon('arrow-left-right', 14), submitButton.firstChild);

  populateSymbolOptions(symbolSelect);

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
