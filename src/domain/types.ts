import type { Decimal } from 'decimal.js';

/**
 * Core domain types for the crypto portfolio.
 *
 * Quantities and prices are `Decimal` (decimal.js) rather than `number`: the
 * domain must handle values up to 1,000,000,000,000 with up to 8 decimal
 * places exactly, which IEEE-754 floats cannot represent reliably. Values are
 * parsed from strings at the boundary and serialized back to strings, so no
 * precision is lost on the way in or out.
 */

/** Upper bound (inclusive) for quantities and prices. */
export const MAX_VALUE = '1000000000000';

/** Maximum number of decimal places allowed for quantities and prices. */
export const MAX_DECIMAL_PLACES = 8;

/** Minimum length of a Cryptoasset symbol. */
export const SYMBOL_MIN_LENGTH = 1;

/** Maximum length of a Cryptoasset symbol. */
export const SYMBOL_MAX_LENGTH = 10;

/** Allowed characters and length for a Cryptoasset symbol. */
export const SYMBOL_PATTERN = /^[A-Z0-9]{1,10}$/;

/**
 * A Cryptoasset symbol: 1-10 characters of uppercase letters and digits, e.g.
 * `"BTC"`. Unique within the Portfolio.
 *
 * Note: this shadows the global `Symbol` type inside modules that import it.
 * `AssetSymbol` is exported as an alias for call sites that prefer to avoid
 * the shadowing.
 */
export type Symbol = string;

/** Alias for {@link Symbol}, for call sites that need the global `Symbol`. */
export type AssetSymbol = Symbol;

/** The quantity of a Cryptoasset currently owned, plus its Current_Price. */
export interface Holding {
  readonly symbol: Symbol;
  /** `0 < quantity <= MAX_VALUE`, up to 8 decimal places. */
  readonly quantity: Decimal;
  /** `0 <= currentPrice <= MAX_VALUE`, up to 8 decimal places. */
  readonly currentPrice: Decimal;
}

/** The classification of a Transaction. */
export type TransactionType = 'Buy' | 'Sell';

/** A single recorded buy or sell event for a Cryptoasset. */
export interface Transaction {
  /** Unique, system-generated identifier. */
  readonly id: string;
  readonly symbol: Symbol;
  readonly type: TransactionType;
  /** `> 0` */
  readonly quantity: Decimal;
  /** `>= 0` */
  readonly pricePerUnit: Decimal;
  /** Assigned by the System at recording time. */
  readonly timestamp: Date;
}

/**
 * The complete portfolio. Transactions are stored alongside Holdings rather
 * than nested inside them, because Transaction history outlives the Holding it
 * affected (Req 2.7, 2.8).
 */
export interface PortfolioState {
  readonly holdings: ReadonlyMap<Symbol, Holding>;
  readonly transactions: readonly Transaction[];
}

/** A Holding as returned by the Portfolio overview, with its derived value. */
export interface HoldingView {
  readonly symbol: Symbol;
  readonly quantity: Decimal;
  readonly currentPrice: Decimal;
  /** `quantity * currentPrice` (Req 3.1). */
  readonly holdingValue: Decimal;
}

/** The Portfolio overview: every Holding plus the total Portfolio_Value. */
export interface PortfolioOverview {
  readonly holdings: readonly HoldingView[];
  /** Sum of every Holding_Value; zero when there are no Holdings (Req 3.2, 3.3). */
  readonly portfolioValue: Decimal;
}

/*
 * Boundary input types.
 *
 * Raw `…Input` types describe what arrives from the HTTP boundary, where every
 * field is untrusted and may be missing or of the wrong type. The matching
 * `Valid…Input` types are only produced by the validators and carry parsed,
 * range-checked `Decimal` values.
 */

/** Unvalidated input for creating a Holding (Req 1.1, 1.3, 1.4, 1.11). */
export interface NewHoldingInput {
  readonly symbol: unknown;
  readonly quantity: unknown;
  readonly currentPrice: unknown;
}

/** Validated input for creating a Holding. */
export interface ValidHoldingInput {
  readonly symbol: Symbol;
  readonly quantity: Decimal;
  readonly currentPrice: Decimal;
}

/** Unvalidated input for updating a Holding (Req 1.5, 1.6). */
export interface HoldingUpdateInput {
  readonly quantity: unknown;
  readonly currentPrice: unknown;
}

/** Validated input for updating a Holding. */
export interface ValidHoldingUpdateInput {
  readonly quantity: Decimal;
  readonly currentPrice: Decimal;
}

/** Unvalidated input for recording a Transaction (Req 2.1, 2.2, 2.5, 2.6). */
export interface TransactionInput {
  readonly symbol: unknown;
  readonly type: unknown;
  readonly quantity: unknown;
  readonly pricePerUnit: unknown;
}

/** Validated input for recording a Transaction. */
export interface ValidTransactionInput {
  readonly symbol: Symbol;
  readonly type: TransactionType;
  readonly quantity: Decimal;
  readonly pricePerUnit: Decimal;
}

/** Unvalidated input for updating a Holding's Current_Price (Req 4.1, 4.2). */
export interface PriceUpdateInput {
  readonly currentPrice: unknown;
}

/** Validated input for updating a Holding's Current_Price. */
export interface ValidPriceUpdateInput {
  readonly currentPrice: Decimal;
}
