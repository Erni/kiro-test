# Implementation Plan: Crypto Portfolio Core

## Overview

This plan implements the core portfolio-management logic described in the design: a pure domain layer (validation, state transitions, valuation), a `PortfolioService` application layer that serializes mutating operations through a mutex and persists before confirming, a JSON-file repository with atomic writes, and a thin Express HTTP layer. Implementation language is TypeScript on Node.js, using `decimal.js` for arbitrary-precision arithmetic, `fast-check` for property-based tests, and Jest as the test runner, per the design document.

Tasks are grouped by implementation module so that each source file has a single owning task. Each of the 17 correctness properties from the design becomes its own property-based test task in its own test file, placed immediately after the module it validates. Documented behaviors that are single fixed scenarios rather than universal properties (timestamp assignment, empty/corrupted startup, write atomicity, HTTP status mapping) are covered by unit tests.

## Tasks

- [x] 1. Set up project structure and core domain types
  - [x] 1.1 Initialize the Node.js/TypeScript project
    - Set up `package.json`, `tsconfig.json`, and directory structure (`src/domain`, `src/service`, `src/persistence`, `src/http`, `test`)
    - Add dependencies: `decimal.js`, `express`; dev dependencies: `typescript`, `jest`, `ts-jest`, `@types/jest`, `@types/express`, `supertest`, `@types/supertest`, `fast-check`
    - Configure Jest via `jest.config.js` and add an npm `test` script that runs a single pass (not watch mode)
    - _Requirements: All (project scaffolding prerequisite)_

  - [x] 1.2 Define core domain types, `Result`, and error types
    - In `src/domain/types.ts`: `Symbol`, `Holding`, `TransactionType`, `Transaction`, `PortfolioState`, `HoldingView` and the input types, using `Decimal` for all quantity/price fields
    - In `src/domain/result.ts`: the `Result<T, E>` discriminated union plus `ok`/`err` constructors
    - In `src/domain/errors.ts`: `ValidationError`, `DuplicateHoldingError`, `NotFoundError`, `InsufficientQuantityError`, `PersistenceError`, `StartupError`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.9, 1.10, 1.11, 2.4, 2.5, 2.6, 4.2, 4.3, 5.4, 5.6_

- [x] 2. Implement domain input validation
  - [x] 2.1 Implement all input validators in `src/domain/validation.ts`
    - `validateNewHoldingInput`: symbol is 1-10 chars of `[A-Z0-9]` only; quantity `0 < q <= 1_000_000_000_000` with up to 8 decimals; Current_Price `0 <= p <= 1_000_000_000_000` with up to 8 decimals
    - `validateHoldingUpdateInput`: same quantity and Current_Price rules as creation
    - `validateTransactionInput`: `Transaction_Type` is exactly "Buy" or "Sell"; quantity `> 0`; price per unit `>= 0`
    - `validatePriceUpdateInput`: Current_Price present, numeric, and `>= 0`
    - Each returns `Result<Valid…Input, ValidationError>` with a field-level message; parse decimals from strings to avoid float precision loss
    - _Requirements: 1.3, 1.4, 1.6, 1.11, 2.5, 2.6, 4.2_

  - [x] 2.2 Write unit tests for validation boundary values
    - In `test/domain/validation.test.ts`: exercise the exact boundaries (0, just above 0, exactly 1_000_000_000_000, just above it, 8 vs 9 decimal places), empty and 11-char symbols, lowercase and punctuation symbols, unknown `Transaction_Type`, and missing/non-numeric price
    - _Requirements: 1.3, 1.4, 1.6, 1.11, 2.5, 2.6, 4.2_

- [x] 3. Implement holding state transitions
  - [x] 3.1 Implement holding transitions and listing in `src/domain/holdings.ts`
    - `addHolding`: reject with `DuplicateHoldingError` if the symbol is already held; otherwise return a new `PortfolioState` containing the Holding with exactly the submitted values
    - `updateHolding`: reject with `NotFoundError` if no Holding exists; otherwise return a new state with the Holding's quantity and Current_Price replaced
    - `removeHolding`: reject with `NotFoundError` if no Holding exists; otherwise return a new state with the Holding removed from the holdings map AND all of its Transactions removed from the transactions list
    - `listHoldings`: return all current Holdings as an array (empty when none)
    - All functions are pure and never mutate the input state
    - _Requirements: 1.1, 1.2, 1.5, 1.7, 1.8, 1.9, 1.10_

  - [x]* 3.2 Write property test for valid holding creation
    - **Property 1: Creating a valid holding stores exactly the submitted values**
    - **Validates: Requirements 1.1**

  - [x]* 3.3 Write property test for duplicate holding rejection
    - **Property 2: Duplicate symbol creation is always rejected without side effects**
    - **Validates: Requirements 1.2**

  - [x]* 3.4 Write property test for invalid holding creation input
    - **Property 3: Invalid holding creation input is always rejected without side effects**
    - **Validates: Requirements 1.3, 1.4, 1.11**

  - [x]* 3.5 Write property test for valid holding update
    - **Property 4: Valid holding update applies exactly the submitted values**
    - **Validates: Requirements 1.5**

  - [x]* 3.6 Write property test for invalid holding update
    - **Property 5: Invalid holding update is always rejected without side effects**
    - **Validates: Requirements 1.6**

  - [x]* 3.7 Write property test for manual holding removal
    - **Property 7: Manual removal deletes the holding and all its transactions**
    - **Validates: Requirements 1.7**

  - [x]* 3.8 Write property test for holdings listing
    - **Property 8: Listing holdings always reflects exactly the current holdings**
    - **Validates: Requirements 1.8**

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement transaction recording and history
  - [x] 5.1 Implement `applyTransaction` and `transactionHistory` in `src/domain/transactions.ts`
    - "Buy": increase the Holding's quantity, creating the Holding with Current_Price set to the Transaction's price per unit when none exists; append the Transaction with a generated id and a timestamp assigned at recording time
    - "Sell": reject with `InsufficientQuantityError` when no Holding exists or its quantity is less than the Transaction's quantity; otherwise decrease the quantity, and when the result is exactly zero remove the Holding from the holdings map while keeping all of its Transactions in the transactions list; append the Transaction with a generated id and timestamp
    - `transactionHistory`: return every Transaction recorded for a symbol regardless of whether a Holding currently exists, sorted by timestamp ascending
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.7, 2.8, 2.9_

  - [x]* 5.2 Write property test for Buy transactions
    - **Property 9: Buy transactions increase quantity, creating the holding if needed**
    - **Validates: Requirements 2.1, 2.3**

  - [x]* 5.3 Write property test for Sell transactions
    - **Property 10: Sell transactions decrease quantity or are rejected for insufficient quantity**
    - **Validates: Requirements 2.2, 2.4**

  - [x]* 5.4 Write property test for invalid transaction input
    - **Property 11: Invalid transactions are always rejected without side effects**
    - **Validates: Requirements 2.5, 2.6**

  - [x]* 5.5 Write property test for selling to zero quantity
    - **Property 12: Selling to zero quantity removes the holding but retains its transactions**
    - **Validates: Requirements 2.7**

  - [x]* 5.6 Write property test for transaction history ordering and completeness
    - **Property 13: Transaction history is complete and ordered by timestamp**
    - **Validates: Requirements 2.8**

  - [x]* 5.7 Write unit test for transaction timestamp assignment
    - In `test/domain/transaction-timestamp.test.ts`: capture a "before" and "after" instant around a call to `applyTransaction` and assert the resulting Transaction's timestamp falls between them
    - _Requirements: 2.9_

- [x] 6. Implement price updates and valuation
  - [x] 6.1 Implement `updatePrice` in `src/domain/pricing.ts`
    - Reject with `NotFoundError` when no Holding exists for the symbol; otherwise return a new `PortfolioState` with the Holding's Current_Price replaced and its quantity unchanged
    - _Requirements: 4.1, 4.3_

  - [x] 6.2 Implement `holdingValue` and `portfolioOverview` in `src/domain/valuation.ts`
    - `holdingValue(holding)` returns `quantity * currentPrice` using `Decimal` arithmetic
    - `portfolioOverview(state)` returns every Holding's view (symbol, quantity, Current_Price, Holding_Value) computed from the state as of the call, plus the Portfolio_Value as the sum of all Holding_Values (zero when there are no Holdings)
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x]* 6.3 Write property test for price updates
    - **Property 15: Price updates change only the price, and only when valid**
    - **Validates: Requirements 4.1, 4.2**

  - [x]* 6.4 Write property test for operations on nonexistent holdings
    - **Property 6: Operations on a nonexistent holding are always rejected without side effects**
    - Exercises `updateHolding`, `removeHolding`, and `updatePrice` against symbols with no Holding
    - **Validates: Requirements 1.9, 1.10, 4.3**

  - [x]* 6.5 Write property test for portfolio overview valuation
    - **Property 14: Portfolio overview values are always quantity times price, summed correctly**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4**

- [x] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement persistence layer
  - [x] 8.1 Define the repository interface and (de)serialization helpers
    - In `src/persistence/portfolioRepository.ts`: `load(): Promise<PortfolioState>` and `save(state): Promise<void>`
    - In `src/persistence/serialization.ts`: convert `PortfolioState` to/from its JSON shape, encoding `Decimal` and `Date` values as strings so no precision or timezone information is lost
    - _Requirements: 5.1, 5.2, 5.3_

  - [x] 8.2 Implement `JsonFilePortfolioRepository` in `src/persistence/jsonFilePortfolioRepository.ts`
    - `save()`: serialize, write to a temp file in the target directory, then rename over the target file so the write is all-or-nothing; reject with `PersistenceError` on any I/O failure
    - `load()`: return an empty `PortfolioState` (zero Holdings, zero Transactions) when the file does not exist; reject with `StartupError` when the file exists but cannot be read or parsed
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x] 8.3 Write unit test for empty-portfolio startup
    - In `test/persistence/empty-startup.test.ts`: loading from a repository pointed at a nonexistent file returns a state with zero Holdings and zero Transactions
    - _Requirements: 5.5_

  - [x] 8.4 Write unit test for corrupted-file startup
    - In `test/persistence/corrupted-startup.test.ts`: loading from a repository pointed at a file with unparseable content rejects with a `StartupError`
    - _Requirements: 5.6_

  - [x] 8.5 Write unit test for atomic write behavior
    - In `test/persistence/atomic-write.test.ts`: force a failure at the write/rename step and assert the previously persisted file is left byte-for-byte intact
    - _Requirements: 5.4_

  - [x] 8.6 Write property test for persistence round-trip
    - **Property 16: Persisted state round-trips through reload**
    - Runs against a temporary directory created and torn down per test
    - **Validates: Requirements 5.1, 5.2, 5.3**

- [x] 9. Implement application service layer
  - [x] 9.1 Implement `PortfolioService` mutating operations in `src/service/portfolioService.ts`
    - Own the current in-memory `PortfolioState`, an async mutex, and a `PortfolioRepository`
    - Implement `addHolding`, `updateHolding`, `removeHolding`, `recordTransaction`, `updatePrice`, each serialized through the mutex: validate the input, compute the next state via the domain layer, persist it, and only after a successful `save()` swap it in as the current in-memory state
    - On validation, domain, or persistence failure, leave the in-memory state untouched and return the typed error
    - _Requirements: 5.1, 5.2, 5.4_

  - [x] 9.2 Implement `PortfolioService` read-only operations
    - Add `listHoldings`, `getTransactionHistory`, `getPortfolioOverview` to `src/service/portfolioService.ts`, delegating to the domain layer against the current in-memory state
    - _Requirements: 1.8, 2.8, 3.1, 3.2, 3.3, 3.4_

  - [x] 9.3 Write property test for persistence failure rollback
    - **Property 17: A persistence failure leaves both in-memory and persisted state unchanged**
    - Uses a wrapped repository whose `save()` can be forced to fail on demand
    - **Validates: Requirements 5.4**

- [x] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Implement HTTP layer
  - [x] 11.1 Set up the Express app and error-to-status-code mapping
    - In `src/http/app.ts`: create the app factory taking a `PortfolioService`, add JSON body parsing, and mount the route modules
    - In `src/http/errorMapping.ts`: map each domain error to its documented status code (`ValidationError`→400, `DuplicateHoldingError`→409, `NotFoundError`→404, `InsufficientQuantityError`→409, `PersistenceError`→500) and to a consistent error response body
    - _Requirements: 1.2, 1.3, 1.4, 1.6, 1.9, 1.10, 1.11, 2.4, 2.5, 2.6, 4.2, 4.3, 5.4_

  - [x] 11.2 Implement holdings routes in `src/http/routes/holdings.ts`
    - `POST /holdings`, `PUT /holdings/:symbol`, `DELETE /holdings/:symbol`, `GET /holdings`, delegating to the corresponding `PortfolioService` methods and serializing decimals as strings
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11_

  - [x] 11.3 Implement transactions routes in `src/http/routes/transactions.ts`
    - `POST /transactions` and `GET /transactions/:symbol`, delegating to `recordTransaction` and `getTransactionHistory`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_

  - [x] 11.4 Implement overview and price-update routes in `src/http/routes/portfolio.ts`
    - `GET /portfolio/overview` delegating to `getPortfolioOverview`; `PATCH /holdings/:symbol/price` delegating to `updatePrice`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3_

  - [x] 11.5 Write unit tests for HTTP route status-code mapping
    - In `test/http/routes.test.ts`: using `supertest` against the app with a stubbed `PortfolioService`, exercise one success case per route and one failure case per applicable error type, asserting the documented status code and response body shape
    - _Requirements: 1.1, 1.2, 1.3, 1.9, 2.1, 2.4, 2.5, 3.1, 4.1, 4.2, 4.3_

- [x] 12. Wire application startup
  - [x] 12.1 Implement the server entrypoint in `src/index.ts`
    - Construct `JsonFilePortfolioRepository`, `await load()`, construct `PortfolioService` with the loaded state, build the app, and start listening
    - If `load()` rejects with a `StartupError`, log the error, do not mount or serve routes, and exit with a non-zero code
    - _Requirements: 5.3, 5.6_

  - [x] 12.2 Write unit test for startup failure on corrupted data
    - In `test/startup.test.ts`: starting against a corrupted persisted file reports the startup error and serves no routes
    - _Requirements: 5.6_

- [x] 13. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP, though they are strongly recommended given this feature's role as a Kiro best-practices reference implementation.
- All 17 correctness properties from the design are covered by `fast-check` property tests (minimum 100 runs each), each in its own file under `test/properties/` and placed immediately after the module it validates.
- Behaviors that are single fixed scenarios rather than universal properties (timestamp assignment, empty/corrupted startup, write atomicity, HTTP status mapping) are covered by unit tests, per the design's Testing Strategy.
- Each task owns a distinct set of source files so that tasks scheduled in the same wave never edit the same file.
- The HTTP layer has no authentication or authorization; this is called out in the design's Security note and is out of scope for this feature.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "8.1"] },
    { "id": 3, "tasks": ["2.2", "3.1", "5.1", "6.1", "6.2", "8.2"] },
    { "id": 4, "tasks": ["3.2", "3.3", "3.4", "3.5", "3.6", "3.7", "3.8", "5.2", "5.3", "5.4", "5.5", "5.6", "5.7", "6.3", "6.4", "6.5", "8.3", "8.4", "8.5", "8.6", "9.1"] },
    { "id": 5, "tasks": ["9.2", "11.1"] },
    { "id": 6, "tasks": ["9.3", "11.2", "11.3", "11.4"] },
    { "id": 7, "tasks": ["11.5", "12.1"] },
    { "id": 8, "tasks": ["12.2"] }
  ]
}
```
