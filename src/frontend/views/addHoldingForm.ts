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
 * Per the Vela design this form is a disclosure rather than a permanently
 * visible section: it lives in a tinted panel inside the Holdings card,
 * opened by the card's "Add holding" button and closed by its own "Cancel"
 * button or by a successful submission. That button lives outside this
 * view's container (it is the Card's header action in the design), so it is
 * looked up by id and the disclosure wiring is simply skipped when it is
 * absent — leaving the form permanently visible, which is what a container
 * rendered on its own should do.
 *
 * Symbols are upper-cased as they are typed, matching the design. The
 * Backend_API accepts only uppercase letters and digits (see
 * `parseSymbol` in `src/domain/validation.ts`), so this turns what was
 * previously a round-trip validation rejection for lowercase input into
 * input that is simply correct by construction.
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6**
 */

import * as apiClient from '../apiClient.js';
import * as errorPresentation from '../errorPresentation.js';
import * as portfolioEvents from '../portfolioEvents.js';

import type { NewHoldingRequest } from '../types.js';

/** The id of the Holdings card's "Add holding" button, in `public/index.html`. */
const TOGGLE_BUTTON_ID = 'add-holding-toggle';

const FORM_HTML = `
  <form class="form-row">
    <label class="field field-required">
      <span class="field-label">Symbol</span>
      <input type="text" name="symbol" required autocomplete="off" />
    </label>
    <label class="field field-mono field-required">
      <span class="field-label">Quantity</span>
      <input type="text" name="quantity" required autocomplete="off" inputmode="decimal" />
    </label>
    <label class="field field-mono field-required">
      <span class="field-label">Current Price</span>
      <input type="text" name="currentPrice" required autocomplete="off" inputmode="decimal" />
    </label>
    <button type="submit" class="btn btn-primary btn-sm">Add holding</button>
    <button type="button" class="btn btn-ghost btn-sm add-holding-cancel">Cancel</button>
  </form>
  <p class="error-message" hidden></p>
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
  const cancelButton = container.querySelector<HTMLButtonElement>('.add-holding-cancel');

  if (!form || !symbolInput || !quantityInput || !currentPriceInput || !errorMessage || !cancelButton) {
    return;
  }

  const toggleButton = document.getElementById(TOGGLE_BUTTON_ID);

  /**
   * Hides the panel and returns focus to the button that opened it. A no-op
   * when there is no such button, since then nothing could reopen the form.
   */
  const closePanel = (): void => {
    if (toggleButton === null) {
      return;
    }
    container.hidden = true;
    toggleButton.focus();
  };

  if (toggleButton !== null) {
    cancelButton.hidden = false;
    toggleButton.addEventListener('click', () => {
      form.reset();
      errorMessage.hidden = true;
      errorMessage.textContent = '';
      container.hidden = false;
      symbolInput.focus();
    });
    cancelButton.addEventListener('click', closePanel);
  } else {
    cancelButton.hidden = true;
  }

  symbolInput.addEventListener('input', () => {
    symbolInput.value = symbolInput.value.toUpperCase();
  });

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
        closePanel();
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
