/**
 * The side panel's two tabs, "Record transaction" and "Transaction history".
 *
 * The Vela design puts the Transaction form and the Transaction history in
 * one card, behind a segmented control, rather than in two separate page
 * sections. This module owns nothing but that switch: both panels are
 * rendered once by their own views at startup and are only shown or hidden
 * here, so switching tabs never tears down a half-filled form or a set of
 * results the user is still reading.
 *
 * The tab buttons and panels live in `public/index.html`; `init` is a no-op
 * when they are absent, so a page that renders only one of the views still
 * works.
 */

/** One tab button and the panel it controls. */
interface Tab {
  readonly button: HTMLElement;
  readonly panel: HTMLElement;
}

const TAB_IDS: ReadonlyArray<{ buttonId: string; panelId: string }> = [
  { buttonId: 'tab-transaction', panelId: 'panel-transaction' },
  { buttonId: 'tab-history', panelId: 'panel-history' },
];

/** Wires the side panel's tab buttons, if the page has them. */
export function init(): void {
  const tabs: Tab[] = [];

  for (const { buttonId, panelId } of TAB_IDS) {
    const button = document.getElementById(buttonId);
    const panel = document.getElementById(panelId);
    if (button === null || panel === null) {
      return;
    }
    tabs.push({ button, panel });
  }

  const select = (selected: Tab): void => {
    for (const tab of tabs) {
      const isSelected = tab === selected;
      tab.button.classList.toggle('is-selected', isSelected);
      tab.button.setAttribute('aria-selected', String(isSelected));
      tab.panel.hidden = !isSelected;
    }
  };

  for (const tab of tabs) {
    tab.button.addEventListener('click', () => {
      select(tab);
    });
  }
}
