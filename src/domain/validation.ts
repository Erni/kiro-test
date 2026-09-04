import { Decimal } from './decimalConfig';
import { ValidationError } from './errors';
import { err, ok } from './result';
import {
  MAX_DECIMAL_PLACES,
  MAX_VALUE,
  SYMBOL_MAX_LENGTH,
  SYMBOL_MIN_LENGTH,
  SYMBOL_PATTERN,
} from './types';

import type { Result } from './result';
import type {
  HoldingUpdateInput,
  NewHoldingInput,
  PriceUpdateInput,
  Symbol as AssetSymbol,
  TransactionInput,
  TransactionType,
  ValidHoldingInput,
  ValidHoldingUpdateInput,
  ValidPriceUpdateInput,
  ValidTransactionInput,
} from './types';

/**
 * Boundary input validation for the domain.
 *
 * Every validator is pure and total: it takes an untrusted `…Input` (all fields
 * `unknown`) and returns either a `Valid…Input` carrying parsed `Decimal`
 * values, or a single `ValidationError` naming the first offending field so the
 * HTTP layer can render a field-level message.
 *
 * Numeric fields are parsed from their *string* form wherever possible
 * (`new Decimal('0.12345678')`), never via intermediate float arithmetic, so
 * values up to 1,000,000,000,000 with 8 decimal places survive validation
 * exactly. Plain JSON numbers are also accepted, since JSON bodies commonly
 * carry them; they are converted through the number's own decimal
 * representation without further rounding.
 */

/** Inclusive upper bound shared by Holding quantity and Current_Price. */
const MAX = new Decimal(MAX_VALUE);

/** How the lower bound of a numeric field is enforced. */
type LowerBound =
  /** `value > 0`, e.g. a Holding or Transaction quantity. */
  | 'greaterThanZero'
  /** `value >= 0`, e.g. a Current_Price or a Transaction's price per unit. */
  | 'atLeastZero';

interface NumericRule {
  readonly lowerBound: LowerBound;
  /**
   * When true, also enforce `value <= MAX_VALUE` and at most
   * `MAX_DECIMAL_PLACES` decimal places.
   *
   * These extra limits are part of the Holding data model (Req 1.1, 1.3, 1.4,
   * 1.5, 1.6) and so apply to Holding creation and update. They are
   * deliberately *not* applied to Transaction quantity / price per unit
   * (Req 2.6) or to a Current_Price update (Req 4.2), whose acceptance criteria
   * constrain only the sign of the value.
   */
  readonly bounded: boolean;
}

const HOLDING_QUANTITY: NumericRule = { lowerBound: 'greaterThanZero', bounded: true };
const HOLDING_PRICE: NumericRule = { lowerBound: 'atLeastZero', bounded: true };
const TRANSACTION_QUANTITY: NumericRule = { lowerBound: 'greaterThanZero', bounded: false };
const TRANSACTION_PRICE: NumericRule = { lowerBound: 'atLeastZero', bounded: false };
const UPDATED_PRICE: NumericRule = { lowerBound: 'atLeastZero', bounded: false };

/**
 * Turns an untrusted value into the exact string decimal.js should parse, or
 * `undefined` when the value cannot represent a number at all.
 */
function toNumericSource(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value.toString() : undefined;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return undefined;
}

/** Parses and range-checks a single numeric field (Req 1.3, 1.4, 1.6, 2.6, 4.2). */
function parseNumericField(
  field: string,
  value: unknown,
  rule: NumericRule,
): Result<Decimal, ValidationError> {
  // Missing is reported separately from malformed so the caller sees why
  // (Req 4.2 distinguishes a missing Current_Price from a non-numeric one).
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return err(new ValidationError(field, 'is required'));
  }

  const source = toNumericSource(value);
  if (source === undefined) {
    return err(new ValidationError(field, 'must be a numeric value'));
  }

  let parsed: Decimal;
  try {
    parsed = new Decimal(source);
  } catch {
    return err(new ValidationError(field, 'must be a numeric value'));
  }

  // decimal.js accepts 'NaN' and 'Infinity' as valid Decimals; neither is a
  // usable quantity or price.
  if (!parsed.isFinite()) {
    return err(new ValidationError(field, 'must be a finite numeric value'));
  }

  if (rule.lowerBound === 'greaterThanZero') {
    if (parsed.lessThanOrEqualTo(0)) {
      return err(new ValidationError(field, 'must be greater than 0'));
    }
  } else if (parsed.lessThan(0)) {
    return err(new ValidationError(field, 'must not be negative'));
  }

  if (rule.bounded) {
    if (parsed.greaterThan(MAX)) {
      return err(new ValidationError(field, `must not exceed ${MAX_VALUE}`));
    }
    if (parsed.decimalPlaces() > MAX_DECIMAL_PLACES) {
      return err(
        new ValidationError(field, `must have at most ${MAX_DECIMAL_PLACES} decimal places`),
      );
    }
  }

  return ok(parsed);
}

/**
 * Validates a Cryptoasset symbol: 1-10 characters of uppercase letters and
 * digits, with no surrounding whitespace (Req 1.11).
 */
function parseSymbol(value: unknown): Result<AssetSymbol, ValidationError> {
  if (typeof value !== 'string') {
    return err(new ValidationError('symbol', 'is required and must be a string'));
  }
  if (!SYMBOL_PATTERN.test(value)) {
    return err(
      new ValidationError(
        'symbol',
        `must be ${SYMBOL_MIN_LENGTH}-${SYMBOL_MAX_LENGTH} characters using only uppercase letters and digits`,
      ),
    );
  }
  return ok(value);
}

/** Validates a Transaction_Type: exactly `"Buy"` or `"Sell"` (Req 2.5). */
function parseTransactionType(value: unknown): Result<TransactionType, ValidationError> {
  if (value === 'Buy' || value === 'Sell') {
    return ok(value);
  }
  return err(new ValidationError('type', 'must be exactly "Buy" or "Sell"'));
}

/**
 * Validates input for creating a Holding: symbol format, `0 < quantity <=
 * 1_000_000_000_000` and `0 <= currentPrice <= 1_000_000_000_000`, each with at
 * most 8 decimal places (Req 1.1, 1.3, 1.4, 1.11).
 */
export function validateNewHoldingInput(
  input: NewHoldingInput,
): Result<ValidHoldingInput, ValidationError> {
  const symbol = parseSymbol(input.symbol);
  if (!symbol.ok) {
    return err(symbol.error);
  }

  const quantity = parseNumericField('quantity', input.quantity, HOLDING_QUANTITY);
  if (!quantity.ok) {
    return err(quantity.error);
  }

  const currentPrice = parseNumericField('currentPrice', input.currentPrice, HOLDING_PRICE);
  if (!currentPrice.ok) {
    return err(currentPrice.error);
  }

  return ok({
    symbol: symbol.value,
    quantity: quantity.value,
    currentPrice: currentPrice.value,
  });
}

/**
 * Validates input for updating a Holding. The quantity and Current_Price rules
 * are identical to creation (Req 1.5, 1.6); the symbol is not part of the
 * update payload because it identifies the Holding being updated.
 */
export function validateHoldingUpdateInput(
  input: HoldingUpdateInput,
): Result<ValidHoldingUpdateInput, ValidationError> {
  const quantity = parseNumericField('quantity', input.quantity, HOLDING_QUANTITY);
  if (!quantity.ok) {
    return err(quantity.error);
  }

  const currentPrice = parseNumericField('currentPrice', input.currentPrice, HOLDING_PRICE);
  if (!currentPrice.ok) {
    return err(currentPrice.error);
  }

  return ok({ quantity: quantity.value, currentPrice: currentPrice.value });
}

/**
 * Validates input for recording a Transaction: symbol format, a
 * Transaction_Type of exactly `"Buy"` or `"Sell"`, `quantity > 0`, and
 * `pricePerUnit >= 0` (Req 2.5, 2.6).
 */
export function validateTransactionInput(
  input: TransactionInput,
): Result<ValidTransactionInput, ValidationError> {
  const symbol = parseSymbol(input.symbol);
  if (!symbol.ok) {
    return err(symbol.error);
  }

  const type = parseTransactionType(input.type);
  if (!type.ok) {
    return err(type.error);
  }

  const quantity = parseNumericField('quantity', input.quantity, TRANSACTION_QUANTITY);
  if (!quantity.ok) {
    return err(quantity.error);
  }

  const pricePerUnit = parseNumericField('pricePerUnit', input.pricePerUnit, TRANSACTION_PRICE);
  if (!pricePerUnit.ok) {
    return err(pricePerUnit.error);
  }

  return ok({
    symbol: symbol.value,
    type: type.value,
    quantity: quantity.value,
    pricePerUnit: pricePerUnit.value,
  });
}

/**
 * Validates a Current_Price update: the price must be present, numeric, and
 * `>= 0` (Req 4.2).
 */
export function validatePriceUpdateInput(
  input: PriceUpdateInput,
): Result<ValidPriceUpdateInput, ValidationError> {
  const currentPrice = parseNumericField('currentPrice', input.currentPrice, UPDATED_PRICE);
  if (!currentPrice.ok) {
    return err(currentPrice.error);
  }

  return ok({ currentPrice: currentPrice.value });
}
