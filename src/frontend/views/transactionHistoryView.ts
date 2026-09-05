/**
 * The symbol lookup and Transaction history display (Req 6).
 *
 * Renders a control for specifying a Cryptoasset symbol (including symbols
 * with no current Holding) and, on request, calls
 * `apiClient.getTransactionHistory(symbol)` and displays every returned
 * Transaction's Transaction_Type, quantity, price per unit, and timestamp,
 * in the order the Backend_API returned them (no client-side sorting). An
 * empty-state message is shown when none are returned, and an error message
 * via `errorPresentation` is shown on failure.
 *
 * Per the Vela design this is the second of the side panel's two tabs, the
 * Transaction_Type is shown as a coloured Badge rather than plain text, and
 * the price per unit carries a "$" sign. The tab chrome itself lives in
 * `public/index.html` and is wired by `sidePanelTabs.ts`.
 *
 * **Validates: Requirements 6.1, 6.2, 6.3, 6.4**
 */

import * as apiClient from '../apiClient.js';
import type { ApiError, NetworkError } from '../apiClient.js';
import { createIcon } from '../icons.js';
import { messageForApiError, messageForNetworkFailure } from '../errorPresentation.js';
import type { TransactionResponse } from '../types.js';

/**
 * Builds the Transaction history view inside `container`: a symbol lookup
 * form and the results area it populates on submit.
 */
export function init(container: HTMLElement): void {
  container.textContent = '';

  const resultsContainer = document.createElement('div');
  resultsContainer.className = 'history-results';
  resultsContainer.setAttribute('aria-live', 'polite');

  const form = buildLookupForm((symbol) => {
    void loadHistory(symbol, resultsContainer);
  });

  container.appendChild(form);
  container.appendChild(resultsContainer);
}

/**
 * Builds the symbol lookup control: a text input plus a submit action.
 * `onSubmit` is invoked with the trimmed symbol only when it is non-empty.
 *
 * The symbol is upper-cased as it is typed, matching the design and the
 * Backend_API's uppercase-only symbol format.
 */
function buildLookupForm(onSubmit: (symbol: string) => void): HTMLFormElement {
  const form = document.createElement('form');
  form.className = 'history-lookup';
  form.setAttribute('aria-label', 'Look up transaction history');

  const label = document.createElement('label');
  label.className = 'field';

  const labelText = document.createElement('span');
  labelText.className = 'field-label';
  labelText.textContent = 'Cryptoasset symbol';

  const symbolInput = document.createElement('input');
  symbolInput.type = 'text';
  symbolInput.name = 'symbol';
  symbolInput.autocomplete = 'off';
  symbolInput.placeholder = 'BTC';
  symbolInput.addEventListener('input', () => {
    symbolInput.value = symbolInput.value.toUpperCase();
  });

  label.appendChild(labelText);
  label.appendChild(symbolInput);

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'btn btn-secondary';
  submitButton.appendChild(createIcon('search', 14));
  submitButton.appendChild(document.createTextNode('View history'));

  form.appendChild(label);
  form.appendChild(submitButton);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const symbol = symbolInput.value.trim();
    if (symbol === '') {
      return;
    }
    onSubmit(symbol);
  });

  return form;
}

/** Requests the Transaction history for `symbol` and renders the outcome into `resultsContainer`. */
async function loadHistory(symbol: string, resultsContainer: HTMLElement): Promise<void> {
  const result = await apiClient.getTransactionHistory(symbol);

  resultsContainer.textContent = '';

  if (!result.ok) {
    resultsContainer.appendChild(renderErrorMessage(result.error));
    return;
  }

  const { transactions } = result.value;

  if (transactions.length === 0) {
    resultsContainer.appendChild(renderEmptyState());
    return;
  }

  resultsContainer.appendChild(renderTransactionsTable(transactions));
}

/** Renders the error message for either branch of the Backend_API failure union. */
function renderErrorMessage(error: ApiError | NetworkError): HTMLElement {
  const message = document.createElement('p');
  message.className = 'error-message';
  message.textContent = error.kind === 'ApiError' ? messageForApiError(error) : messageForNetworkFailure();
  return message;
}

/** Renders the indication that no Transactions exist for the requested symbol (Req 6.3). */
function renderEmptyState(): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'empty-state-panel';

  const message = document.createElement('p');
  message.className = 'empty-state';
  message.textContent = 'No transactions found for this symbol.';

  panel.appendChild(message);
  return panel;
}

/**
 * Renders every returned Transaction's type, quantity, price per unit, and
 * timestamp, in the order the array was returned in.
 */
function renderTransactionsTable(transactions: readonly TransactionResponse[]): HTMLElement {
  const scroller = document.createElement('div');
  scroller.className = 'table-scroll';

  const table = document.createElement('table');

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const heading of ['Type', 'Quantity', 'Price/unit', 'Timestamp']) {
    const headerCell = document.createElement('th');
    headerCell.textContent = heading;
    headerRow.appendChild(headerCell);
  }
  thead.appendChild(headerRow);

  const tbody = document.createElement('tbody');
  for (const transaction of transactions) {
    tbody.appendChild(renderTransactionRow(transaction));
  }

  table.appendChild(thead);
  table.appendChild(tbody);
  scroller.appendChild(table);
  return scroller;
}

function renderTransactionRow(transaction: TransactionResponse): HTMLElement {
  const row = document.createElement('tr');

  const typeCell = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = transaction.type === 'Buy' ? 'badge badge-buy' : 'badge badge-sell';
  badge.textContent = transaction.type;
  typeCell.appendChild(badge);

  row.appendChild(typeCell);
  row.appendChild(createCell(transaction.quantity, 'cell-mono'));
  row.appendChild(createCell(`$${transaction.pricePerUnit}`, 'cell-mono'));
  row.appendChild(createCell(formatTimestamp(transaction.timestamp)));
  return row;
}

function createCell(text: string, className?: string): HTMLElement {
  const cell = document.createElement('td');
  if (className !== undefined) {
    cell.className = className;
  }
  cell.textContent = text;
  return cell;
}

/** Formats an ISO 8601 timestamp for display; never parsed back into a request. */
function formatTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}
