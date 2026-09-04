import { Decimal } from 'decimal.js';

/**
 * The single owner of decimal.js's global configuration.
 *
 * decimal.js rounds the *result* of every arithmetic operation (`times`, `plus`,
 * `minus`, `div`) to `Decimal.precision` significant digits. The library default
 * is 20, which is not enough for this domain and would silently round derived
 * values, breaking the exact-arithmetic guarantee behind Req 3.1 and 3.2. The
 * `Decimal` constructor, by contrast, never rounds, so parsing inputs was always
 * exact — only computed values were affected.
 *
 * ## Why 80 significant digits
 *
 * - A quantity or Current_Price is at most 1,000,000,000,000 with at most 8
 *   decimal places, so at most 13 integer digits and 8 decimal places.
 * - Holding_Value is `quantity * currentPrice`: at most 25 integer digits and
 *   exactly 16 decimal places, i.e. up to **41 significant digits** for an exact
 *   product. (The realistic case `12345.12345678 * 54321.87654321` already needs
 *   25, so this is not only an extreme-value concern.)
 * - Portfolio_Value sums those products across Holdings. Summing never adds
 *   decimal places — the result keeps the same 16 — but it grows the integer
 *   part by `log10(holdingCount)`.
 * - 80 leaves 39 digits of headroom above the 41 a single product needs, i.e.
 *   room for the integer part to grow to 64 digits. Even an absurd portfolio of
 *   10^39 maximum-value Holdings would still sum exactly.
 *
 * Cost is negligible: decimal.js allocates per-value and only pays for the
 * digits actually present, so raising the ceiling does not slow down the small
 * values that dominate in practice.
 *
 * ## Why `toExpNeg` / `toExpPos` are set
 *
 * `toString()` switches to exponential notation outside the
 * `toExpNeg`…`toExpPos` window, whose defaults are -7 and 21. A Holding_Value can
 * reach 10^24 and carry digits down to 10^-16, so both defaults would be crossed
 * by ordinary domain values and `toString()` would render e.g. `"1e-8"` inside an
 * error message. Widening the window to the configured precision keeps every
 * value the domain can produce in plain notation.
 *
 * ## Why every module imports `Decimal` from here
 *
 * decimal.js exports a single mutable constructor, so `Decimal.set` below is a
 * process-wide change that takes effect the moment this module's body runs. Every
 * module that constructs a `Decimal` or performs arithmetic imports the
 * constructor *from this module* rather than from `decimal.js` directly. Module
 * initialization is depth-first, so this body is guaranteed to have run before any
 * importing module's body — and, since all domain arithmetic happens inside
 * exported functions called at request time, long before the first operation.
 * Routing the import through here removes any dependence on load order.
 */

/** Significant digits retained by every `Decimal` arithmetic operation. */
export const DECIMAL_PRECISION = 80;

Decimal.set({
  precision: DECIMAL_PRECISION,
  toExpNeg: -DECIMAL_PRECISION,
  toExpPos: DECIMAL_PRECISION,
});

export { Decimal };
