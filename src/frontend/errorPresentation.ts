/**
 * Turns an `ApiError`/network failure into the exact string shown to the
 * user; the one place that knows how backend error bodies map to text.
 *
 * `messageForApiError` returns the Backend_API's own `message` unchanged —
 * the Frontend never rewrites or generalizes backend validation text.
 * `messageForNetworkFailure` is the one message the Frontend itself owns,
 * since by definition no backend response was received to relay.
 *
 * **Validates: Requirements 1.5, 2.4, 3.5, 4.6, 5.6, 6.4, 7.5, 8.3**
 */

import type { ApiError } from './apiClient.js';

/** Returns the Backend_API's own error message, verbatim. */
export function messageForApiError(error: ApiError): string {
  return error.message;
}

/** Returns the fixed message shown when the Backend_API could not be reached at all. */
export function messageForNetworkFailure(): string {
  return 'The server could not be reached. Please check your connection and try again.';
}
