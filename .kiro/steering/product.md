---
inclusion: always
---

# Product

kiro-test is a small full-stack app for managing a portfolio of cryptoassets: track holdings,
record buy/sell transactions, update prices, and read back the current portfolio value. It's a
single-user local reference app — no auth/authorization on the HTTP API by design.

It doubles as a reference for spec-driven development with Kiro. Requirements, design, and
implementation plans live in `.kiro/specs/crypto-portfolio-core/` (backend) and
`.kiro/specs/portfolio-web-frontend/` (frontend).

## Domain concepts

- **Holding**: a symbol (1-10 uppercase letters/digits, e.g. `BTC`), quantity, and current price.
  Symbols are matched exactly — no case normalization.
- **Transaction**: a `Buy` or `Sell` against a symbol; selling more than held is rejected. Selling
  a holding down to zero removes the holding but its transaction history is kept.
- **Portfolio overview**: holdings with computed values plus a total portfolio value.

## Key design decisions to preserve

- Quantities and prices use `decimal.js`, never native `number` — values up to 1,000,000,000,000
  with 8 decimal places exceed what IEEE-754 doubles represent exactly. They cross the HTTP
  boundary as **strings**, and the frontend keeps them as opaque strings, never parsing to `number`.
- Expected domain failures (validation, not-found, duplicate, insufficient quantity) are returned
  as a `Result<T, E>`, not thrown. Unexpected faults still throw/reject.
- A failed persistence write must leave both in-memory and on-disk state unchanged.
