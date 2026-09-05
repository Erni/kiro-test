/**
 * The new-Holding form (Req 2).
 *
 * Requires a value for each of the symbol, quantity, and Current_Price
 * fields before the form can be submitted (Req 2.1) — enforced via native
 * HTML `required` attributes plus `<form>` submit semantics, so the browser
 * blocks submission itself; no custom validation logic is needed. On
 * submit, calls `apiClient.addHolding()` with the entered values (Req 2.2).
 * On success, publishes `portfolioChanged` (Req 2.3) so the Holdings_List
 * reflects the new Holding, and clears the form (Req 2.5). On rejection,
 * displays the returned error message (Req 2.4) and retains the entered
 * values (Req 2.6).
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6**
 */

import * as apiClient from '../apiClient.js';
import * as errorPresentation from '../errorPresentation.js';
import * as portfolioEvents from '../portfolioEvents.js';

import type { NewHoldingRequest } from '../types.js';

const FORM_HTML = `
  <form>
    <label>
      Symbol
      <input type="text" name="symbol" required />
    </label>
    <label>
      Quantity
      <input type="text" name="quantity" required />
    </label>
    <label>
      Current Price
      <input type="text" name="currentPrice" required />
    </label>
    <button type="submit">Add Holding</button>
    <p class="error-message" hidden></p>
  </form>
`;

/**
 * Renders the add-Holding form into `container` and wires up its submit
 * handling. Safe to call more than once; each call replaces `container`'s
 * contents with a fresh form.
 */
export function init(container: HTMLElement): void {
  container.innerHTML = FORM_HTML;

  const form = container.querySelector('form');
  const symbolInput = container.querySelector<HTMLInputElement>('input[name="symbol"]');
  const quantityInput = container.querySelector<HTMLInputElement>('input[name="quantity"]');
  const currentPriceInput = container.querySelector<HTMLInputElement>('input[name="currentPrice"]');
  const errorMessage = container.querySelector<HTMLParagraphElement>('.error-message');

  if (!form || !symbolInput || !quantityInput || !currentPriceInput || !errorMessage) {
    return;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const input: NewHoldingRequest = {
      symbol: symbolInput.value,
      quantity: quantityInput.value,
      currentPrice: currentPriceInput.value,
    };

    void apiClient.addHolding(input).then((result) => {
      if (result.ok) {
        errorMessage.hidden = true;
        errorMessage.textContent = '';
        form.reset();
        portfolioEvents.publish();
        return;
      }

      errorMessage.textContent =
        result.error.kind === 'ApiError'
          ? errorPresentation.messageForApiError(result.error)
          : errorPresentation.messageForNetworkFailure();
      errorMessage.hidden = false;
    });
  });
}
