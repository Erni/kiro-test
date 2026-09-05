/**
 * Renders the Portfolio_Overview_View (Requirement 1): fetches the
 * Portfolio overview from the Backend_API and displays every Holding's
 * Cryptoasset symbol, quantity, Current_Price, and Holding_Value, plus the
 * Portfolio_Value. Displays an empty-state message and a zero
 * Portfolio_Value when there are no Holdings, and a load-failure message
 * when the request fails. Re-runs the fetch-and-render sequence whenever
 * `portfolioChanged` is published, so this view stays in sync with every
 * other view's successful mutation.
 *
 * Also renders, per Holding, the edit control (Requirement 3): an "Edit"
 * button that opens an inline form pre-populated with that Holding's
 * current quantity and Current_Price, submits via
 * `apiClient.updateHolding`, and on success publishes `portfolioChanged` —
 * which this module's own subscription then turns into a full re-fetch and
 * re-render, so the edited row's cells are updated either directly (Req
 * 3.4) or, in practice, superseded almost immediately by that re-render;
 * both leave the Holdings_List showing the updated values. On rejection,
 * the form stays open showing the returned error message and the values
 * the user submitted (Req 3.5).
 *
 * Also renders, per Holding, the removal control (Requirement 4): a
 * "Remove" button that asks for confirmation via `window.confirm()`,
 * naming the Holding's Cryptoasset symbol, before sending anything to the
 * Backend_API. Declining the confirmation sends no request and leaves the
 * Holding unchanged (Req 4.4). Confirming calls `apiClient.removeHolding`;
 * on success the row is removed from the Holdings_List and
 * `portfolioChanged` is published (Req 4.3, 4.5); on rejection, the
 * returned error message is displayed next to the control (Req 4.6).
 *
 * Also renders, per Holding, the price-update control (Requirement 7): a
 * "Update price" button that opens an inline form for submitting a new
 * Current_Price (Req 7.1). On submit, calls `apiClient.updatePrice`; on
 * success, writes the new Current_Price into `currentPriceCell`, closes the
 * form, and publishes `portfolioChanged` — which this module's own
 * subscription then turns into a full re-fetch and re-render, giving the
 * recalculated Holding_Value and Portfolio_Value directly from the
 * Backend_API rather than a client-side computation (Req 7.3, 7.4). On
 * rejection, the form stays open showing the returned error message and the
 * value the user submitted (Req 7.5).
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 3.1, 3.2, 3.3, 3.4, 3.5,
 * 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 7.1, 7.2, 7.3, 7.4, 7.5**
 */

import * as apiClient from '../apiClient.js';
import * as portfolioEvents from '../portfolioEvents.js';
import { messageForApiError, messageForNetworkFailure } from '../errorPresentation.js';

import type { ApiError, NetworkError } from '../apiClient.js';
import type { HoldingResponse, HoldingUpdateRequest, HoldingViewResponse, PortfolioOverviewResponse, PriceUpdateRequest } from '../types.js';

const EMPTY_STATE_MESSAGE = 'This portfolio has no holdings yet.';
const LOAD_FAILURE_PREFIX = 'The portfolio overview could not be loaded: ';

let containerElement: HTMLElement | null = null;
let unsubscribeFromPortfolioChanged: (() => void) | null = null;

/**
 * The most recently fetched overview. Held here (rather than re-derived) so
 * the edit, removal, and price-update controls can read a Holding's
 * current values without a redundant fetch; not read by the base rendering
 * logic, which always works from the latest response.
 */
let currentOverview: PortfolioOverviewResponse | null = null;

/**
 * Renders the Portfolio_Overview_View into `container` and, on first call,
 * subscribes it to `portfolioChanged` so it re-fetches and re-renders on
 * every future publish (Req 1.1). Safe to call again with the same or a
 * different container; only one `portfolioChanged` subscription is ever
 * active regardless of how many times `init` is called.
 */
export function init(container: HTMLElement): void {
  containerElement = container;

  if (unsubscribeFromPortfolioChanged === null) {
    unsubscribeFromPortfolioChanged = portfolioEvents.subscribe(() => {
      void loadAndRender();
    });
  }

  void loadAndRender();
}

/** Fetches the Portfolio overview and renders the result, or the failure, into the current container. */
async function loadAndRender(): Promise<void> {
  if (containerElement === null) {
    return;
  }

  const result = await apiClient.getOverview();

  if (result.ok) {
    currentOverview = result.value;
    renderOverview(containerElement, result.value);
  } else {
    currentOverview = null;
    renderLoadFailure(containerElement, result.error);
  }
}

/** Renders the Holdings_List and Portfolio_Value (Req 1.2, 1.3), or the empty state (Req 1.4). */
function renderOverview(container: HTMLElement, overview: PortfolioOverviewResponse): void {
  container.innerHTML = '';

  const portfolioValueElement = document.createElement('p');
  portfolioValueElement.className = 'portfolio-value';
  portfolioValueElement.textContent = `Portfolio value: ${overview.portfolioValue}`;
  container.appendChild(portfolioValueElement);

  if (overview.holdings.length === 0) {
    const emptyState = document.createElement('p');
    emptyState.className = 'empty-state';
    emptyState.textContent = EMPTY_STATE_MESSAGE;
    container.appendChild(emptyState);
    return;
  }

  container.appendChild(buildHoldingsTable(overview.holdings));
}

function buildHoldingsTable(holdings: readonly HoldingViewResponse[]): HTMLTableElement {
  const table = document.createElement('table');
  table.className = 'holdings-table';

  const headerRow = document.createElement('tr');
  for (const heading of ['Symbol', 'Quantity', 'Current price', 'Holding value', 'Actions']) {
    const headerCell = document.createElement('th');
    headerCell.textContent = heading;
    headerRow.appendChild(headerCell);
  }
  const thead = document.createElement('thead');
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const holding of holdings) {
    tbody.appendChild(buildHoldingRow(holding));
  }
  table.appendChild(tbody);

  return table;
}

/**
 * Builds one Holdings_List row. Tagged with `data-symbol` so the removal
 * (Req 4) control can locate this row, and given a `holding-actions` cell
 * holding the edit, removal, and price-update controls.
 */
function buildHoldingRow(holding: HoldingViewResponse): HTMLTableRowElement {
  const row = document.createElement('tr');
  row.dataset.symbol = holding.symbol;

  const quantityCell = createHoldingCell(holding.quantity, 'holding-quantity');
  const currentPriceCell = createHoldingCell(holding.currentPrice, 'holding-current-price');

  row.appendChild(createHoldingCell(holding.symbol, 'holding-symbol'));
  row.appendChild(quantityCell);
  row.appendChild(currentPriceCell);
  row.appendChild(createHoldingCell(holding.holdingValue, 'holding-value'));

  const actionsCell = document.createElement('td');
  actionsCell.className = 'holding-actions';
  actionsCell.appendChild(buildEditControl(holding, quantityCell, currentPriceCell));
  actionsCell.appendChild(buildRemovalControl(holding, row));
  actionsCell.appendChild(buildPriceUpdateControl(holding, currentPriceCell));
  row.appendChild(actionsCell);

  return row;
}

/**
 * Builds the edit control for one Holding (Req 3.1): an "Edit" button that
 * toggles open an inline update form pre-populated with `holding`'s current
 * quantity and Current_Price (Req 3.2). On submit, calls
 * `apiClient.updateHolding`; on success, writes the new values into
 * `quantityCell`/`currentPriceCell`, closes the form, and publishes
 * `portfolioChanged` (Req 3.3, 3.4). On rejection, shows the returned error
 * message inside the still-open form without resetting its inputs (Req 3.5).
 */
function buildEditControl(
  holding: HoldingResponse,
  quantityCell: HTMLTableCellElement,
  currentPriceCell: HTMLTableCellElement,
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'holding-edit-control';

  const editButton = document.createElement('button');
  editButton.type = 'button';
  editButton.className = 'holding-edit-button';
  editButton.textContent = 'Edit';
  wrapper.appendChild(editButton);

  const form = document.createElement('form');
  form.className = 'holding-edit-form';
  form.hidden = true;

  const quantityInput = document.createElement('input');
  quantityInput.type = 'text';
  quantityInput.name = 'quantity';
  quantityInput.required = true;

  const currentPriceInput = document.createElement('input');
  currentPriceInput.type = 'text';
  currentPriceInput.name = 'currentPrice';
  currentPriceInput.required = true;

  const quantityLabel = document.createElement('label');
  quantityLabel.textContent = 'Quantity';
  quantityLabel.appendChild(quantityInput);

  const currentPriceLabel = document.createElement('label');
  currentPriceLabel.textContent = 'Current Price';
  currentPriceLabel.appendChild(currentPriceInput);

  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.textContent = 'Save';

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.textContent = 'Cancel';

  const errorElement = document.createElement('p');
  errorElement.className = 'error-message';
  errorElement.hidden = true;

  form.appendChild(quantityLabel);
  form.appendChild(currentPriceLabel);
  form.appendChild(saveButton);
  form.appendChild(cancelButton);
  form.appendChild(errorElement);
  wrapper.appendChild(form);

  const openForm = (): void => {
    quantityInput.value = holding.quantity;
    currentPriceInput.value = holding.currentPrice;
    errorElement.hidden = true;
    errorElement.textContent = '';
    form.hidden = false;
  };

  const closeForm = (): void => {
    form.hidden = true;
  };

  editButton.addEventListener('click', openForm);
  cancelButton.addEventListener('click', closeForm);

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const input: HoldingUpdateRequest = {
      quantity: quantityInput.value,
      currentPrice: currentPriceInput.value,
    };

    void apiClient.updateHolding(holding.symbol, input).then((result) => {
      if (result.ok) {
        quantityCell.textContent = result.value.quantity;
        currentPriceCell.textContent = result.value.currentPrice;
        closeForm();
        portfolioEvents.publish();
        return;
      }

      const message = result.error.kind === 'ApiError' ? messageForApiError(result.error) : messageForNetworkFailure();
      errorElement.textContent = message;
      errorElement.hidden = false;
    });
  });

  return wrapper;
}

/**
 * Builds the removal control for one Holding (Req 4.1): a "Remove" button
 * that asks for confirmation via `window.confirm()`, naming `holding`'s
 * Cryptoasset symbol (Req 4.2). Declining the confirmation sends no request
 * and leaves `row` unchanged (Req 4.4). Confirming calls
 * `apiClient.removeHolding` (Req 4.3); on success, removes `row` from the
 * Holdings_List and publishes `portfolioChanged` (Req 4.5); on rejection,
 * shows the returned error message next to the control (Req 4.6).
 */
function buildRemovalControl(holding: HoldingResponse, row: HTMLTableRowElement): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'holding-removal-control';

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'holding-remove-button';
  removeButton.textContent = 'Remove';

  const errorElement = document.createElement('p');
  errorElement.className = 'error-message';
  errorElement.hidden = true;

  removeButton.addEventListener('click', () => {
    const confirmed = window.confirm(`Remove holding ${holding.symbol}? This cannot be undone.`);
    if (!confirmed) {
      return;
    }

    void apiClient.removeHolding(holding.symbol).then((result) => {
      if (result.ok) {
        row.remove();
        portfolioEvents.publish();
        return;
      }

      const message = result.error.kind === 'ApiError' ? messageForApiError(result.error) : messageForNetworkFailure();
      errorElement.textContent = message;
      errorElement.hidden = false;
    });
  });

  wrapper.appendChild(removeButton);
  wrapper.appendChild(errorElement);

  return wrapper;
}

/**
 * Builds the price-update control for one Holding (Req 7.1): an "Update
 * price" button that toggles open an inline form for submitting a new
 * Current_Price. On submit, calls `apiClient.updatePrice` (Req 7.2); on
 * success, writes the new Current_Price into `currentPriceCell`, closes the
 * form, and publishes `portfolioChanged` (Req 7.3, 7.4) so this module's own
 * subscription re-fetches the overview and re-renders the recalculated
 * Holding_Value and Portfolio_Value. On rejection, shows the returned error
 * message inside the still-open form without resetting its input (Req 7.5).
 */
function buildPriceUpdateControl(holding: HoldingResponse, currentPriceCell: HTMLTableCellElement): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'holding-price-update-control';

  const updatePriceButton = document.createElement('button');
  updatePriceButton.type = 'button';
  updatePriceButton.className = 'holding-update-price-button';
  updatePriceButton.textContent = 'Update price';
  wrapper.appendChild(updatePriceButton);

  const form = document.createElement('form');
  form.className = 'holding-price-update-form';
  form.hidden = true;

  const currentPriceInput = document.createElement('input');
  currentPriceInput.type = 'text';
  currentPriceInput.name = 'currentPrice';
  currentPriceInput.required = true;

  const currentPriceLabel = document.createElement('label');
  currentPriceLabel.textContent = 'Current Price';
  currentPriceLabel.appendChild(currentPriceInput);

  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.textContent = 'Save';

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.textContent = 'Cancel';

  const errorElement = document.createElement('p');
  errorElement.className = 'error-message';
  errorElement.hidden = true;

  form.appendChild(currentPriceLabel);
  form.appendChild(saveButton);
  form.appendChild(cancelButton);
  form.appendChild(errorElement);
  wrapper.appendChild(form);

  const openForm = (): void => {
    currentPriceInput.value = holding.currentPrice;
    errorElement.hidden = true;
    errorElement.textContent = '';
    form.hidden = false;
  };

  const closeForm = (): void => {
    form.hidden = true;
  };

  updatePriceButton.addEventListener('click', openForm);
  cancelButton.addEventListener('click', closeForm);

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    const input: PriceUpdateRequest = {
      currentPrice: currentPriceInput.value,
    };

    void apiClient.updatePrice(holding.symbol, input).then((result) => {
      if (result.ok) {
        currentPriceCell.textContent = result.value.currentPrice;
        closeForm();
        portfolioEvents.publish();
        return;
      }

      const message = result.error.kind === 'ApiError' ? messageForApiError(result.error) : messageForNetworkFailure();
      errorElement.textContent = message;
      errorElement.hidden = false;
    });
  });

  return wrapper;
}

function createHoldingCell(text: string, className: string): HTMLTableCellElement {
  const cell = document.createElement('td');
  cell.className = className;
  cell.textContent = text;
  return cell;
}

/** Renders the load-failure message for a rejected or unreachable overview request (Req 1.5). */
function renderLoadFailure(container: HTMLElement, error: ApiError | NetworkError): void {
  container.innerHTML = '';

  const message = error.kind === 'ApiError' ? messageForApiError(error) : messageForNetworkFailure();

  const errorElement = document.createElement('p');
  errorElement.className = 'error-message';
  errorElement.textContent = `${LOAD_FAILURE_PREFIX}${message}`;
  container.appendChild(errorElement);
}
