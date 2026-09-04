import { Decimal } from 'decimal.js';

import { ValidationError } from '../../src/domain/errors';
import { MAX_DECIMAL_PLACES, MAX_VALUE } from '../../src/domain/types';
import {
  validateHoldingUpdateInput,
  validateNewHoldingInput,
  validatePriceUpdateInput,
  validateTransactionInput,
} from '../../src/domain/validation';

import type { Result } from '../../src/domain/result';

/**
 * Boundary tests for the domain validators (Req 1.3, 1.4, 1.6, 1.11, 2.5, 2.6, 4.2).
 *
 * The interesting behavior of these validators lives entirely at the edges of
 * the accepted ranges, so each numeric rule is probed at the boundary itself and
 * one smallest representable step to either side of it. `1e-8` is used as that
 * step because 8 decimal places is the documented precision limit; a step
 * smaller than that would be rejected by the decimal-places rule instead and
 * would not test the range check.
 */

/*
 * The boundary neighbours are written as literals rather than computed as
 * `MAX_VALUE ± 1e-8`. `MAX_VALUE` with 8 decimal places needs 21 significant
 * digits, which is beyond decimal.js's default arithmetic precision of 20, so a
 * computed neighbour would silently round back onto the boundary and the test
 * would assert nothing. A literal is exact because the `Decimal` constructor
 * does not round.
 */

/** Just above the inclusive maximum, at the finest allowed precision. */
const JUST_ABOVE_MAX = '1000000000000.00000001';

/** Just below the inclusive maximum, at the finest allowed precision. */
const JUST_BELOW_MAX = '999999999999.99999999';

/** Smallest positive value with the allowed number of decimal places. */
const SMALLEST_POSITIVE = '0.00000001';

/** Nine decimal places: one more than allowed. */
const NINE_DECIMAL_PLACES = '1.000000001';

/** Eight decimal places: exactly at the allowed limit. */
const EIGHT_DECIMAL_PLACES = '1.00000001';

/** Unwraps a successful result, failing the test with the error otherwise. */
function expectOk<T>(result: Result<T, ValidationError>): T {
  if (!result.ok) {
    throw new Error(`expected a valid result but got ValidationError: ${result.error.message}`);
  }
  return result.value;
}

/** Asserts the result is a `ValidationError` naming `field`, and returns it. */
function expectValidationError<T>(
  result: Result<T, ValidationError>,
  field: string,
): ValidationError {
  if (result.ok) {
    throw new Error(`expected a ValidationError on "${field}" but validation succeeded`);
  }
  expect(result.error).toBeInstanceOf(ValidationError);
  expect(result.error.kind).toBe('ValidationError');
  expect(result.error.field).toBe(field);
  return result.error;
}

describe('validateNewHoldingInput', () => {
  const validBase = { symbol: 'BTC', quantity: '1', currentPrice: '100' };

  describe('symbol format (Req 1.11)', () => {
    it.each([
      ['single character', 'B'],
      ['ten characters', 'ABCDEFGHIJ'],
      ['digits only', '1234567890'],
      ['letters and digits mixed', 'USDT2'],
    ])('accepts a symbol of %s', (_label, symbol) => {
      const result = validateNewHoldingInput({ ...validBase, symbol });

      expect(expectOk(result).symbol).toBe(symbol);
    });

    it.each([
      ['empty', ''],
      ['eleven characters', 'ABCDEFGHIJK'],
      ['lowercase', 'btc'],
      ['mixed case', 'Btc'],
      ['a hyphen', 'BTC-USD'],
      ['a dot', 'BTC.X'],
      ['an underscore', 'BTC_X'],
      ['a space inside', 'BT C'],
      ['leading whitespace', ' BTC'],
      ['trailing whitespace', 'BTC '],
    ])('rejects a symbol that is %s', (_label, symbol) => {
      expectValidationError(validateNewHoldingInput({ ...validBase, symbol }), 'symbol');
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['a number', 123],
      ['an object', { symbol: 'BTC' }],
      ['an array', ['BTC']],
    ])('rejects a symbol that is %s', (_label, symbol) => {
      expectValidationError(validateNewHoldingInput({ ...validBase, symbol }), 'symbol');
    });
  });

  describe('quantity range (Req 1.3)', () => {
    it.each([
      ['the smallest positive value', SMALLEST_POSITIVE],
      ['just below the maximum', JUST_BELOW_MAX],
      ['exactly the maximum', MAX_VALUE],
    ])('accepts a quantity of %s', (_label, quantity) => {
      const result = validateNewHoldingInput({ ...validBase, quantity });

      expect(expectOk(result).quantity.toFixed()).toBe(new Decimal(quantity).toFixed());
    });

    it('rejects a quantity of exactly 0', () => {
      const error = expectValidationError(
        validateNewHoldingInput({ ...validBase, quantity: '0' }),
        'quantity',
      );

      expect(error.message).toContain('greater than 0');
    });

    it.each([
      ['negative at the smallest step', '-0.00000001'],
      ['negative whole', '-1'],
      ['negative maximum', `-${MAX_VALUE}`],
    ])('rejects a quantity that is %s', (_label, quantity) => {
      expectValidationError(validateNewHoldingInput({ ...validBase, quantity }), 'quantity');
    });

    it('rejects a quantity just above the maximum', () => {
      const error = expectValidationError(
        validateNewHoldingInput({ ...validBase, quantity: JUST_ABOVE_MAX }),
        'quantity',
      );

      expect(error.message).toContain(MAX_VALUE);
    });

    it('rejects a quantity far above the maximum', () => {
      expectValidationError(
        validateNewHoldingInput({ ...validBase, quantity: '1000000000001' }),
        'quantity',
      );
    });
  });

  describe('quantity precision (Req 1.3)', () => {
    it(`accepts exactly ${MAX_DECIMAL_PLACES} decimal places`, () => {
      const result = validateNewHoldingInput({ ...validBase, quantity: EIGHT_DECIMAL_PLACES });

      expect(expectOk(result).quantity.toFixed()).toBe(EIGHT_DECIMAL_PLACES);
    });

    it(`rejects ${MAX_DECIMAL_PLACES + 1} decimal places`, () => {
      const error = expectValidationError(
        validateNewHoldingInput({ ...validBase, quantity: NINE_DECIMAL_PLACES }),
        'quantity',
      );

      expect(error.message).toContain('decimal places');
    });

    it('preserves precision that a float round-trip would lose', () => {
      const result = validateNewHoldingInput({ ...validBase, quantity: '999999999999.99999999' });

      expect(expectOk(result).quantity.toFixed()).toBe('999999999999.99999999');
    });
  });

  describe('currentPrice range (Req 1.4)', () => {
    it.each([
      ['exactly 0', '0'],
      ['the smallest positive value', SMALLEST_POSITIVE],
      ['exactly the maximum', MAX_VALUE],
    ])('accepts a currentPrice of %s', (_label, currentPrice) => {
      const result = validateNewHoldingInput({ ...validBase, currentPrice });

      expect(expectOk(result).currentPrice.toFixed()).toBe(new Decimal(currentPrice).toFixed());
    });

    it('rejects a currentPrice just below 0', () => {
      const error = expectValidationError(
        validateNewHoldingInput({ ...validBase, currentPrice: '-0.00000001' }),
        'currentPrice',
      );

      expect(error.message).toContain('negative');
    });

    it('rejects a currentPrice just above the maximum', () => {
      expectValidationError(
        validateNewHoldingInput({ ...validBase, currentPrice: JUST_ABOVE_MAX }),
        'currentPrice',
      );
    });

    it(`rejects a currentPrice with ${MAX_DECIMAL_PLACES + 1} decimal places`, () => {
      expectValidationError(
        validateNewHoldingInput({ ...validBase, currentPrice: NINE_DECIMAL_PLACES }),
        'currentPrice',
      );
    });
  });

  describe('numeric field forms', () => {
    it('accepts JSON numbers as well as strings', () => {
      const result = validateNewHoldingInput({ symbol: 'ETH', quantity: 2.5, currentPrice: 0 });

      const value = expectOk(result);
      expect(value.quantity.toFixed()).toBe('2.5');
      expect(value.currentPrice.toFixed()).toBe('0');
    });

    it('accepts surrounding whitespace in a numeric string', () => {
      const result = validateNewHoldingInput({ ...validBase, quantity: '  1.5  ' });

      expect(expectOk(result).quantity.toFixed()).toBe('1.5');
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['an empty string', ''],
      ['a whitespace-only string', '   '],
    ])('reports a quantity that is %s as required', (_label, quantity) => {
      const error = expectValidationError(
        validateNewHoldingInput({ ...validBase, quantity }),
        'quantity',
      );

      expect(error.message).toContain('required');
    });

    it.each([
      ['a non-numeric word', 'abc'],
      ['a partially numeric string', '1.2.3'],
      ['a boolean', true],
      ['an object', {}],
      ['an array', [1]],
    ])('rejects a quantity that is %s as non-numeric', (_label, quantity) => {
      const error = expectValidationError(
        validateNewHoldingInput({ ...validBase, quantity }),
        'quantity',
      );

      expect(error.message).toContain('numeric');
    });

    it.each([
      ['NaN as a string', 'NaN'],
      ['Infinity as a string', 'Infinity'],
      ['NaN as a number', Number.NaN],
      ['Infinity as a number', Number.POSITIVE_INFINITY],
    ])('rejects a quantity of %s', (_label, quantity) => {
      expectValidationError(validateNewHoldingInput({ ...validBase, quantity }), 'quantity');
    });
  });

  it('reports the symbol error first when several fields are invalid', () => {
    expectValidationError(
      validateNewHoldingInput({ symbol: 'btc', quantity: '0', currentPrice: '-1' }),
      'symbol',
    );
  });

  it('reports the quantity error before the currentPrice error', () => {
    expectValidationError(
      validateNewHoldingInput({ symbol: 'BTC', quantity: '0', currentPrice: '-1' }),
      'quantity',
    );
  });
});

describe('validateHoldingUpdateInput', () => {
  it.each([
    ['the smallest positive quantity and a zero price', SMALLEST_POSITIVE, '0'],
    ['the maximum quantity and the maximum price', MAX_VALUE, MAX_VALUE],
    ['8 decimal places on both fields', EIGHT_DECIMAL_PLACES, EIGHT_DECIMAL_PLACES],
  ])('accepts %s (Req 1.5)', (_label, quantity, currentPrice) => {
    const result = validateHoldingUpdateInput({ quantity, currentPrice });

    const value = expectOk(result);
    expect(value.quantity.toFixed()).toBe(new Decimal(quantity).toFixed());
    expect(value.currentPrice.toFixed()).toBe(new Decimal(currentPrice).toFixed());
  });

  describe('applies the same boundaries as creation (Req 1.6)', () => {
    it.each([
      ['a quantity of exactly 0', '0', 'quantity'],
      ['a negative quantity', '-0.00000001', 'quantity'],
      ['a quantity just above the maximum', JUST_ABOVE_MAX, 'quantity'],
      ['a quantity with 9 decimal places', NINE_DECIMAL_PLACES, 'quantity'],
    ])('rejects %s', (_label, quantity, field) => {
      expectValidationError(validateHoldingUpdateInput({ quantity, currentPrice: '100' }), field);
    });

    it.each([
      ['a negative currentPrice', '-0.00000001'],
      ['a currentPrice just above the maximum', JUST_ABOVE_MAX],
      ['a currentPrice with 9 decimal places', NINE_DECIMAL_PLACES],
    ])('rejects %s', (_label, currentPrice) => {
      expectValidationError(
        validateHoldingUpdateInput({ quantity: '1', currentPrice }),
        'currentPrice',
      );
    });
  });

  it('reports a missing quantity as required', () => {
    const error = expectValidationError(
      validateHoldingUpdateInput({ quantity: undefined, currentPrice: '100' }),
      'quantity',
    );

    expect(error.message).toContain('required');
  });

  it('reports a missing currentPrice as required', () => {
    const error = expectValidationError(
      validateHoldingUpdateInput({ quantity: '1', currentPrice: undefined }),
      'currentPrice',
    );

    expect(error.message).toContain('required');
  });
});

describe('validateTransactionInput', () => {
  const validBase = { symbol: 'BTC', type: 'Buy', quantity: '1', pricePerUnit: '100' };

  describe('transaction type (Req 2.5)', () => {
    it.each([['Buy'], ['Sell']])('accepts a type of "%s"', (type) => {
      const result = validateTransactionInput({ ...validBase, type });

      expect(expectOk(result).type).toBe(type);
    });

    it.each([
      ['lowercase "buy"', 'buy'],
      ['lowercase "sell"', 'sell'],
      ['uppercase "BUY"', 'BUY'],
      ['an unknown word', 'Transfer'],
      ['an empty string', ''],
      ['a padded value', ' Buy '],
      ['undefined', undefined],
      ['null', null],
      ['a number', 0],
      ['a boolean', true],
      ['an object', { type: 'Buy' }],
    ])('rejects a type that is %s', (_label, type) => {
      const error = expectValidationError(validateTransactionInput({ ...validBase, type }), 'type');

      expect(error.message).toContain('"Buy" or "Sell"');
    });
  });

  describe('quantity and pricePerUnit (Req 2.6)', () => {
    it('accepts the smallest positive quantity and a zero price per unit', () => {
      const result = validateTransactionInput({
        ...validBase,
        quantity: SMALLEST_POSITIVE,
        pricePerUnit: '0',
      });

      const value = expectOk(result);
      expect(value.quantity.toFixed()).toBe(SMALLEST_POSITIVE);
      expect(value.pricePerUnit.toFixed()).toBe('0');
    });

    it('rejects a quantity of exactly 0', () => {
      const error = expectValidationError(
        validateTransactionInput({ ...validBase, quantity: '0' }),
        'quantity',
      );

      expect(error.message).toContain('greater than 0');
    });

    it('rejects a negative quantity', () => {
      expectValidationError(
        validateTransactionInput({ ...validBase, quantity: '-0.00000001' }),
        'quantity',
      );
    });

    it('rejects a negative pricePerUnit', () => {
      const error = expectValidationError(
        validateTransactionInput({ ...validBase, pricePerUnit: '-0.00000001' }),
        'pricePerUnit',
      );

      expect(error.message).toContain('negative');
    });

    it.each([
      ['a missing quantity', 'quantity'],
      ['a missing pricePerUnit', 'pricePerUnit'],
    ])('reports %s as required', (_label, field) => {
      const error = expectValidationError(
        validateTransactionInput({ ...validBase, [field]: undefined }),
        field,
      );

      expect(error.message).toContain('required');
    });

    it.each([
      ['a non-numeric quantity', 'quantity', 'abc'],
      ['a non-numeric pricePerUnit', 'pricePerUnit', 'abc'],
    ])('rejects %s', (_label, field, value) => {
      const error = expectValidationError(
        validateTransactionInput({ ...validBase, [field]: value }),
        field,
      );

      expect(error.message).toContain('numeric');
    });

    it('rejects a non-finite quantity', () => {
      expectValidationError(
        validateTransactionInput({ ...validBase, quantity: 'Infinity' }),
        'quantity',
      );
    });

    /*
     * Req 2.6 constrains only the sign of a Transaction's quantity and price per
     * unit; the 1,000,000,000,000 / 8-decimal limits belong to the Holding data
     * model (Req 1.1, 1.3, 1.4), so a Transaction is deliberately not bounded by
     * them. These cases pin that decision down.
     */
    it('accepts a quantity above the Holding maximum', () => {
      const result = validateTransactionInput({ ...validBase, quantity: JUST_ABOVE_MAX });

      expect(expectOk(result).quantity.toFixed()).toBe(JUST_ABOVE_MAX);
    });

    it('accepts a pricePerUnit with more than 8 decimal places', () => {
      const result = validateTransactionInput({ ...validBase, pricePerUnit: NINE_DECIMAL_PLACES });

      expect(expectOk(result).pricePerUnit.toFixed()).toBe(NINE_DECIMAL_PLACES);
    });
  });

  it('rejects an invalid symbol (Req 1.11)', () => {
    expectValidationError(validateTransactionInput({ ...validBase, symbol: 'btc' }), 'symbol');
  });

  it('reports the symbol error before the type error', () => {
    expectValidationError(
      validateTransactionInput({ ...validBase, symbol: '', type: 'Transfer' }),
      'symbol',
    );
  });

  it('reports the type error before the quantity error', () => {
    expectValidationError(
      validateTransactionInput({ ...validBase, type: 'Transfer', quantity: '0' }),
      'type',
    );
  });
});

describe('validatePriceUpdateInput (Req 4.2)', () => {
  it.each([
    ['exactly 0', '0'],
    ['the smallest positive value', SMALLEST_POSITIVE],
    ['the Holding maximum', MAX_VALUE],
  ])('accepts a currentPrice of %s', (_label, currentPrice) => {
    const result = validatePriceUpdateInput({ currentPrice });

    expect(expectOk(result).currentPrice.toFixed()).toBe(new Decimal(currentPrice).toFixed());
  });

  it('accepts a JSON number', () => {
    const result = validatePriceUpdateInput({ currentPrice: 42.5 });

    expect(expectOk(result).currentPrice.toFixed()).toBe('42.5');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a whitespace-only string', ' \t '],
  ])('reports a currentPrice that is %s as required', (_label, currentPrice) => {
    const error = expectValidationError(validatePriceUpdateInput({ currentPrice }), 'currentPrice');

    expect(error.message).toContain('required');
  });

  it.each([
    ['a non-numeric word', 'abc'],
    ['a currency-formatted string', '$100'],
    ['a boolean', false],
    ['an object', {}],
    ['an array', []],
  ])('rejects a currentPrice that is %s', (_label, currentPrice) => {
    const error = expectValidationError(validatePriceUpdateInput({ currentPrice }), 'currentPrice');

    expect(error.message).toContain('numeric');
  });

  it.each([
    ['just below 0', '-0.00000001'],
    ['a negative whole value', '-1'],
  ])('rejects a currentPrice that is %s', (_label, currentPrice) => {
    const error = expectValidationError(validatePriceUpdateInput({ currentPrice }), 'currentPrice');

    expect(error.message).toContain('negative');
  });

  it.each([
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
  ])('rejects a currentPrice of %s', (_label, currentPrice) => {
    expectValidationError(validatePriceUpdateInput({ currentPrice }), 'currentPrice');
  });

  it('preserves full precision of the submitted price', () => {
    const result = validatePriceUpdateInput({ currentPrice: '0.00000001' });

    expect(expectOk(result).currentPrice.toFixed()).toBe('0.00000001');
  });
});
