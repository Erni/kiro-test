import * as path from 'node:path';

import { StartupError } from './domain/errors';
import { createApp } from './http/app';
import { JsonFilePortfolioRepository } from './persistence/jsonFilePortfolioRepository';
import { PortfolioService } from './service/portfolioService';

import type { Express } from 'express';
import type { Server } from 'node:http';

/**
 * The server entrypoint: load the persisted Portfolio, then serve it.
 *
 * The ordering here is the requirement, not a style choice. Req 5.3 says the
 * previously persisted Portfolio is loaded at startup, and Req 5.6 says that if
 * it cannot be loaded the System reports a startup error and presents no
 * Portfolio until that is resolved. Both fall out of doing the load *before*
 * anything else exists: `PortfolioService` takes its initial state as a
 * constructor argument and `createApp` takes a service, so a rejected `load()`
 * leaves no service to build an app around and no app to attach a listener to.
 * There is no window in which routes are mounted over an unknown Portfolio.
 *
 * The module is split into {@link bootstrap} (load and build), {@link start}
 * (also listen) and {@link main} (translate the outcome into an exit code), with
 * the auto-start guarded by a `require.main` check at the bottom. That split is
 * what lets a test drive startup in-process — importing this module must not
 * bind a port or kill the test runner's process.
 */

/** Persistence path used when `PORTFOLIO_DATA_FILE` is not set. */
const DEFAULT_DATA_FILE = path.join('data', 'portfolio.json');

/** Listening port used when `PORT` is not set. */
const DEFAULT_PORT = 3000;

/** Exit code reported when startup fails. */
const EXIT_FAILURE = 1;

/** Exit code reported when the server started and then shut down cleanly. */
const EXIT_SUCCESS = 0;

/** The subset of `console` this module writes to, so a test can capture it. */
export type StartupLogger = Pick<Console, 'log' | 'error'>;

/** Overrides for the values otherwise taken from the environment. */
export interface StartupOptions {
  /** Path of the persisted JSON document. Defaults to `data/portfolio.json`. */
  readonly dataFilePath?: string;

  /**
   * TCP port to listen on. Defaults to 3000. `0` asks the OS for a free port,
   * which is how a test can start a real listener without picking one.
   */
  readonly port?: number;

  /** Where startup progress and failures are written. Defaults to `console`. */
  readonly logger?: StartupLogger;
}

/**
 * Loads the persisted Portfolio and builds the HTTP application around it
 * (Req 5.3), without binding a port.
 *
 * A first run has nothing persisted, and the repository resolves with an empty
 * Portfolio for that case (Req 5.5), so it is not an error here.
 *
 * @throws StartupError when persisted data exists but cannot be read or parsed.
 *   Propagated rather than handled: the caller decides whether that means
 *   exiting the process ({@link main}) or failing a test. Nothing is mounted or
 *   served on this path (Req 5.6).
 */
export async function bootstrap(options: StartupOptions = {}): Promise<Express> {
  const repository = new JsonFilePortfolioRepository(dataFilePathFrom(options));

  // Before this resolves there is deliberately no service and no app.
  const state = await repository.load();

  return createApp(new PortfolioService(repository, state));
}

/**
 * Bootstraps and then starts listening.
 *
 * @returns the listening server, so a caller can read its address or close it.
 *   Resolves only once the socket is actually bound; a bind failure (a port
 *   already in use, say) rejects rather than surfacing later as an unobserved
 *   `error` event.
 * @throws StartupError when the persisted Portfolio cannot be loaded — in which
 *   case no listener is ever opened (Req 5.6).
 */
export async function start(options: StartupOptions = {}): Promise<Server> {
  const app = await bootstrap(options);
  return listen(app, options.port ?? portFromEnvironment());
}

/**
 * Runs the server as a process would: start it, report the outcome, and produce
 * an exit code.
 *
 * Startup failures are reported here rather than left to reject, because the
 * documented behaviour is a logged error and a non-zero exit (Req 5.6) — an
 * unhandled rejection would technically exit non-zero too, but with a stack
 * trace as the entire explanation.
 *
 * @returns the exit code: 0 once the server has shut down cleanly, non-zero when
 *   startup failed.
 */
export async function main(options: StartupOptions = {}): Promise<number> {
  const logger = options.logger ?? console;

  let server: Server;
  try {
    server = await start(options);
  } catch (cause) {
    if (cause instanceof StartupError) {
      // The actionable case: persisted data exists but is unusable. Naming the
      // file is the whole point, since resolving it means repairing or removing
      // that file.
      logger.error(`Startup failed: ${cause.message}`);
      logger.error('No portfolio is being served. Resolve the above and start again.');
    } else {
      logger.error('Startup failed unexpectedly:', cause);
    }
    return EXIT_FAILURE;
  }

  logger.log(`kiro-test is listening on ${describeAddress(server)}`);
  logger.log(`Portfolio data file: ${dataFilePathFrom(options)}`);

  await closed(server);
  return EXIT_SUCCESS;
}

/** The persistence path in effect, from `options`, the environment, or default. */
function dataFilePathFrom(options: StartupOptions): string {
  return options.dataFilePath ?? process.env.PORTFOLIO_DATA_FILE ?? DEFAULT_DATA_FILE;
}

/**
 * The port from `PORT`, or {@link DEFAULT_PORT}.
 *
 * A `PORT` that is set but not a usable port number is a misconfiguration, and
 * silently falling back to 3000 would hide it — the operator would find the
 * server answering somewhere they did not ask for.
 */
function portFromEnvironment(): number {
  const configured = process.env.PORT;
  if (configured === undefined || configured === '') {
    return DEFAULT_PORT;
  }

  const port = Number(configured);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535, got "${configured}"`);
  }
  return port;
}

/** Binds `app` to `port`, resolving once the socket is listening. */
function listen(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once('listening', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
    server.once('error', reject);
  });
}

/** Resolves when `server` stops listening, or rejects if it fails while doing so. */
function closed(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('close', resolve);
    server.once('error', reject);
  });
}

/** Human-readable bound address, e.g. `http://localhost:3000` or a pipe name. */
function describeAddress(server: Server): string {
  const address = server.address();
  if (address === null) {
    return 'an unknown address';
  }
  if (typeof address === 'string') {
    return address;
  }
  return `http://localhost:${address.port}`;
}

// Auto-start only when this file is the process entrypoint. Importing it — which
// a test does — must not bind a port or set an exit code.
if (require.main === module) {
  void main().then((code) => {
    // `process.exitCode` rather than `process.exit()`: the latter can truncate
    // pending stderr writes, which would drop the very message explaining the
    // failure.
    process.exitCode = code;
  });
}
