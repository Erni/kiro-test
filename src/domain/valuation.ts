import { Decimal } from './decimalConfig';
import { listHoldings } from './holdings';

import type { Holding, HoldingView, PortfolioOverview, PortfolioState } from './types';

/**
 * Portfolio valuation (Req 3.1, 3.2, 3.3, 3.4).
 *
 * Holding_Value and Portfolio_Value are derived, never stored: both are computed
 * from the `PortfolioState` handed in, so every call reflects the quantities and
 * Current_Prices as of that moment (Req 3.4). The functions are pure and
 * synchronous - no I/O, no mutation of the input state - which is what lets the
 * service layer call them straight after a state transition without a reload.
 *
 * All arithmetic goes through `Decimal`. Multiplying a quantity with up to 8
 * decimal places by a price with up to 8 decimal places yields up to 16 decimal
 * places, and summing those across Holdings compounds the problem; IEEE-754
 * floats would silently drift here, so `Decimal.times`/`Decimal.plus` are used
 * throughout and no rounding is applied.
 *
 * "No rounding" holds only because `Decimal` is imported from `./decimalConfig`,
 * which raises `Decimal.precision` above what an exact product and sum need.
 * decimal.js rounds every arithmetic *result* to `precision` significant digits
 * and defaults to 20 - too few - so importing the constructor straight from
 * `decimal.js` here would silently reintroduce rounding.
 *
 * Amounts carry no currency tag: the Portfolio has a single Reference_Currency,
 * so Current_Price and every derived value are already expressed in it.
 */

/** The Portfolio_Value of an empty Portfolio (Req 3.3). */
const ZERO = new Decimal(0);

/**
 * The Holding_Value of a single Holding: `quantity * currentPrice` (Req 3.1).
 *
 * Exact, unrounded product. A Current_Price of zero is legal (Req 1.11 allows
 * `currentPrice >= 0`), so a zero Holding_Value is a valid result rather than a
 * missing-price signal.
 */
export function holdingValue(holding: Holding): Decimal {
  return holding.quantity.times(holding.currentPrice);
}

/**
 * The Portfolio overview: every Holding with its symbol, quantity,
 * Current_Price, and Holding_Value, plus the Portfolio_Value as the sum of all
 * Holding_Values (Req 3.1, 3.2).
 *
 * An empty Portfolio yields an empty Holdings list and a Portfolio_Value of zero
 * (Req 3.3) - the natural identity of the sum, so no special case is needed.
 * Every value is computed from `state` at call time (Req 3.4); the returned
 * views are fresh objects and the state is left untouched.
 */
export function portfolioOverview(state: PortfolioState): PortfolioOverview {
  const holdings: HoldingView[] = listHoldings(state).map((holding) => ({
    symbol: holding.symbol,
    quantity: holding.quantity,
    currentPrice: holding.currentPrice,
    holdingValue: holdingValue(holding),
  }));

  const portfolioValue = holdings.reduce((total, view) => total.plus(view.holdingValue), ZERO);

  return { holdings, portfolioValue };
}
