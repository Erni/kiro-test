import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { JsonFilePortfolioRepository } from '../../src/persistence/jsonFilePortfolioRepository';

/**
 * Requirement 5.5: with no previously persisted Portfolio data, startup yields
 * an empty Portfolio - zero Holdings and zero Transactions.
 *
 * A real temporary directory is used rather than a mocked filesystem: the
 * behavior under test is precisely how the repository reacts to a missing file,
 * so a stubbed `fs` would only assert our own assumptions about it.
 */
describe('JsonFilePortfolioRepository.load with no persisted data', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-empty-startup-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('returns a portfolio with zero holdings and zero transactions', async () => {
    const filePath = path.join(directory, 'portfolio.json');
    await expect(fs.access(filePath)).rejects.toThrow();

    const state = await new JsonFilePortfolioRepository(filePath).load();

    expect(state.holdings.size).toBe(0);
    expect(state.transactions).toHaveLength(0);
  });

  it('does not create the file as a side effect of loading', async () => {
    const filePath = path.join(directory, 'portfolio.json');

    await new JsonFilePortfolioRepository(filePath).load();

    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('returns an empty portfolio when the containing directory does not exist either', async () => {
    const filePath = path.join(directory, 'nested', 'deeper', 'portfolio.json');

    const state = await new JsonFilePortfolioRepository(filePath).load();

    expect(state.holdings.size).toBe(0);
    expect(state.transactions).toHaveLength(0);
  });

  it('returns independent state objects across loads, so callers cannot share mutations', async () => {
    const repository = new JsonFilePortfolioRepository(path.join(directory, 'portfolio.json'));

    const first = await repository.load();
    const second = await repository.load();

    expect(first.holdings).not.toBe(second.holdings);
    expect(first.transactions).not.toBe(second.transactions);
  });
});
