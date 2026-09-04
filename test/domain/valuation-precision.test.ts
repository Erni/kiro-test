import { Decimal } from 'decimal.js';

import { holdingValue, portfolioOverview } from '../../src/domain/valuation';

import type { Holding, PortfolioState } from '../../src/domain/types';

/**
 * Exactness of derived values (Req 3.1, 3.2).
 *
 * The domain permits quantities and Current_Prices up to 1,000,000,000,000 with
 * up to 8 decimal places, i.e. up to 20 significant digits each, so an exact
 * `quantity * currentPrice` needs up to 40 significant digits (24 integer digits
 * plus 16 decimal places). decimal.js rounds the *result* of every arithmetic
 * operation to `Decimal.precision` significant digits, which defaults to 20, so
 * unless the library is configured explicitly these products are silently
 * rounded and Req 3.1's exact Holding_Value is not delivered.
 *
 * Every expected value below was computed independently with exact integer
 * arithmetic - multiply the two factors as scaled integers, then place the
 * decimal point at the sum of their decimal places - rather than with `Decimal`,
 * so the assertions cannot agree with the very rounding they are meant to
 * detect. The `Decimal` constructor is used only to *parse* the inputs, and it
 * never rounds.
 */

function makeHolding(symbol: string, quantity: string, currentPrice: string): Holding {
  return {
    symbol,
    quantity: new Decimal(quantity),
    currentPrice: new Decimal(currentPrice),
  };
}

function stateOf(holdings: readonly Holding[]): PortfolioState {
  return {
    holdings: new Map(holdings.map((holding) => [holding.symbol, holding])),
    transactions: [],
  };
}

/**
 * Realistic mid-range Holding: 12345.12345678 units at 54321.87654321.
 *
 * 1234512345678 * 5432187654321 = 6706102723298890322374638, and the two
 * factors carry 8 decimal places each, so the exact product is
 * 670610272.3298890322374638 - 25 significant digits.
 */
const MID_QUANTITY = '12345.12345678';
const MID_PRICE = '54321.87654321';
const MID_VALUE = '670610272.3298890322374638';

/**
 * Maximum-magnitude Holding: the largest value the domain accepts that still
 * uses all 8 decimal places, squared.
 *
 * 99999999999999999999^2 = 9999999999999999999800000000000000000001, and with
 * 8 + 8 decimal places the exact product is
 * 999999999999999999980000.0000000000000001 - 40 significant digits.
 */
const MAX_QUANTITY = '999999999999.99999999';
const MAX_PRICE = '999999999999.99999999';
const MAX_PRODUCT = '999999999999999999980000.0000000000000001';

/** 670610272.3298890322374638 + 999999999999999999980000.0000000000000001 */
const SUM_OF_BOTH = '1000000000000000670590272.3298890322374639';

describe('holdingValue exactness (Req 3.1)', () => {
  it('is exact for a realistic mid-range Holding needing 25 significant digits', () => {
    const value = holdingValue(makeHolding('BTC', MID_QUANTITY, MID_PRICE));

    expect(value.toFixed()).toBe(MID_VALUE);
  });

  it('is exact at the domain maximum, needing 40 significant digits', () => {
    const value = holdingValue(makeHolding('ETH', MAX_QUANTITY, MAX_PRICE));

    expect(value.toFixed()).toBe(MAX_PRODUCT);
  });
});

describe('portfolioOverview exactness (Req 3.1, 3.2)', () => {
  it('reports each Holding_Value exactly and their exact sum as the Portfolio_Value', () => {
    const overview = portfolioOverview(
      stateOf([
        makeHolding('BTC', MID_QUANTITY, MID_PRICE),
        makeHolding('ETH', MAX_QUANTITY, MAX_PRICE),
      ]),
    );

    expect(overview.holdings.map((view) => view.holdingValue.toFixed())).toEqual([
      MID_VALUE,
      MAX_PRODUCT,
    ]);
    expect(overview.portfolioValue.toFixed()).toBe(SUM_OF_BOTH);
  });
});
