---
inclusion: always
---

# Structure

## Layered architecture

Dependencies point in one direction only, backend layers plus a static frontend served by the
same Express app:

```
Frontend (public/app, static)  ->  HTTP (Express routes)  ->  PortfolioService  ->  Domain (pure)
                                                                     |
                                                                     v
                                                          PortfolioRepository <- JsonFilePortfolioRepository
```

Respect this direction when adding code: domain must not import from service/http/persistence;
service must not import from http.

- **`src/domain/`** — pure, framework-free business rules (validation, state transitions,
  valuation). No I/O. Expected failures are returned as `Result<T, E>` (see `result.ts`), not
  thrown. Files: `types.ts` (core types), `holdings.ts`, `transactions.ts`, `pricing.ts`,
  `valuation.ts`, `validation.ts`, `errors.ts` (domain error classes with a `kind` discriminant),
  `decimalConfig.ts` (shared `decimal.js` configuration).
- **`src/service/portfolioService.ts`** — `PortfolioService` owns the in-memory portfolio and
  serializes every mutating operation through a mutex: validate, compute next state, persist,
  then swap the in-memory state in only after the write succeeds.
- **`src/persistence/`** — `JsonFilePortfolioRepository` (writes to a temp file + rename, so an
  interrupted write can't corrupt existing data), `portfolioRepository.ts` (interface), and
  `serialization.ts`.
- **`src/http/`** — `app.ts` wires up Express, serves `public/` as static assets ahead of the API
  routers, and installs the error boundary. `errorMapping.ts` is the single place that maps
  domain error `kind` to HTTP status codes — route handlers never branch on error type themselves.
  `routes/` has one router per resource: `holdings.ts`, `transactions.ts`, `portfolio.ts`. Handlers
  only shape the request, await the service, and render the `Result` — no validation logic here.
- **`src/frontend/`** — browser UI, compiled by `tsconfig.frontend.json` to `public/app/`.
  `apiClient.ts` is the sole caller of `fetch`. `main.ts` composes views against containers in
  `public/index.html`. `views/` holds one file per view (`overviewView.ts`, `addHoldingForm.ts`,
  `transactionForm.ts`, `transactionHistoryView.ts`, `sidePanelTabs.ts`). Views communicate via
  the `portfolioChanged` event bus in `portfolioEvents.ts`, never by referencing each other
  directly. `sidePanelTabs.ts` is the exception: it's a pure UI switch with no portfolio data of
  its own, toggling which of two pre-rendered panels (transaction form vs. transaction history) is
  visible via a segmented control, wired directly to elements in `public/index.html`.
- **`src/index.ts`** — process entry point (reads env vars, starts the HTTP server).
- **`public/`** — static assets served as-is. `public/app/*.js` + `*.js.map` are **compiled
  output** from `src/frontend/` — never edit them directly, edit the `.ts` source and rebuild.

## Tests

Mirrors `src/` layout under `test/`, plus a dedicated properties folder:

- **`test/domain/`**, **`test/http/`**, **`test/persistence/`** — unit/integration tests for
  fixed scenarios (timestamp assignment, empty/corrupted startup, atomic writes, error mapping).
- **`test/properties/`** — `fast-check` property-based tests, one file per correctness property
  from the design doc, named `<behavior>.property.test.ts`. Each covers a wide range of generated
  inputs and is tagged with the requirement/property it validates.
- **`test/frontend/views/`** — Jest + jsdom + `@testing-library/dom` tests per view, against a
  mocked `apiClient`. Example-based only (the frontend has no business logic of its own).

New domain logic should generally get a property test if it maps to one of the design's
correctness properties, plus unit tests for edge cases that aren't universal properties.

## Specs

`.kiro/specs/crypto-portfolio-core/` and `.kiro/specs/portfolio-web-frontend/` hold the
requirements, design, and task breakdown this codebase was built from. Consult these before
making architectural changes — they're the source of truth for *why* things are structured this
way, referenced throughout the code as `Req X.Y` comments.
