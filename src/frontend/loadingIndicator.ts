/**
 * Shows/hides the single global loading indicator element (`#loading-indicator`
 * in `public/index.html`) using a pending-request counter, so overlapping
 * requests don't hide it prematurely.
 *
 * `apiClient.ts` calls `requestStarted()`/`requestFinished()` around every
 * Backend_API call, with `requestFinished()` in a `finally` block so the
 * indicator is always cleared regardless of outcome.
 *
 * **Validates: Requirements 8.1, 8.2**
 */

const LOADING_INDICATOR_ELEMENT_ID = 'loading-indicator';

let pendingRequestCount = 0;

function getIndicatorElement(): HTMLElement | null {
  return document.getElementById(LOADING_INDICATOR_ELEMENT_ID);
}

/** Increments the pending count and shows the indicator if it was hidden. */
export function requestStarted(): void {
  pendingRequestCount += 1;

  if (pendingRequestCount === 1) {
    getIndicatorElement()?.removeAttribute('hidden');
  }
}

/** Decrements the pending count and hides the indicator once it reaches zero. */
export function requestFinished(): void {
  if (pendingRequestCount === 0) {
    return;
  }

  pendingRequestCount -= 1;

  if (pendingRequestCount === 0) {
    getIndicatorElement()?.setAttribute('hidden', '');
  }
}
