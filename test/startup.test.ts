import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import request from 'supertest';

import { StartupError } from '../src/domain/errors';
import { bootstrap, main, start } from '../src/index';

import type { StartupLogger } from '../src/index';
import type { Server } from 'node:http';

/**
 * Requirement 5.6 at the entrypoint level (task 12.2): when the persisted
 * Portfolio cannot be loaded, startup reports the error and no Portfolio is
 * served.
 *
 * `test/persistence/corrupted-startup.test.ts` already covers the repository's
 * half of this — that a corrupted file rejects with a `StartupError` instead of
 * being mistaken for an empty Portfolio. What is left, and what is tested here,
 * is the consequence the requirement actually promises: that nothing ends up
 * answering requests. So these tests assert on the entrypoint's observable
 * outcomes — the exit code, what was logged, and whether anything is listening
 * on the port — rather than re-asserting the rejection type.
 *
 * "Serves no routes" is checked by reserving a real free port, pointing startup
 * at it, and then confirming a TCP connection to that port is refused. Asserting
 * only that `start()` rejected would not distinguish "never bound" from "bound
 * and then failed", which is the failure mode the requirement rules out.
 *
 * A valid-file case is included as a control: without it, the connection-refused
 * assertions could pass for a reason unrelated to the corrupted data (a wrong
 * port, say) and the tests would be vacuous.
 */
describe('application startup with unloadable persisted data', () => {
  /** Content that parses as nothing at all, i.e. a truncated or garbled file. */
  const UNPARSEABLE = '{ this is not json';

  /** Valid JSON that is not a portfolio document: a structurally corrupt file. */
  const STRUCTURALLY_INVALID = JSON.stringify({ holdings: [] });

  let directory: string;
  let filePath: string;
  let started: Server | undefined;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-startup-'));
    filePath = path.join(directory, 'portfolio.json');
    started = undefined;
  });

  afterEach(async () => {
    if (started !== undefined) {
      await closeServer(started);
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('does not build an application when the persisted file cannot be parsed', async () => {
    await fs.writeFile(filePath, UNPARSEABLE, 'utf8');

    await expect(bootstrap({ dataFilePath: filePath })).rejects.toThrow(StartupError);
  });

  it('never opens a listener, so nothing is serving on the port', async () => {
    await fs.writeFile(filePath, UNPARSEABLE, 'utf8');
    const port = await reserveFreePort();

    await expect(start({ dataFilePath: filePath, port })).rejects.toThrow(StartupError);

    await expect(accepts(port)).resolves.toBe(false);
  });

  it('reports the startup error, naming the file to resolve, and exits non-zero', async () => {
    await fs.writeFile(filePath, UNPARSEABLE, 'utf8');
    const captured = capturingLogger();

    const code = await main({ dataFilePath: filePath, port: 0, logger: captured.logger });

    expect(code).not.toBe(0);
    expect(captured.errors.join('\n')).toContain('Startup failed');
    expect(captured.errors.join('\n')).toContain(filePath);
  });

  it('reports no portfolio is being served, and logs nothing suggesting otherwise', async () => {
    await fs.writeFile(filePath, UNPARSEABLE, 'utf8');
    const captured = capturingLogger();

    await main({ dataFilePath: filePath, port: 0, logger: captured.logger });

    expect(captured.errors.join('\n')).toContain('No portfolio is being served');
    // The "listening on …" line is only written once a socket is bound.
    expect(captured.logs).toHaveLength(0);
  });

  it('serves nothing after a failed run, so the port is still free afterwards', async () => {
    await fs.writeFile(filePath, UNPARSEABLE, 'utf8');
    const port = await reserveFreePort();
    const captured = capturingLogger();

    const code = await main({ dataFilePath: filePath, port, logger: captured.logger });

    expect(code).not.toBe(0);
    await expect(accepts(port)).resolves.toBe(false);
  });

  it('stops startup for a file that is valid JSON but not a portfolio document', async () => {
    await fs.writeFile(filePath, STRUCTURALLY_INVALID, 'utf8');
    const port = await reserveFreePort();
    const captured = capturingLogger();

    const code = await main({ dataFilePath: filePath, port, logger: captured.logger });

    expect(code).not.toBe(0);
    expect(captured.errors.join('\n')).toContain('Startup failed');
    await expect(accepts(port)).resolves.toBe(false);
  });

  it('control: a loadable file does start a listener that answers portfolio requests', async () => {
    await fs.writeFile(filePath, JSON.stringify({ holdings: [], transactions: [] }), 'utf8');

    started = await start({ dataFilePath: filePath, port: 0 });

    const response = await request(started).get('/portfolio/overview');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ holdings: [], portfolioValue: '0' });
  });
});

/** A {@link StartupLogger} that records what startup wrote, instead of printing it. */
function capturingLogger(): { logger: StartupLogger; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];

  return {
    logs,
    errors,
    logger: {
      log: (...args: unknown[]): void => {
        logs.push(args.map(asText).join(' '));
      },
      error: (...args: unknown[]): void => {
        errors.push(args.map(asText).join(' '));
      },
    },
  };
}

/** Renders a logged argument as text, so an `Error` contributes its message. */
function asText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * A port that was free a moment ago, obtained by binding and releasing it.
 *
 * There is no way to hold a reservation — that is what binding is — so this is
 * inherently a hint. It is good enough here because a passing test needs the
 * port to be *unused*, and the assertions that depend on it would fail loudly if
 * something else grabbed it, rather than passing for the wrong reason.
 */
function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('Probe server did not report a TCP port')));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/** Whether anything accepts a TCP connection on `port` of the loopback interface. */
function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });

    const settle = (accepted: boolean): void => {
      socket.destroy();
      resolve(accepted);
    };

    socket.setTimeout(2000);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/** Closes a started server, so a test never leaves a listener behind. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
