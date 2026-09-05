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
 * Per the Vela design the Portfolio_Value is displayed in the application
 * header rather than inside this view's own container, so it stays visible
 * while the Holdings_List scrolls. That element lives outside this
 * container, so it is looked up by id and skipped when absent — the same
 * approach `loadingIndicator.ts` takes to its own global element.
 *
 * Also renders, per Holding, the edit control (Requirement 3): a pencil
 * button that turns the row's quantity and Current_Price cells into inputs
 * pre-populated with that Holding's current values (Req 3.2), submits via
 * `apiClient.updateHolding`, and on success publishes `portfolioChanged` —
 * which this module's own subscription then turns into a full re-fetch and
 * re-render, so the edited row's cells show the updated values (Req 3.4).
 * On rejection, the row stays in edit mode showing the returned error
 * message and the values the user submitted (Req 3.5).
 *
 * Also renders, per Holding, the removal control (Requirement 4): a trash
 * button that asks for confirmation in a modal dialog naming the Holding's
 * Cryptoasset symbol (Req 4.2) before sending anything to the Backend_API.
 * Dismissing the dialog sends no request and leaves the Holding unchanged
 * (Req 4.4). Confirming calls `apiClient.removeHolding`; on success the row
 * is removed from the Holdings_List and `portfolioChanged` is published
 * (Req 4.3, 4.5); on rejection, the returned error message is displayed
 * beneath the row (Req 4.6).
 *
 * Also renders, per Holding, the price-update control (Requirement 7): a
 * refresh button that turns the row's Current_Price cell into an input for
 * submitting a new Current_Price (Req 7.1). On submit, calls
 * `apiClient.updatePrice`; on success it publishes `portfolioChanged`,
 * whose re-fetch supplies the recalculated Holding_Value and
 * Portfolio_Value from the Backend_API rather than a client-side
 * computation (Req 7.3, 7.4). On rejection, the cell stays in price mode
 * showing the returned error message and the value the user submitted
 * (Req 7.5).
 *
 * Every decimal field is rendered exactly as the Backend_API sent it. This
 * module never parses one into a `number`, and in particular does not do
 * the client-side `parseFloat(...).toFixed(2)` arithmetic the design mock
 * used to stand in for a backend: the Backend_API is the sole authority on
 * both the values and their precision (see `src/frontend/types.ts`).
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 3.1, 3.2, 3.3, 3.4, 3.5,
 * 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 7.1, 7.2, 7.3, 7.4, 7.5**
 */

import * as apiClient from '../apiClient.js';
import * as portfolioEvents from '../portfolioEvents.js';
import { createIcon } from '../icons.js';
import { messageForApiError, messageForNetworkFailure } from '../errorPresentation.js';

import type { ApiError, NetworkError } from '../apiClient.js';
import type {
  HoldingUpdateRequest,
  HoldingViewResponse,
  PortfolioOverviewResponse,
  PriceUpdateRequest,
} from '../types.js';

const EMPTY_STATE_MESSAGE = 'This portfolio has no holdings yet.';
const EMPTY_STATE_DESCRIPTION = 'Add your first holding to start tracking its value.';
const LOAD_FAILURE_PREFIX = 'The portfolio overview could not be loaded: ';
const HEADER_PORTFOLIO_VALUE_ELEMENT_ID = 'header-portfolio-value';
const HOLDINGS_COLUMNS = ['Symbol', 'Quantity', 'Current price', 'Holding value', 'Actions'] as const;

let containerElement: HTMLElement | null = null;
let unsubscribeFromPortfolioChanged: (() => void) | null = null;

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
    renderOverview(containerElement, result.value);
  } else {
    renderLoadFailure(containerElement, result.error);
  }
}

/**
 * Writes the Portfolio_Value into the header (Req 1.3), or does nothing when
 * the page has no header element — which is the case for a container
 * rendered on its own.
 */
function renderHeaderPortfolioValue(portfolioValue: string): void {
  const headerValueElement = document.getElementById(HEADER_PORTFOLIO_VALUE_ELEMENT_ID);
  if (headerValueElement === null) {
    return;
  }
  headerValueElement.textContent = portfolioValue;
}

/** Renders the Holdings_List and Portfolio_Value (Req 1.2, 1.3), or the empty state (Req 1.4). */
function renderOverview(container: HTMLElement, overview: PortfolioOverviewResponse): void {
  container.innerHTML = '';
  renderHeaderPortfolioValue(overview.portfolioValue);

  if (overview.holdings.length === 0) {
    container.appendChild(buildEmptyState());
    return;
  }

  container.appendChild(buildHoldingsTable(overview.holdings));
}

/** The design's EmptyState: a bold title with a supporting line beneath it. */
function buildEmptyState(): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'empty-state-panel';

  const title = document.createElement('p');
  title.className = 'empty-state';
  title.textContent = EMPTY_STATE_MESSAGE;

  const description = document.createElement('p');
  description.className = 'empty-state-description';
  description.textContent = EMPTY_STATE_DESCRIPTION;

  panel.appendChild(title);
  panel.appendChild(description);
  return panel;
}

function buildHoldingsTable(holdings: readonly HoldingViewResponse[]): HTMLElement {
  const scroller = document.createElement('div');
  scroller.className = 'table-scroll';

  const table = document.createElement('table');
  table.className = 'holdings-table';

  const headerRow = document.createElement('tr');
  for (const heading of HOLDINGS_COLUMNS) {
    const headerCell = document.createElement('th');
    headerCell.textContent = heading;
    headerRow.appendChild(headerCell);
  }
  const thead = document.createElement('thead');
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const holding of holdings) {
    for (const rowElement of buildHoldingRow(holding)) {
      tbody.appendChild(rowElement);
    }
  }
  table.appendChild(tbody);

  scroller.appendChild(table);
  return scroller;
}

/**
 * Builds the two `<tr>`s for one Holding: the Holding's own row, tagged with
 * `data-symbol` so the removal control (Req 4) can locate it, and the
 * initially hidden row beneath it that carries any error message that row's
 * controls produce.
 */
function buildHoldingRow(holding: HoldingViewResponse): readonly HTMLTableRowElement[] {
  const row = document.createElement('tr');
  row.dataset.symbol = holding.symbol;

  const symbolCell = document.createElement('td');
  symbolCell.appendChild(createValueSpan(holding.symbol, 'holding-symbol'));

  const quantityCell = document.createElement('td');
  quantityCell.className = 'cell-mono';
  quantityCell.appendChild(createValueSpan(holding.quantity, 'holding-quantity'));

  // The design prefixes both money columns with a "$" sign. It is a separate,
  // presentational element rather than part of the value's own text, so the
  // Backend_API's decimal string is still rendered verbatim and on its own.
  const currentPriceCell = document.createElement('td');
  currentPriceCell.className = 'cell-mono';
  currentPriceCell.appendChild(createCurrencySign());
  currentPriceCell.appendChild(createValueSpan(holding.currentPrice, 'holding-current-price'));

  const holdingValueCell = document.createElement('td');
  holdingValueCell.className = 'cell-mono';
  holdingValueCell.appendChild(createCurrencySign());
  holdingValueCell.appendChild(createValueSpan(holding.holdingValue, 'holding-value'));

  const actionsCell = document.createElement('td');
  actionsCell.className = 'holding-actions cell-right';

  const errorRow = document.createElement('tr');
  errorRow.className = 'holding-error-row';
  errorRow.hidden = true;

  const errorCell = document.createElement('td');
  errorCell.colSpan = HOLDINGS_COLUMNS.length;
  const errorMessage = document.createElement('p');
  errorMessage.className = 'error-message';
  errorCell.appendChild(errorMessage);
  errorRow.appendChild(errorCell);

  const showError = (message: string): void => {
    errorMessage.textContent = message;
    errorRow.hidden = false;
  };

  const clearError = (): void => {
    errorMessage.textContent = '';
    errorRow.hidden = true;
  };

  wireRowControls({
    holding,
    actionsCell,
    quantityCell,
    currentPriceCell,
    row,
    showError,
    clearError,
  });

  row.appendChild(symbolCell);
  row.appendChild(quantityCell);
  row.appendChild(currentPriceCell);
  row.appendChild(holdingValueCell);
  row.appendChild(actionsCell);

  return [row, errorRow];
}

/** Everything one row's controls need in order to mutate that row in place. */
interface RowContext {
  readonly holding: HoldingViewResponse;
  readonly actionsCell: HTMLTableCellElement;
  readonly quantityCell: HTMLTableCellElement;
  readonly currentPriceCell: HTMLTableCellElement;
  readonly row: HTMLTableRowElement;
  readonly showError: (message: string) => void;
  readonly clearError: () => void;
}

/**
 * Wires one row's three states — its default actions, edit mode (Req 3), and
 * price mode (Req 7) — plus its removal dialog (Req 4).
 *
 * The row has no persistent state of its own: entering a mode swaps the
 * affected cells' contents and the actions cell's buttons, and leaving a mode
 * (by cancelling, or by a successful save that publishes `portfolioChanged`
 * and so triggers a full re-render) puts the plain values back.
 */
function wireRowControls(context: RowContext): void {
  const { holding, actionsCell, quantityCell, currentPriceCell, row, showError, clearError } = context;

  /** Restores a cell to a plain value, with the "$" sign when `withCurrencySign`. */
  const restoreCell = (cell: HTMLTableCellElement, value: string, className: string, withCurrencySign: boolean): void => {
    cell.innerHTML = '';
    if (withCurrencySign) {
      cell.appendChild(createCurrencySign());
    }
    cell.appendChild(createValueSpan(value, className));
  };

  /** Replaces a cell's contents with an editable input carrying `value`. */
  const editCell = (cell: HTMLTableCellElement, value: string, label: string): HTMLInputElement => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cell-input';
    input.value = value;
    input.setAttribute('aria-label', `${label} for ${holding.symbol}`);
    cell.innerHTML = '';
    cell.appendChild(input);
    return input;
  };

  const showDefaultActions = (): void => {
    actionsCell.innerHTML = '';

    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.appendChild(
      createIconButton('refresh-cw', `Update price for ${holding.symbol}`, 'holding-update-price-button', () =>
        enterPriceMode(),
      ),
    );
    actions.appendChild(
      createIconButton('pencil', `Edit holding ${holding.symbol}`, 'holding-edit-button', () => enterEditMode()),
    );
    actions.appendChild(
      createIconButton('trash-2', `Remove holding ${holding.symbol}`, 'holding-remove-button', () => confirmRemoval(), true),
    );

    actionsCell.appendChild(actions);
  };

  /**
   * Swaps the row's actions for save/cancel. `onSave` runs the mode's
   * Backend_API call; `onCancel` puts the row back the way it was.
   */
  const showModeActions = (onSave: (setBusy: (busy: boolean) => void) => void, onCancel: () => void): void => {
    actionsCell.innerHTML = '';

    const actions = document.createElement('div');
    actions.className = 'row-actions';

    const saveButton = createIconButton('check', `Save ${holding.symbol}`, 'holding-save-button', () => {
      onSave(setBusy);
    });
    const cancelButton = createIconButton('x', `Cancel editing ${holding.symbol}`, 'holding-cancel-button', onCancel);

    /** Both controls are disabled while the row's request is in flight. */
    function setBusy(busy: boolean): void {
      saveButton.disabled = busy;
      cancelButton.disabled = busy;
    }

    actions.appendChild(saveButton);
    actions.appendChild(cancelButton);
    actionsCell.appendChild(actions);
  };

  /** Req 3.1, 3.2: quantity and Current_Price become inputs holding the current values. */
  const enterEditMode = (): void => {
    clearError();
    const quantityInput = editCell(quantityCell, holding.quantity, 'Quantity');
    const currentPriceInput = editCell(currentPriceCell, holding.currentPrice, 'Current price');
    quantityInput.focus();

    const leaveMode = (): void => {
      restoreCell(quantityCell, holding.quantity, 'holding-quantity', false);
      restoreCell(currentPriceCell, holding.currentPrice, 'holding-current-price', true);
      clearError();
      showDefaultActions();
    };

    showModeActions((setBusy) => {
      const input: HoldingUpdateRequest = {
        quantity: quantityInput.value,
        currentPrice: currentPriceInput.value,
      };

      setBusy(true);
      void apiClient.updateHolding(holding.symbol, input).then((result) => {
        setBusy(false);
        if (result.ok) {
          // Req 3.4: the re-render this publish triggers is what shows the
          // updated values, so the row is left in place until it arrives.
          clearError();
          portfolioEvents.publish();
          return;
        }
        // Req 3.5: the inputs keep what the user submitted.
        showError(messageFor(result.error));
      });
    }, leaveMode);
  };

  /** Req 7.1: only the Current_Price cell becomes an input. */
  const enterPriceMode = (): void => {
    clearError();
    const currentPriceInput = editCell(currentPriceCell, holding.currentPrice, 'Current price');
    currentPriceInput.focus();

    const leaveMode = (): void => {
      restoreCell(currentPriceCell, holding.currentPrice, 'holding-current-price', true);
      clearError();
      showDefaultActions();
    };

    showModeActions((setBusy) => {
      const input: PriceUpdateRequest = { currentPrice: currentPriceInput.value };

      setBusy(true);
      void apiClient.updatePrice(holding.symbol, input).then((result) => {
        setBusy(false);
        if (result.ok) {
          // Req 7.3, 7.4: the recalculated Holding_Value and Portfolio_Value
          // come back from the Backend_API with this publish's re-fetch.
          clearError();
          portfolioEvents.publish();
          return;
        }
        // Req 7.5: the input keeps what the user submitted.
        showError(messageFor(result.error));
      });
    }, leaveMode);
  };

  /** Req 4.2: confirmation names the Cryptoasset symbol before anything is sent. */
  const confirmRemoval = (): void => {
    openConfirmationDialog({
      title: 'Remove holding?',
      description: `Remove ${holding.symbol}? This cannot be undone.`,
      confirmLabel: 'Remove',
      // Req 4.4: dismissing sends no request at all — there is no else branch.
      onConfirm: () => {
        clearError();
        void apiClient.removeHolding(holding.symbol).then((result) => {
          if (result.ok) {
            row.remove();
            portfolioEvents.publish();
            return;
          }
          showError(messageFor(result.error));
        });
      },
    });
  };

  showDefaultActions();
}

/** Builds one of the design's 34x34 ghost icon buttons. */
function createIconButton(
  icon: Parameters<typeof createIcon>[0],
  label: string,
  className: string,
  onClick: () => void,
  danger = false,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = danger ? `icon-btn icon-btn-danger ${className}` : `icon-btn ${className}`;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.appendChild(createIcon(icon, 15));
  button.addEventListener('click', onClick);
  return button;
}

/** The presentational "$" the design puts before each money value. */
function createCurrencySign(): HTMLSpanElement {
  const sign = document.createElement('span');
  sign.setAttribute('aria-hidden', 'true');
  sign.textContent = '$';
  return sign;
}

function createValueSpan(text: string, className: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

/** What {@link openConfirmationDialog} needs to render one confirmation. */
interface ConfirmationDialogOptions {
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
}

/**
 * Opens the design's modal confirmation Dialog, replacing the browser's own
 * `window.confirm()`. Confirming runs `onConfirm`; cancelling, pressing
 * Escape, or clicking the backdrop closes the dialog and runs nothing at all.
 */
function openConfirmationDialog(options: ConfirmationDialogOptions): void {
  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'dialog';
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-modal', 'true');

  const title = document.createElement('div');
  title.className = 'dialog-title';
  title.textContent = options.title;

  const description = document.createElement('div');
  description.className = 'dialog-description';
  description.textContent = options.description;

  const actions = document.createElement('div');
  actions.className = 'dialog-actions';

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'btn btn-secondary btn-sm dialog-cancel-button';
  cancelButton.textContent = 'Cancel';

  const confirmButton = document.createElement('button');
  confirmButton.type = 'button';
  confirmButton.className = 'btn btn-danger btn-sm dialog-confirm-button';
  confirmButton.textContent = options.confirmLabel;

  const previouslyFocused = document.activeElement;

  const close = (): void => {
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
    if (previouslyFocused instanceof HTMLElement) {
      previouslyFocused.focus();
    }
  };

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      close();
    }
  }

  cancelButton.addEventListener('click', close);
  confirmButton.addEventListener('click', () => {
    close();
    options.onConfirm();
  });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) {
      close();
    }
  });
  document.addEventListener('keydown', onKeydown);

  actions.appendChild(cancelButton);
  actions.appendChild(confirmButton);
  dialog.appendChild(title);
  dialog.appendChild(description);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);

  dialog.setAttribute('aria-label', `${options.title} ${options.description}`);
  document.body.appendChild(overlay);
  confirmButton.focus();
}

/** Renders the load-failure message for a rejected or unreachable overview request (Req 1.5). */
function renderLoadFailure(container: HTMLElement, error: ApiError | NetworkError): void {
  container.innerHTML = '';

  const errorElement = document.createElement('p');
  errorElement.className = 'error-message';
  errorElement.textContent = `${LOAD_FAILURE_PREFIX}${messageFor(error)}`;
  container.appendChild(errorElement);
}

function messageFor(error: ApiError | NetworkError): string {
  return error.kind === 'ApiError' ? messageForApiError(error) : messageForNetworkFailure();
}
