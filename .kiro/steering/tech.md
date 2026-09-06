---
inclusion: always
---

# Tech

## Stack

- **Language**: TypeScript 5.9, strict mode (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch` all on).
- **Runtime**: Node.js >= 20.
- **Backend framework**: Express 5.
- **Arbitrary-precision math**: `decimal.js` — always use `Decimal`, never native `number`, for
  quantities and prices anywhere in the domain, service, persistence, or HTTP layers.
- **Frontend**: framework-free, no-bundler browser TypeScript compiled straight to ES modules.
- **Test runner**: Jest 30 with `ts-jest`.
- **Property-based testing**: `fast-check`, used for the 17 correctness properties defined in the
  backend design doc.
- **HTTP testing**: `supertest`.
- **DOM testing**: `jest-environment-jsdom` + `@testing-library/dom`.

## Build setup

Two separate TypeScript projects compiled independently, because the backend and frontend target
different module systems:

- `tsconfig.json` — base config (CommonJS, ES2022, includes `src` + `test`, excludes
  `src/frontend`). Used for typechecking and as the base for `ts-jest`.
- `tsconfig.build.json` — extends the base, compiles `src/` (minus `src/frontend`) to `dist/`.
- `tsconfig.frontend.json` — standalone config, ES2020 modules for the browser, compiles
  `src/frontend/` to `public/app/`. Frontend source uses explicit `.js` extensions on relative
  imports (native ESM style) even though the source files are `.ts`.

Jest maps those `.js`-suffixed relative imports back for `ts-jest` via `moduleNameMapper` in
`jest.config.js` — don't remove that mapping if you touch frontend test config.

## Commands

All commands run from the repo root (PowerShell):

| Command                    | What it does                                      |
| --------------------------- | -------------------------------------------------- |
| `npm install`               | Install dependencies                               |
| `npm run build`             | Compile backend TypeScript to `dist/`              |
| `npm run build:frontend`    | Compile frontend TypeScript to `public/app/`       |
| `npm start`                 | Run the compiled server from `dist/`               |
| `npm test`                  | Run the full Jest suite once (`--ci`, no watch)    |
| `npm run typecheck`         | Type-check everything with no emit                 |

There is no lint script configured. After any change, run `npm run typecheck` and `npm test`
before considering the change done. Run `npm run build:frontend` too if frontend `.ts` files
changed, since `public/app/*.js` is compiled output and must stay in sync.

## Environment variables

| Variable              | Default                | Purpose                                  |
| --------------------- | ----------------------- | ----------------------------------------- |
| `PORT`                | `3000`                  | Port to listen on (`0` picks a free one)  |
| `PORTFOLIO_DATA_FILE` | `data/portfolio.json`   | Where the portfolio is persisted          |
