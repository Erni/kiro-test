/**
 * Composition root for the Frontend (Req 1.1, 2.1, 3.1, 4.1, 5.1, 6.1, 7.1).
 *
 * Once the page has loaded, looks up each view's DOM container in
 * `public/index.html` and calls that view's `init` with it, then wires the
 * side panel's tabs. This module has no logic of its own beyond this
 * composition — no rendering, no Backend_API calls, no state.
 *
 * Every view is initialized once, including the two behind the side panel's
 * tabs: `sidePanelTabs.ts` only shows and hides them, so neither is ever
 * re-created and neither loses its contents when the user switches tabs.
 */

import * as overviewView from './views/overviewView.js';
import * as addHoldingForm from './views/addHoldingForm.js';
import * as transactionForm from './views/transactionForm.js';
import * as transactionHistoryView from './views/transactionHistoryView.js';
import * as sidePanelTabs from './views/sidePanelTabs.js';

/** Maps each view's `init` function to the id of its DOM container. */
const VIEWS: ReadonlyArray<{ containerId: string; init: (container: HTMLElement) => void }> = [
  { containerId: 'overview-container', init: overviewView.init },
  { containerId: 'add-holding-container', init: addHoldingForm.init },
  { containerId: 'transaction-container', init: transactionForm.init },
  { containerId: 'transaction-history-container', init: transactionHistoryView.init },
];

/** Initializes every view against its DOM container. Skips any container that isn't found. */
function composeApplication(): void {
  for (const view of VIEWS) {
    const container = document.getElementById(view.containerId);
    if (container === null) {
      continue;
    }
    view.init(container);
  }

  sidePanelTabs.init();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', composeApplication);
} else {
  composeApplication();
}
