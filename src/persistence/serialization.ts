import { Decimal } from '../domain/decimalConfig';

import type {
  Holding,
  PortfolioState,
  AssetSymbol,
  Transaction,
  TransactionType,
} from '../domain/types';

/**
 * Conversion between `PortfolioState` and its persisted JSON shape.
 *
 * Two domain value types have no faithful JSON counterpart:
 *
 * - `Decimal` — encoding it as a JSON number would push the value through an
 *   IEEE-754 double and silently lose precision for the 12-digit, 8-decimal
 *   values the domain must handle exactly. Decimals are therefore written as
 *   strings in plain (non-exponential) notation and parsed back from those
 *   strings.
 * - `Date` — encoded as an ISO-8601 UTC string (`toISOString()`), which pins the
 *   instant to a fixed offset so the exact moment survives regardless of the
 *   time zone of the process that reads it back.
 *
 * `holdings` is persisted as an array rather than an object map: it keeps the
 * on-disk shape a plain list of records (mirroring `transactions`) and avoids
 * storing each symbol twice. The map is rebuilt from each Holding's own symbol
 * on load.
 *
 * Deserialization is defensive: the file on disk is outside the System's
 * control, so every field is checked and a plain `Error` describing the exact
 * offending path is thrown when anything is missing or malformed. The
 * repository turns that into a `StartupError` (Req 5.6). Only *structural*
 * validity is checked here, not domain rules — persisted values were already
 * validated when they were written, and re-applying today's business rules to
 * historical data would make old, legitimately persisted Portfolios
 * unloadable.
 */

/** A {@link Holding} as persisted. */
export interface SerializedHolding {
  readonly symbol: string;
  /** Decimal in plain notation, e.g. `"0.00000001"`. */
  readonly quantity: string;
  /** Decimal in plain notation. */
  readonly currentPrice: string;
}

/** A {@link Transaction} as persisted. */
export interface SerializedTransaction {
  readonly id: string;
  readonly symbol: string;
  readonly type: TransactionType;
  /** Decimal in plain notation. */
  readonly quantity: string;
  /** Decimal in plain notation. */
  readonly pricePerUnit: string;
  /** ISO-8601 UTC instant, e.g. `"2024-05-01T12:00:00.000Z"`. */
  readonly timestamp: string;
}

/** The complete {@link PortfolioState} as persisted. */
export interface SerializedPortfolioState {
  readonly holdings: readonly SerializedHolding[];
  readonly transactions: readonly SerializedTransaction[];
}

const TRANSACTION_TYPES: readonly TransactionType[] = ['Buy', 'Sell'];

/**
 * Renders a `Decimal` as a string, always in plain notation.
 *
 * `toFixed()` is used rather than `toString()` because `toString()` switches to
 * exponential notation outside decimal.js's `toExpNeg`/`toExpPos` window (a
 * quantity of `0.00000001` would be written as `"1e-8"`). Both forms parse back
 * to the same value, but the plain form keeps the persisted file readable and
 * stable.
 */
function encodeDecimal(value: Decimal): string {
  return value.toFixed();
}

/** Converts a `PortfolioState` into its persisted JSON shape (Req 5.1, 5.2). */
export function serializePortfolioState(state: PortfolioState): SerializedPortfolioState {
  return {
    holdings: [...state.holdings.values()].map(serializeHolding),
    transactions: state.transactions.map(serializeTransaction),
  };
}

function serializeHolding(holding: Holding): SerializedHolding {
  return {
    symbol: holding.symbol,
    quantity: encodeDecimal(holding.quantity),
    currentPrice: encodeDecimal(holding.currentPrice),
  };
}

function serializeTransaction(transaction: Transaction): SerializedTransaction {
  return {
    id: transaction.id,
    symbol: transaction.symbol,
    type: transaction.type,
    quantity: encodeDecimal(transaction.quantity),
    pricePerUnit: encodeDecimal(transaction.pricePerUnit),
    timestamp: transaction.timestamp.toISOString(),
  };
}

/**
 * Rebuilds a `PortfolioState` from persisted JSON (Req 5.3).
 *
 * @param value the result of `JSON.parse` on the persisted document; untrusted.
 * @throws Error when the document is not a well-formed serialized Portfolio.
 *   The message names the offending path, e.g. `holdings[2].quantity`.
 */
export function deserializePortfolioState(value: unknown): PortfolioState {
  const root = requireRecord(value, 'portfolio');

  const holdings = new Map<AssetSymbol, Holding>();
  requireArray(root['holdings'], 'holdings').forEach((entry, index) => {
    const holding = deserializeHolding(entry, `holdings[${index}]`);
    if (holdings.has(holding.symbol)) {
      throw malformed(`holdings[${index}].symbol`, `duplicates holding "${holding.symbol}"`);
    }
    holdings.set(holding.symbol, holding);
  });

  const transactions = requireArray(root['transactions'], 'transactions').map((entry, index) =>
    deserializeTransaction(entry, `transactions[${index}]`),
  );

  return { holdings, transactions };
}

function deserializeHolding(value: unknown, path: string): Holding {
  const record = requireRecord(value, path);
  return {
    symbol: requireNonEmptyString(record['symbol'], `${path}.symbol`),
    quantity: requireDecimal(record['quantity'], `${path}.quantity`),
    currentPrice: requireDecimal(record['currentPrice'], `${path}.currentPrice`),
  };
}

function deserializeTransaction(value: unknown, path: string): Transaction {
  const record = requireRecord(value, path);
  return {
    id: requireNonEmptyString(record['id'], `${path}.id`),
    symbol: requireNonEmptyString(record['symbol'], `${path}.symbol`),
    type: requireTransactionType(record['type'], `${path}.type`),
    quantity: requireDecimal(record['quantity'], `${path}.quantity`),
    pricePerUnit: requireDecimal(record['pricePerUnit'], `${path}.pricePerUnit`),
    timestamp: requireDate(record['timestamp'], `${path}.timestamp`),
  };
}

function malformed(path: string, reason: string): Error {
  return new Error(`Malformed persisted portfolio: ${path} ${reason}`);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return raise(path, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    return raise(path, 'must be an array');
  }
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') {
    return raise(path, 'must be a non-empty string');
  }
  return value;
}

function requireTransactionType(value: unknown, path: string): TransactionType {
  if (!TRANSACTION_TYPES.includes(value as TransactionType)) {
    return raise(path, 'must be "Buy" or "Sell"');
  }
  return value as TransactionType;
}

function requireDecimal(value: unknown, path: string): Decimal {
  const source = requireNonEmptyString(value, path);
  let parsed: Decimal;
  try {
    parsed = new Decimal(source);
  } catch {
    return raise(path, 'must be a decimal string');
  }
  if (!parsed.isFinite()) {
    return raise(path, 'must be a finite decimal string');
  }
  return parsed;
}

function requireDate(value: unknown, path: string): Date {
  const source = requireNonEmptyString(value, path);
  const parsed = new Date(source);
  if (Number.isNaN(parsed.getTime())) {
    return raise(path, 'must be an ISO-8601 timestamp');
  }
  return parsed;
}

/**
 * Throws {@link malformed}. Declared as returning `never` so the `require…`
 * helpers can `return raise(...)` and keep their narrowed return types.
 */
function raise(path: string, reason: string): never {
  throw malformed(path, reason);
}
