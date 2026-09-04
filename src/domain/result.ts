/**
 * `Result` is used instead of exceptions for all *expected* domain outcomes
 * (validation failures, not-found, duplicate, insufficient quantity), so that
 * error handling stays explicit and total at every call site.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Wraps a successful value. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Wraps a failure. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
