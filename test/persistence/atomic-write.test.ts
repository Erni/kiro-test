import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Decimal } from 'decimal.js';

import { PersistenceError } from '../../src/domain/errors';
import type { Holding, PortfolioState, Transaction } from '../../src/domain/types';
import { JsonFilePortfolioRepository } from '../../src/persistence/jsonFilePortfolioRepository';

/**
 * Requirement 5.4: when persisting a change fails, the System returns an error,
 * never reports success, and leaves the persisted state exactly as it was.
 *
 * `save()` reaches disk through two steps that can fail independently - writing
 * the temp file and renaming it over the target - so each step is failed in
 * turn and the previously persisted document is compared byte for byte
 * afterwards. Comparing bytes rather than the reloaded state is deliberate: a
 * truncated or partially rewritten file can still parse into a plausible
 * Portfolio, which is precisely the silent corruption this requirement rules
 * out.
 *
 * Real files in a temp directory are used throughout. The only fault injection
 * is a spy on the single `fs` call whose failure is under test, because a
 * genuine mid-write I/O error (a full disk, a revoked permission, a crash) is
 * not reproducible from a test. The last case needs no spy at all: it provokes a
 * real, unmocked failure from the filesystem.
 */
describe('JsonFilePortfolioRepository.save when persisting fails', () => {
  let directory: string;
  let filePath: string;
  let repository: JsonFilePortfolioRepository;

  /** The state persisted successfully before each failing save is attempted. */
  const persistedState = stateOf(
    [holding('BTC', '1.5', '50000')],
    [transaction('t-1', 'BTC', 'Buy', '1.5', '48000', '2024-05-01T12:00:00.000Z')],
  );

  /** The state each failing save attempts, and which must never reach disk. */
  const attemptedState = stateOf(
    [holding('BTC', '2.5', '51000'), holding('ETH', '10', '3000')],
    [
      transaction('t-1', 'BTC', 'Buy', '1.5', '48000', '2024-05-01T12:00:00.000Z'),
      transaction('t-2', 'ETH', 'Buy', '10', '3000', '2024-05-02T12:00:00.000Z'),
    ],
  );

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-atomic-write-'));
    filePath = path.join(directory, 'portfolio.json');
    repository = new JsonFilePortfolioRepository(filePath);
    await repository.save(persistedState);
  });

  afterEach(async () => {
    // Restored before the cleanup below, so a spy cannot break the teardown.
    jest.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('leaves the persisted file byte-for-byte intact when the rename fails', async () => {
    const before = await fs.readFile(filePath);
    jest.spyOn(fs, 'rename').mockRejectedValue(ioFailure('EPERM', 'rename not permitted'));

    await expect(repository.save(attemptedState)).rejects.toThrow(PersistenceError);

    expect(await fs.readFile(filePath)).toEqual(before);
  });

  it('leaves the persisted file byte-for-byte intact when writing the temp file fails', async () => {
    const before = await fs.readFile(filePath);
    jest.spyOn(fs, 'open').mockRejectedValue(ioFailure('ENOSPC', 'no space left on device'));

    await expect(repository.save(attemptedState)).rejects.toThrow(PersistenceError);

    expect(await fs.readFile(filePath)).toEqual(before);
  });

  it('still loads the previously persisted portfolio after a failed save', async () => {
    jest.spyOn(fs, 'rename').mockRejectedValue(ioFailure('EIO', 'i/o error'));

    await expect(repository.save(attemptedState)).rejects.toThrow(PersistenceError);

    jest.restoreAllMocks();
    const reloaded = await repository.load();

    expect([...reloaded.holdings.keys()]).toEqual(['BTC']);
    expect(reloaded.holdings.get('BTC')?.quantity.toFixed()).toBe('1.5');
    expect(reloaded.holdings.get('BTC')?.currentPrice.toFixed()).toBe('50000');
    expect(reloaded.transactions.map((entry) => entry.id)).toEqual(['t-1']);
  });

  it('reports a PersistenceError naming the target file and carrying the underlying cause', async () => {
    const cause = ioFailure('EPERM', 'rename not permitted');
    jest.spyOn(fs, 'rename').mockRejectedValue(cause);

    const error = await repository.save(attemptedState).catch((rejection: unknown) => rejection);

    expect(error).toBeInstanceOf(PersistenceError);
    expect((error as PersistenceError).kind).toBe('PersistenceError');
    expect((error as PersistenceError).message).toContain(filePath);
    expect((error as PersistenceError).cause).toBe(cause);
  });

  it('leaves no temp file behind when the rename fails', async () => {
    jest.spyOn(fs, 'rename').mockRejectedValue(ioFailure('EPERM', 'rename not permitted'));

    await expect(repository.save(attemptedState)).rejects.toThrow(PersistenceError);

    jest.restoreAllMocks();
    expect(await fs.readdir(directory)).toEqual(['portfolio.json']);
  });

  it('persists the same state successfully once the failure is gone, so nothing is left wedged', async () => {
    // Rejects for as long as the spy is installed, not just once: a single EPERM
    // is now absorbed by the bounded rename retry (see the suite below), so only
    // a failure that outlasts every attempt still surfaces to the caller.
    const rename = jest
      .spyOn(fs, 'rename')
      .mockRejectedValue(ioFailure('EPERM', 'rename not permitted'));

    await expect(repository.save(attemptedState)).rejects.toThrow(PersistenceError);
    rename.mockRestore();
    await expect(repository.save(attemptedState)).resolves.toBeUndefined();

    const reloaded = await repository.load();

    expect([...reloaded.holdings.keys()]).toEqual(['BTC', 'ETH']);
    expect(reloaded.holdings.get('BTC')?.quantity.toFixed()).toBe('2.5');
    expect(reloaded.transactions.map((entry) => entry.id)).toEqual(['t-1', 't-2']);
  });

  it('reports a PersistenceError and touches no other file when the target path is unusable', async () => {
    // A real filesystem failure, no spies: the parent "directory" of the target
    // is an existing regular file, so the save cannot even create its temp file.
    const blocker = path.join(directory, 'blocker');
    await fs.writeFile(blocker, 'not a directory', 'utf8');
    const blocked = new JsonFilePortfolioRepository(path.join(blocker, 'portfolio.json'));
    const before = await fs.readFile(filePath);

    await expect(blocked.save(attemptedState)).rejects.toThrow(PersistenceError);

    expect(await fs.readFile(blocker, 'utf8')).toBe('not a directory');
    expect(await fs.readFile(filePath)).toEqual(before);
  });
});

/** A filesystem-style rejection carrying an `errno` code, as `fs` produces. */
function ioFailure(code: string, message: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

function stateOf(holdings: readonly Holding[], transactions: readonly Transaction[]): PortfolioState {
  return {
    holdings: new Map(holdings.map((entry) => [entry.symbol, entry])),
    transactions,
  };
}

function holding(symbol: string, quantity: string, currentPrice: string): Holding {
  return { symbol, quantity: new Decimal(quantity), currentPrice: new Decimal(currentPrice) };
}

function transaction(
  id: string,
  symbol: string,
  type: Transaction['type'],
  quantity: string,
  pricePerUnit: string,
  timestamp: string,
): Transaction {
  return {
    id,
    symbol,
    type,
    quantity: new Decimal(quantity),
    pricePerUnit: new Decimal(pricePerUnit),
    timestamp: new Date(timestamp),
  };
}

/**
 * The rename step is retried a bounded number of times on the error codes
 * Windows reports when another process (antivirus, search indexer) briefly holds
 * the target file open. These tests pin the three behaviours that make that
 * retry safe rather than a way of hiding real I/O errors: a transient failure
 * heals, a persistent one still fails after exactly the configured number of
 * attempts, and a non-transient code is never retried at all.
 *
 * Fault injection follows the same approach as the suite above - a spy on the
 * single `fs` call under test - because no test can provoke a real antivirus
 * lock on demand. Attempt counts are asserted exactly: a bound that is not
 * pinned is a bound that can silently grow.
 */
describe('JsonFilePortfolioRepository.save when the rename fails transiently', () => {
  let directory: string;
  let filePath: string;
  let repository: JsonFilePortfolioRepository;

  /** Attempts the production retry policy makes, including the first try. */
  const renameAttempts = 4;

  const persistedState = stateOf(
    [holding('BTC', '1.5', '50000')],
    [transaction('t-1', 'BTC', 'Buy', '1.5', '48000', '2024-05-01T12:00:00.000Z')],
  );

  const attemptedState = stateOf(
    [holding('BTC', '2.5', '51000'), holding('ETH', '10', '3000')],
    [
      transaction('t-1', 'BTC', 'Buy', '1.5', '48000', '2024-05-01T12:00:00.000Z'),
      transaction('t-2', 'ETH', 'Buy', '10', '3000', '2024-05-02T12:00:00.000Z'),
    ],
  );

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-rename-retry-'));
    filePath = path.join(directory, 'portfolio.json');
    repository = new JsonFilePortfolioRepository(filePath);
    await repository.save(persistedState);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('persists the new document when the rename fails transiently and then succeeds', async () => {
    // Two rejections, then the spy falls through to the real rename.
    jest
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(ioFailure('EBUSY', 'resource busy'))
      .mockRejectedValueOnce(ioFailure('EACCES', 'permission denied'));

    await expect(repository.save(attemptedState)).resolves.toBeUndefined();

    const reloaded = await repository.load();
    expect([...reloaded.holdings.keys()]).toEqual(['BTC', 'ETH']);
    expect(reloaded.holdings.get('BTC')?.quantity.toFixed()).toBe('2.5');
    expect(reloaded.transactions.map((entry) => entry.id)).toEqual(['t-1', 't-2']);
    // The temp file was renamed, not abandoned, so nothing is left over.
    expect(await fs.readdir(directory)).toEqual(['portfolio.json']);
  });

  it('gives up after the bounded number of attempts when the transient failure persists', async () => {
    const before = await fs.readFile(filePath);
    const rename = jest.spyOn(fs, 'rename').mockRejectedValue(ioFailure('EPERM', 'not permitted'));

    await expect(repository.save(attemptedState)).rejects.toThrow(PersistenceError);

    expect(rename).toHaveBeenCalledTimes(renameAttempts);
    expect(await fs.readFile(filePath)).toEqual(before);
  });

  it('does not retry an error code that is not transient for a rename', async () => {
    const rename = jest
      .spyOn(fs, 'rename')
      .mockRejectedValue(ioFailure('ENOSPC', 'no space left on device'));

    await expect(repository.save(attemptedState)).rejects.toThrow(PersistenceError);

    // Retrying a full disk only delays the error report and hides the cause.
    expect(rename).toHaveBeenCalledTimes(1);
  });
});
