import path from 'path';

import express from 'express';

import { errorHandler, notFoundHandler } from './errorMapping';
import { createHoldingsRouter } from './routes/holdings';
import { createPortfolioRouter } from './routes/portfolio';
import { createTransactionsRouter } from './routes/transactions';

import type { PortfolioService } from '../service/portfolioService';
import type { Express } from 'express';

/**
 * Builds the HTTP application around a {@link PortfolioService}.
 *
 * The service is injected rather than constructed here, for two reasons that
 * both matter to the rest of the design: the service owns the in-memory
 * Portfolio, which must be loaded from persistence *before* it exists (so a
 * `StartupError` can stop startup with no app ever built — Req 5.3, 5.6), and a
 * test can hand in a stub to exercise route wiring without touching a
 * filesystem.
 *
 * Middleware order is the whole content of this function, and it is not
 * arbitrary:
 *
 * 1. `express.static` first, serving the compiled frontend from `public/`.
 *    `GET /` resolves to `public/index.html`, and a request for a static
 *    asset that doesn't exist falls through (`express.static` calls `next()`
 *    on a miss) to the API routers below rather than terminating there.
 * 2. `express.json()` next — handlers receive an already-parsed `req.body`. A
 *    body that is not JSON is rejected here, before any handler runs, and
 *    surfaces through the error boundary in step 5.
 * 3. The route modules, each mounted at the root with full paths declared
 *    inside. Prefix mounting would not work: `/holdings` is split across two
 *    modules, since `PATCH /holdings/:symbol/price` belongs with the portfolio
 *    read model rather than with holding CRUD.
 * 4. `notFoundHandler` after every route, so it only sees requests nothing
 *    matched.
 * 5. `errorHandler` last, because Express only routes errors to middleware
 *    registered after the point they were raised.
 *
 * No listener is started here — that belongs to the entrypoint, which keeps the
 * app fully constructible in-process for tests.
 *
 * Security: these routes carry no authentication or authorization, as specified
 * for a single-user local reference application. Anyone able to reach the port
 * can read and mutate the Portfolio, so an auth layer belongs in front of this
 * app before it is exposed on a network.
 */
export function createApp(service: PortfolioService): Express {
  const app = express();

  // Advertising the framework and version only helps someone matching the
  // deployment against known vulnerabilities.
  app.disable('x-powered-by');

  app.use(express.static(path.join(__dirname, '../../public')));

  app.use(express.json());

  app.use(createHoldingsRouter(service));
  app.use(createTransactionsRouter(service));
  app.use(createPortfolioRouter(service));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
