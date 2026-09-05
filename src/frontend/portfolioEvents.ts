/**
 * A minimal pub/sub with one event (`portfolioChanged`), used to tell the
 * Portfolio overview view to refresh after any other view's mutation
 * succeeds.
 *
 * Every view that mutates a Holding or records a Transaction (the
 * add-holding form, the Transaction form, and the overview view's own edit,
 * removal, and price-update controls) publishes `portfolioChanged` once its
 * own immediate feedback is rendered. `overviewView.ts` subscribes once and
 * simply re-runs its fetch-and-render sequence, so every "the Frontend SHALL
 * display the resulting/updated Holdings_List/Portfolio_Value" criterion is
 * satisfied by that single code path.
 *
 * **Validates: Requirements 2.3, 3.4, 4.5, 5.4, 5.5, 7.3, 7.4**
 */

/** A subscriber invoked whenever `portfolioChanged` is published. */
export type PortfolioChangedListener = () => void;

const portfolioChangedListeners = new Set<PortfolioChangedListener>();

/**
 * Registers `listener` to be invoked on every subsequent `publish` call.
 * Returns an unsubscribe function that removes `listener`; calling it means
 * `listener` will not be invoked by any later `publish` call.
 */
export function subscribe(listener: PortfolioChangedListener): () => void {
  portfolioChangedListeners.add(listener);

  return () => {
    portfolioChangedListeners.delete(listener);
  };
}

/** Notifies every currently subscribed listener that the Portfolio has changed. */
export function publish(): void {
  for (const listener of portfolioChangedListeners) {
    listener();
  }
}
