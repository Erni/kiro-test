# kiro-test

A small full-stack app for managing a portfolio of cryptoassets: track holdings, record buy/sell
transactions, update prices, and read back the current portfolio value, from a browser UI backed
by an HTTP API.

It doubles as a reference for spec-driven development with Kiro — the requirements, design, and
implementation plan for the backend live in `.kiro/specs/crypto-portfolio-core/`, and for the
browser frontend in `.kiro/specs/portfolio-web-frontend/`.

## Requirements

- Node.js 20 or newer

## Getting started

```powershell
npm install
npm run build
npm run build:frontend
npm start
```

Open `http://localhost:3000` in a browser for the UI, or call the API directly (see below).

| Script                | What it does                                    |
| --------------------- | ------------------------------------------------ |
| `npm run build`       | Compiles the backend TypeScript to `dist/`        |
| `npm run build:frontend` | Compiles the frontend TypeScript to `public/app/` |
| `npm start`           | Runs the compiled server from `dist/`             |
| `npm test`            | Runs the full Jest suite once (no watch mode)     |
| `npm run typecheck`   | Type-checks without emitting output               |

### Configuration

| Variable               | Default               | Purpose                            |
| ---------------------- | --------------------- | ---------------------------------- |
| `PORT`                 | `3000`                | Port to listen on (`0` picks a free one) |
| `PORTFOLIO_DATA_FILE`  | `data/portfolio.json` | Where the portfolio is persisted    |

## Architecture

Four backend layers, with dependencies pointing in one direction only, plus a static browser
frontend served by the same Express app:

```
Frontend (public/app, static)  ->  HTTP (Express routes)  ->  PortfolioService  ->  Domain (pure)
                                                                     |
                                                                     v
                                                          PortfolioRepository <- JsonFilePortfolioRepository
```

- **`src/domain`** — pure, framework-free business rules: validation, state transitions, valuation.
  No I/O. Expected failures come back as a `Result<T, E>` union rather than thrown exceptions.
- **`src/service`** — `PortfolioService` owns the in-memory portfolio and serializes every mutating
  operation through a mutex: validate, compute the next state, persist it, and only swap it in once
  the write succeeded. A failed write therefore leaves both the file and memory untouched.
- **`src/persistence`** — `JsonFilePortfolioRepository` writes to a temp file and renames over the
  target, so an interrupted write cannot corrupt existing data.
- **`src/http`** — thin routes that shape requests, await the service, and render the result. All
  status-code mapping lives in `errorMapping.ts`. `app.ts` also serves the compiled frontend as
  static assets, mounted ahead of the API routers so a missed static request falls through to them.
- **`src/frontend`** — a framework-free, no-bundler browser UI compiled by `tsconfig.frontend.json`
  to `public/app/`. `apiClient.ts` is the sole caller of `fetch`; `main.ts` composes four views
  (portfolio overview, add-holding form, transaction form, transaction history) against the
  containers declared in `public/index.html`, then wires the side panel's tabs
  (`views/sidePanelTabs.ts`). Views communicate through a small `portfolioChanged`
  event bus (`portfolioEvents.ts`) rather than referencing each other directly.

### Look and feel

The UI implements the **Vela** design (`Crypto Portfolio Manager.dc.html` in the Claude Design
project it was imported from). Holdings sit in the left card, with add-holding as a disclosure
panel and per-row inline editing, price updates, and a modal removal confirmation; the transaction
form and transaction history share the right card behind a two-tab control.

- `public/vendor/vela/tokens/` holds the design system's five token files, **vendored verbatim**.
  They are the only source of colour, type, spacing, and effect values.
- `public/styles.css` translates each design-system component (Card, Button, IconButton, Input,
  Select, Table, Badge, InlineAlert, EmptyState, Dialog, Spinner) from the design's inline React
  styles into a plain CSS class, referencing only those tokens. Re-vendoring updated tokens
  restyles the whole app.
- `src/frontend/icons.ts` inlines the eight Lucide glyphs the design uses as SVG, rather than
  loading them from a CDN at runtime as the design canvas does, so the app stays self-contained.
- `tokens/typography.css` keeps the design's Google Fonts `@import` for Plus Jakarta Sans and
  JetBrains Mono. It is the app's only outbound request; both tokens carry system fallback stacks,
  so the UI is correct offline. Delete the `@import` line to drop it entirely.

Quantities and prices are handled with `decimal.js`, not native numbers. The domain supports values
up to 1,000,000,000,000 with 8 decimal places, and a holding value multiplies two of those together
— a range IEEE-754 doubles cannot represent exactly. They cross the wire as **strings** for the same
reason, and the frontend keeps them as opaque strings too, never parsing them to `number`.

## API

| Method   | Path                       | Purpose                                |
| -------- | -------------------------- | -------------------------------------- |
| `POST`   | `/holdings`                | Create a holding                       |
| `GET`    | `/holdings`                | List all holdings                      |
| `PUT`    | `/holdings/:symbol`        | Replace a holding's quantity and price |
| `DELETE` | `/holdings/:symbol`        | Delete a holding and its transactions  |
| `PATCH`  | `/holdings/:symbol/price`  | Update only the price                  |
| `POST`   | `/transactions`            | Record a buy or sell                   |
| `GET`    | `/transactions/:symbol`    | Transaction history, oldest first      |
| `GET`    | `/portfolio/overview`      | Holdings with values, plus the total   |

Symbols are 1-10 characters of uppercase letters and digits, and are matched exactly — `/holdings/btc`
does not resolve to `BTC`.

### Examples

Create a holding:

```bash
curl -X POST http://localhost:3000/holdings \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTC","quantity":"0.5","currentPrice":"64000"}'
```

Record a buy (creates the holding if it does not exist yet):

```bash
curl -X POST http://localhost:3000/transactions \
  -H "Content-Type: application/json" \
  -d '{"symbol":"ETH","type":"Buy","quantity":"2.25","pricePerUnit":"3100.50"}'
```

Read the overview:

```bash
curl http://localhost:3000/portfolio/overview
```

```json
{
  "holdings": [
    { "symbol": "BTC", "quantity": "0.5", "currentPrice": "64000", "holdingValue": "32000" }
  ],
  "portfolioValue": "32000"
}
```

### Errors

Every failure returns the same shape, so clients can parse it without branching on status first:

```json
{ "error": { "code": "ValidationError", "message": "quantity must be greater than 0", "field": "quantity" } }
```

| Status | Codes                                              | When                                        |
| ------ | -------------------------------------------------- | ------------------------------------------- |
| `400`  | `ValidationError`                                  | Bad symbol, quantity, price, or transaction type |
| `404`  | `NotFoundError`, `RouteNotFound`                   | No such holding, or no such route           |
| `409`  | `DuplicateHoldingError`, `InsufficientQuantityError` | Symbol already held; selling more than held |
| `500`  | `PersistenceError`, `InternalError`                | Write failed, or an unexpected fault        |

A sell that reduces a holding to zero removes the holding but keeps its transaction history, so
`GET /transactions/:symbol` can still return results for a symbol you no longer hold.

## Testing

```powershell
npm test
```

Two complementary styles on the backend, plus DOM-based unit tests for the frontend:

- **Property-based tests** (`fast-check`, in `test/properties/`) cover the 17 correctness properties
  defined in the design — things like "a persistence failure leaves both in-memory and persisted
  state unchanged" — across a wide range of generated inputs. Each is tagged with the property and
  requirement it validates.
- **Unit and integration tests** cover fixed scenarios that are not universal properties: timestamp
  assignment, first-run startup with no data file, startup against a corrupted file, atomic write
  behaviour, and HTTP status mapping.
- **Frontend tests** (`test/frontend/`) use Jest with `jest-environment-jsdom` and
  `@testing-library/dom` against a mocked `apiClient`. They assert on structural hooks — field
  names, ids, and the `holding-*` class names — rather than on presentation, so restyling does not
  move them. The frontend introduces no business logic of
  its own, so these are example-based only — no property-based tests — covering rendering, form
  validation, and the success/error paths of each view.

## Security

The HTTP endpoints have **no authentication or authorization**. That is intentional for a
single-user local reference app, but it means anyone who can reach the port can read and modify the
portfolio. Put an auth layer in front of it before exposing it on a network.
