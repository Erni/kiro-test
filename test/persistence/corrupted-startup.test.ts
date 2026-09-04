import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { StartupError } from '../../src/domain/errors';
import type { PortfolioState } from '../../src/domain/types';
import { JsonFilePortfolioRepository } from '../../src/persistence/jsonFilePortfolioRepository';

/**
 * Requirement 5.6: when persisted Portfolio data exists but cannot be loaded,
 * startup reports a startup error and no Portfolio is presented.
 *
 * The critical distinction from Requirement 5.5 is that a corrupted file must
 * never be mistaken for "nothing persisted yet": that would hand the user a
 * blank Portfolio and let the next save overwrite their real data. So each case
 * asserts a rejection rather than an empty state, and one case asserts the
 * corrupted bytes are still on disk afterwards.
 *
 * Real files in a temp directory are used instead of a mocked filesystem,
 * because the behavior under test is how the repository reacts to actual file
 * contents.
 */
describe('JsonFilePortfolioRepository.load with corrupted persisted data', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-corrupted-startup-'));
    filePath = path.join(directory, 'portfolio.json');
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  /** Writes `contents` as the persisted document and loads it back. */
  async function loadFrom(contents: string): Promise<PortfolioState> {
    await fs.writeFile(filePath, contents, 'utf8');
    return new JsonFilePortfolioRepository(filePath).load();
  }

  it('rejects with a StartupError when the file is not valid JSON', async () => {
    await expect(loadFrom('{ this is not json')).rejects.toThrow(StartupError);
  });

  it('rejects with a StartupError when the file is empty', async () => {
    await expect(loadFrom('')).rejects.toThrow(StartupError);
  });

  it('rejects with a StartupError when the JSON is valid but is not a portfolio object', async () => {
    await expect(loadFrom('[]')).rejects.toThrow(StartupError);
  });

  it('rejects with a StartupError when a required collection is missing', async () => {
    await expect(loadFrom(JSON.stringify({ holdings: [] }))).rejects.toThrow(StartupError);
  });

  it('rejects with a StartupError when a holding field is malformed', async () => {
    const document = JSON.stringify({
      holdings: [{ symbol: 'BTC', quantity: 'not-a-number', currentPrice: '50000' }],
      transactions: [],
    });

    await expect(loadFrom(document)).rejects.toThrow(StartupError);
  });

  it('reports the offending file and the underlying reason', async () => {
    const error = await loadFrom('{ this is not json').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(StartupError);
    expect((error as StartupError).kind).toBe('StartupError');
    expect((error as StartupError).message).toContain(filePath);
    expect((error as StartupError).cause).toBeDefined();
  });

  it('leaves the corrupted file untouched, so the data can still be recovered', async () => {
    const contents = '{ this is not json';

    await expect(loadFrom(contents)).rejects.toThrow(StartupError);

    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe(contents);
  });
});
