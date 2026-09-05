/**
 * Shared wire-contract types for the Frontend's `crypto-portfolio-core`
 * Backend_API calls.
 *
 * These types are kept intentionally identical to what the Backend_API
 * actually sends and expects (see `src/http/routes/*.ts`'s `serialize*`
 * functions and request-body handling). Decimal and quantity fields
 * (`quantity`, `currentPrice`, `holdingValue`, `portfolioValue`,
 * `pricePerUnit`) are kept as opaque strings and must never be parsed to
 * `number`: the Frontend only displays them or round-trips them back into a
 * form field, and parsing through a JSON number would risk losing precision
 * the Backend_API took care to preserve.
 *
 * The Frontend defines no persisted data model of its own — these types exist
 * purely to give the Frontend's TypeScript compiler the same shape discipline
 * the backend has.
 */

/**
 * A Holding as returned by the Backend_API.
 *
 * **Validates: Requirements 1.2, 3.2**
 */
export interface HoldingResponse {
  readonly symbol: string;
  /** Decimal in plain notation, e.g. `"0.00000001"`. Never parsed to `number`. */
  readonly quantity: string;
  /** Decimal in plain notation. Never parsed to `number`. */
  readonly currentPrice: string;
}

/**
 * A Holding plus its derived Holding_Value, as returned by the Portfolio
 * overview endpoint.
 *
 * **Validates: Requirements 1.2**
 */
export interface HoldingViewResponse extends HoldingResponse {
  /** Decimal in plain notation: `quantity * currentPrice`. Never parsed to `number`. */
  readonly holdingValue: string;
}

/**
 * The Portfolio overview as returned by `GET /portfolio/overview`.
 *
 * **Validates: Requirements 1.2, 1.3**
 */
export interface PortfolioOverviewResponse {
  readonly holdings: readonly HoldingViewResponse[];
  /** Decimal in plain notation: sum of every Holding_Value. Never parsed to `number`. */
  readonly portfolioValue: string;
}

/**
 * A Transaction as returned by the Backend_API.
 *
 * **Validates: Requirements 6.2**
 */
export interface TransactionResponse {
  readonly id: string;
  readonly symbol: string;
  readonly type: 'Buy' | 'Sell';
  /** Decimal in plain notation. Never parsed to `number`. */
  readonly quantity: string;
  /** Decimal in plain notation. Never parsed to `number`. */
  readonly pricePerUnit: string;
  /** ISO 8601 instant in UTC, e.g. `"2024-01-31T12:00:00.000Z"`. */
  readonly timestamp: string;
}

/**
 * The request body for `POST /holdings`, creating a new Holding.
 *
 * **Validates: Requirements 2.1**
 */
export interface NewHoldingRequest {
  readonly symbol: string;
  readonly quantity: string;
  readonly currentPrice: string;
}

/**
 * The request body for `PUT /holdings/:symbol`, replacing a Holding's
 * quantity and Current_Price.
 *
 * **Validates: Requirements 3.2**
 */
export interface HoldingUpdateRequest {
  readonly quantity: string;
  readonly currentPrice: string;
}

/**
 * The request body for `PATCH /holdings/:symbol/price`, updating a Holding's
 * Current_Price.
 *
 * **Validates: Requirements 7.1**
 */
export interface PriceUpdateRequest {
  readonly currentPrice: string;
}

/**
 * The request body for `POST /transactions`, recording a buy or sell
 * Transaction.
 *
 * **Validates: Requirements 5.1**
 */
export interface TransactionRequest {
  readonly symbol: string;
  readonly type: 'Buy' | 'Sell';
  readonly quantity: string;
  readonly pricePerUnit: string;
}
