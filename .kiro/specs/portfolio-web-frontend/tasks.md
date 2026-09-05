# Implementation Plan: Portfolio Web Frontend

## Overview

This plan implements a static, framework-free browser frontend for the existing `crypto-portfolio-core` Backend_API: a single `ApiClient` module that is the only caller of `fetch`, small cross-cutting helpers (loading indicator, error presentation, a portfolio-changed event bus), four views (overview, add-holding form, transaction form, transaction history), a `main.ts` composition root, and one middleware line added to the existing Express app to serve the compiled output as static assets. Implementation language is TypeScript, compiled by a dedicated `tsconfig.frontend.json` targeting the browser, with no bundler and no UI framework, per the design.

The design has no Correctness Properties section (see design's "Correctness Properties" and "Testing Strategy": this feature introduces no business logic of its own, only rendering and relaying what `crypto-portfolio-core` already validates and computes). Accordingly, this plan contains **no property-based test tasks** — only unit and integration test tasks, using Jest with `jest-environment-jsdom` (opted in per-file via the `@jest-environment jsdom` docblock, per the design) and `@testing-library/dom`.

Tasks are grouped by implementation module so that each source file has a single owning task per edit. Because Requirements 3, 4, and 7 all add controls to the same `overviewView.ts` file (per the design's component table), those three controls are implemented as separate, sequential sub-tasks under the overview view task, each immediately followed by its own test sub-task — this keeps edits to that file conflict-free across waves while still testing each control as soon as it exists.

## Tasks

- [x] 1. Set up frontend project structure and build configuration
  - [x] 1.1 Configure the frontend build and static asset skeleton
    - Create `tsconfig.frontend.json` (browser `lib`, `module`/`target` for native ES modules, `rootDir: src/frontend`, `outDir: public/app`)
    - Create `src/frontend/` as the root for all frontend TypeScript source
    - Author `public/index.html` (page shell with sections/containers for the overview, add-holding form, transaction form, transaction history, a global loading indicator element, and a global connectivity-error banner element) and `public/styles.css`, loading `public/app/main.js` via `<script type="module">`
    - Add an npm script (e.g. `build:frontend`) that runs `tsc -p tsconfig.frontend.json`, and include it alongside the existing `build` script
    - Add dev dependencies: `jest-environment-jsdom`, `@testing-library/dom`
    - _Requirements: All (project scaffolding prerequisite)_

  - [x] 1.2 Define shared frontend wire-contract types
    - In `src/frontend/types.ts`: `HoldingResponse`, `HoldingViewResponse`, `PortfolioOverviewResponse`, `TransactionResponse`, `NewHoldingRequest`, `HoldingUpdateRequest`, `PriceUpdateRequest`, `TransactionRequest`, matching the shapes `crypto-portfolio-core` serializes (decimal and quantity fields kept as opaque strings, never parsed to `number`)
    - _Requirements: 1.2, 1.3, 2.1, 3.2, 5.1, 6.2, 7.1_

- [x] 2. Implement cross-cutting request infrastructure
  - [x] 2.1 Implement the loading indicator
    - In `src/frontend/loadingIndicator.ts`: `requestStarted()`/`requestFinished()` using a pending-request counter, showing the indicator on the first outstanding request and hiding it only once the count returns to zero
    - _Requirements: 8.1, 8.2_

  - [ ]* 2.2 Write unit tests for the loading indicator
    - In `test/frontend/loadingIndicator.test.ts` (jsdom): indicator shows on the first `requestStarted`, stays visible while a second call overlaps, and hides only once every outstanding call has finished
    - _Requirements: 8.1, 8.2_

  - [x] 2.3 Implement error presentation
    - In `src/frontend/errorPresentation.ts`: `messageForApiError(error)` returning `error.message` verbatim, and `messageForNetworkFailure()` returning a fixed connectivity message
    - _Requirements: 1.5, 2.4, 3.5, 4.6, 5.6, 6.4, 7.5, 8.3_

  - [ ]* 2.4 Write unit tests for error presentation
    - In `test/frontend/errorPresentation.test.ts`: `messageForApiError` returns the backend message unchanged (no rewriting); `messageForNetworkFailure` returns the fixed connectivity message
    - _Requirements: 1.5, 2.4, 3.5, 4.6, 5.6, 6.4, 7.5, 8.3_

  - [x] 2.5 Implement the portfolio-changed event bus
    - In `src/frontend/portfolioEvents.ts`: a minimal pub/sub with one event (`portfolioChanged`), a `subscribe` function, and a `publish` function
    - _Requirements: 2.3, 3.4, 4.5, 5.4, 5.5, 7.3, 7.4_

  - [ ]* 2.6 Write unit tests for the portfolio-changed event bus
    - In `test/frontend/portfolioEvents.test.ts`: a subscriber is invoked when `portfolioChanged` is published; a subscriber added after unsubscribing is not invoked
    - _Requirements: 2.3, 3.4, 4.5, 5.4, 5.5, 7.3, 7.4_

- [x] 3. Implement the Backend_API client
  - [x] 3.1 Implement `ApiClient`
    - In `src/frontend/apiClient.ts`: `ApiResult<T>`, `ApiError`, `NetworkError`, `REQUEST_TIMEOUT_MS` (30s), and `getOverview`, `listHoldings`, `addHolding`, `updateHolding`, `removeHolding`, `updatePrice`, `recordTransaction`, `getTransactionHistory`
    - Each function wraps its `fetch` call in an `AbortController` timed out at `REQUEST_TIMEOUT_MS`, calls `loadingIndicator.requestStarted()`/`requestFinished()` around the call in a `finally`, and classifies the outcome into exactly one of: HTTP success (parsed typed response), HTTP failure (parsed `{ error: { code, message, field? } }` body as `ApiError`), or no response at all (`NetworkError`)
    - _Requirements: 1.1, 1.5, 2.2, 2.4, 3.3, 3.5, 4.3, 4.6, 5.2, 5.6, 6.2, 6.4, 7.2, 7.5, 8.1, 8.2, 8.3_

  - [ ]* 3.2 Write unit tests for `ApiClient`
    - In `test/frontend/apiClient.test.ts` (jsdom, `jest.spyOn(global, 'fetch')`): for each function, one test for the 2xx success path, one for a representative 4xx/5xx error body, one for a rejected `fetch` (network failure), and one for the 30s timeout (Jest fake timers)
    - Also verify `loadingIndicator.requestStarted`/`requestFinished` are called in matched pairs on every path, including error paths
    - _Requirements: 1.1, 1.5, 2.2, 2.4, 3.3, 3.5, 4.3, 4.6, 5.2, 5.6, 6.2, 6.4, 7.2, 7.5, 8.1, 8.2, 8.3_

- [ ] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement the Portfolio Overview view
  - [x] 5.1 Implement overview rendering
    - In `src/frontend/views/overviewView.ts`: on init (and whenever re-run), call `apiClient.getOverview()` and render every returned Holding's symbol, quantity, Current_Price, and Holding_Value, plus the Portfolio_Value; render an empty-state message and zero Portfolio_Value when there are no Holdings; render a load-failure message via `errorPresentation` on an `ApiError`; subscribe to `portfolioChanged` (via `portfolioEvents`) to re-run this fetch-and-render sequence
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [x]* 5.2 Write unit tests for overview rendering
    - In `test/frontend/views/overviewView.test.ts` (jsdom, mocked `apiClient`): renders every Holding's fields and the Portfolio_Value from a sample response; renders the empty-state message and zero Portfolio_Value for an empty response; renders the load-failure message on an `ApiError`; re-renders after a `portfolioChanged` event
    - _Requirements: 1.2, 1.3, 1.4, 1.5_

  - [x] 5.3 Implement the holding edit control
    - In `src/frontend/views/overviewView.ts`: add, per rendered Holding, a control that opens an update form pre-populated with that Holding's current quantity and Current_Price; on submit, call `apiClient.updateHolding(symbol, input)`; on success, display the updated quantity/Current_Price, close the form, and publish `portfolioChanged`; on rejection, display the returned error message and keep the form open with the submitted values
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [ ]* 5.4 Write unit tests for the holding edit control
    - In `test/frontend/views/overviewView.test.ts`: opening the edit control pre-populates the current quantity/price; a successful update displays the new values and closes the form; a rejected update keeps the form open with the submitted values and shows the returned message
    - _Requirements: 3.2, 3.4, 3.5_

  - [x] 5.5 Implement the holding removal control
    - In `src/frontend/views/overviewView.ts`: add, per rendered Holding, a removal control that calls `window.confirm()` seeded with a message naming the Holding's Cryptoasset symbol; on confirmation, call `apiClient.removeHolding(symbol)`, and on success remove the Holding from the Holdings_List and publish `portfolioChanged`; on decline, send no request and leave the Holding unchanged; on rejection, display the returned error message
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [ ]* 5.6 Write unit tests for the holding removal control
    - In `test/frontend/views/overviewView.test.ts` (mocked `window.confirm`): declining sends no request and leaves the row unchanged; confirming sends the deletion request and removes the row on success; a rejected removal displays the returned error message
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x] 5.7 Implement the holding price-update control
    - In `src/frontend/views/overviewView.ts`: add, per rendered Holding, a control for submitting an updated Current_Price; on submit, call `apiClient.updatePrice(symbol, input)`; on success, display the updated Current_Price and recalculated Holding_Value and Portfolio_Value, and publish `portfolioChanged`; on rejection, display the returned error message
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [ ]* 5.8 Write unit tests for the holding price-update control
    - In `test/frontend/views/overviewView.test.ts`: a successful price update displays the new Current_Price, Holding_Value, and Portfolio_Value; a rejected price update displays the returned error message
    - _Requirements: 7.2, 7.3, 7.4, 7.5_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Implement the Add Holding form
  - [x] 7.1 Implement the add-holding form
    - In `src/frontend/views/addHoldingForm.ts`: a form requiring symbol, quantity, and Current_Price before it can be submitted; on submit, call `apiClient.addHolding(input)`; on success, publish `portfolioChanged` so the Holdings_List reflects the new Holding, and clear the form; on rejection, display the returned error message and retain the entered values
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x]* 7.2 Write unit tests for the add-holding form
    - In `test/frontend/views/addHoldingForm.test.ts` (jsdom, mocked `apiClient`): a form left incomplete cannot be submitted; submitting with all fields sends the expected request and clears the form on success; a rejected submission shows the backend message and retains the entered values
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

- [ ] 8. Implement the Transaction form
  - [x] 8.1 Implement the transaction form
    - In `src/frontend/views/transactionForm.ts`: a form for symbol, Transaction_Type, quantity, and price per unit; on submit, call `apiClient.recordTransaction(input)`; on success, display a confirmation with the recorded Transaction's fields and publish `portfolioChanged`; on rejection, display the returned error message
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x]* 8.2 Write unit tests for the transaction form
    - In `test/frontend/views/transactionForm.test.ts` (jsdom, mocked `apiClient`): a successful submission shows the confirmation with the submitted fields and publishes `portfolioChanged`; a rejected submission shows the returned error message
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6_

- [ ] 9. Implement the Transaction History view
  - [x] 9.1 Implement the transaction history view
    - In `src/frontend/views/transactionHistoryView.ts`: a control for specifying a Cryptoasset symbol (including symbols with no current Holding); on request, call `apiClient.getTransactionHistory(symbol)` and display every returned Transaction's type, quantity, price per unit, and timestamp in the order returned; display an empty-state message when none are returned; display an error message via `errorPresentation` on failure
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x]* 9.2 Write unit tests for the transaction history view
    - In `test/frontend/views/transactionHistoryView.test.ts` (jsdom, mocked `apiClient`): renders returned Transactions in the order the backend returned them; renders the empty-state message when none are returned; renders the error message on failure
    - _Requirements: 6.2, 6.3, 6.4_

- [ ] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Wire the frontend application and serve it from Express
  - [x] 11.1 Compose the application in `main.ts`
    - In `src/frontend/main.ts`: once the page loads, construct/initialize `overviewView`, `addHoldingForm`, `transactionForm`, and `transactionHistoryView` against their DOM containers in `public/index.html`, with no logic of its own beyond this composition
    - _Requirements: 1.1, 2.1, 3.1, 4.1, 5.1, 6.1, 7.1_

  - [x] 11.2 Serve the frontend as static assets from the existing Express app
    - In `src/http/app.ts`: add `app.use(express.static(path.join(__dirname, '../../public')))`, mounted before the existing API routers, so `GET /` serves `public/index.html` and static asset requests fall through to the API routers on a miss
    - _Requirements: All (static asset serving prerequisite)_

  - [ ]* 11.3 Write a static-serving smoke test
    - In `test/http/staticAssets.test.ts` (supertest, alongside the existing `test/http/routes.test.ts`): `GET /` returns the frontend's HTML with a 200; confirm static serving does not shadow an existing API route (e.g. `GET /portfolio/overview` still reaches the API router, not a 404 from the static middleware)
    - _Requirements: All (static asset serving prerequisite)_

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP, though they are strongly recommended given this feature's role as a Kiro best-practices reference implementation.
- This design has no Correctness Properties section, so this plan contains no property-based test tasks; all testing is example-based unit/integration testing with Jest and `jest-environment-jsdom`, per the design's Testing Strategy.
- Requirements 3, 4, and 7 each add a control to `overviewView.ts` (tasks 5.3, 5.5, 5.7); these are sequenced as separate sub-tasks, each immediately followed by its own test sub-task, so no two tasks edit that file (or its test file) concurrently.
- Visual layout and CSS are not covered by automated tests, per the design's Testing Strategy; manual review is sufficient for a scope this small.
- The Frontend introduces no new business logic, validation, or error conditions of its own; its correctness rests on calling the right `Backend_API` endpoint with the right body and rendering what came back, which `crypto-portfolio-core`'s own (already-implemented and property-tested) domain layer guarantees.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "2.3", "2.5", "11.2"] },
    { "id": 2, "tasks": ["2.2", "2.4", "2.6", "3.1", "11.3"] },
    { "id": 3, "tasks": ["3.2", "5.1", "7.1", "8.1", "9.1"] },
    { "id": 4, "tasks": ["5.2", "5.3", "7.2", "8.2", "9.2"] },
    { "id": 5, "tasks": ["5.4", "5.5"] },
    { "id": 6, "tasks": ["5.6", "5.7"] },
    { "id": 7, "tasks": ["5.8", "11.1"] }
  ]
}
```
