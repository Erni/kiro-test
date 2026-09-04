import type { Decimal } from 'decimal.js';

import type { Symbol as AssetSymbol } from './types';

/**
 * Domain errors are modelled as classes so the same value can be returned
 * inside a `Result` (the normal case for expected domain outcomes) or thrown /
 * used to reject a promise at the persistence boundary. Each error carries a
 * `kind` discriminant so callers can narrow without `instanceof` chains.
 */
export type DomainErrorKind =
  | 'ValidationError'
  | 'DuplicateHoldingError'
  | 'NotFoundError'
  | 'InsufficientQuantityError'
  | 'PersistenceError'
  | 'StartupError';

abstract class DomainError extends Error {
  abstract readonly kind: DomainErrorKind;

  protected constructor(message: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * An input failed a validation rule. Carries the offending field so the HTTP
 * layer can return a field-level message (Req 1.3, 1.4, 1.6, 1.11, 2.5, 2.6, 4.2).
 */
export class ValidationError extends DomainError {
  readonly kind = 'ValidationError' as const;

  /** Name of the input field that failed validation, e.g. `"quantity"`. */
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.field = field;
  }
}

/** A Holding already exists for the submitted symbol (Req 1.2). */
export class DuplicateHoldingError extends DomainError {
  readonly kind = 'DuplicateHoldingError' as const;

  readonly symbol: AssetSymbol;

  constructor(symbol: AssetSymbol) {
    super(`Cryptoasset ${symbol} is already held`);
    this.symbol = symbol;
  }
}

/** No Holding exists for the targeted symbol (Req 1.9, 1.10, 4.3). */
export class NotFoundError extends DomainError {
  readonly kind = 'NotFoundError' as const;

  readonly symbol: AssetSymbol;

  constructor(symbol: AssetSymbol) {
    super(`Holding for ${symbol} does not exist`);
    this.symbol = symbol;
  }
}

/**
 * A Sell Transaction exceeds the available quantity, or targets a symbol with
 * no Holding at all, in which case `available` is zero (Req 2.4).
 */
export class InsufficientQuantityError extends DomainError {
  readonly kind = 'InsufficientQuantityError' as const;

  readonly symbol: AssetSymbol;

  readonly requested: Decimal;

  readonly available: Decimal;

  constructor(symbol: AssetSymbol, requested: Decimal, available: Decimal) {
    super(
      `Insufficient quantity of ${symbol}: requested ${requested.toString()}, available ${available.toString()}`,
    );
    this.symbol = symbol;
    this.requested = requested;
    this.available = available;
  }
}

/** Persisting a change failed; persisted and in-memory state are unchanged (Req 5.4). */
export class PersistenceError extends DomainError {
  readonly kind = 'PersistenceError' as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

/** Persisted data exists but could not be loaded at startup (Req 5.6). */
export class StartupError extends DomainError {
  readonly kind = 'StartupError' as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}
