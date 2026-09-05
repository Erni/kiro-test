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
 * **Validates: Requirements 6.1, 6.2, 6.3, 6.4**
 */

import * as apiClient from '../apiClient.js';
import type { ApiError, NetworkError } from '../apiClient.js';
import { messageForApiError, messageForNetworkFailure } from '../errorPresentation.js';
import type { TransactionResponse } from '../types.js';

/**
 * Builds the Transaction history view inside `container`: a symbol lookup
 * form and the results area it populates on submit.
 */
export function init(container: HTMLElement): void {
  container.textContent = '';

  const resultsContainer = document.createElement('div');
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
 */
function buildLookupForm(onSubmit: (symbol: string) => void): HTMLFormElement {
  const form = document.createElement('form');
  form.setAttribute('aria-label', 'Look up transaction history');

  const label = document.createElement('label');
  label.textContent = 'Cryptoasset symbol';

  const symbolInput = document.createElement('input');
  symbolInput.type = 'text';
  symbolInput.name = 'symbol';
  symbolInput.autocomplete = 'off';
  label.appendChild(symbolInput);

  const submitButton = document.createElement('button');
  submitButton.type = 'submit';
  submitButton.textContent = 'View history';

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
  const message = document.createElement('p');
  message.className = 'empty-state';
  message.textContent = 'No transactions found for this symbol.';
  return message;
}

/**
 * Renders every returned Transaction's type, quantity, price per unit, and
 * timestamp, in the order the array was returned in.
 */
function renderTransactionsTable(transactions: readonly TransactionResponse[]): HTMLElement {
  const table = document.createElement('table');

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const heading of ['Type', 'Quantity', 'Price per unit', 'Timestamp']) {
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
  return table;
}

function renderTransactionRow(transaction: TransactionResponse): HTMLElement {
  const row = document.createElement('tr');
  row.appendChild(createCell(transaction.type));
  row.appendChild(createCell(transaction.quantity));
  row.appendChild(createCell(transaction.pricePerUnit));
  row.appendChild(createCell(formatTimestamp(transaction.timestamp)));
  return row;
}

function createCell(text: string): HTMLElement {
  const cell = document.createElement('td');
  cell.textContent = text;
  return cell;
}

/** Formats an ISO 8601 timestamp for display; never parsed back into a request. */
function formatTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleString();
}
