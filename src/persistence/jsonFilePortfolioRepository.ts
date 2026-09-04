import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { PersistenceError, StartupError } from '../domain/errors';
import type { PortfolioState } from '../domain/types';

import type { PortfolioRepository } from './portfolioRepository';
import { deserializePortfolioState, serializePortfolioState } from './serialization';

/**
 * A {@link PortfolioRepository} backed by a single JSON file.
 *
 * The whole Portfolio is rewritten on every save. That is deliberate: the
 * Portfolio of a single user is small, and rewriting it wholesale is what makes
 * the write atomic (see {@link JsonFilePortfolioRepository.save}). An
 * append-style or partial-update store would need its own crash-recovery logic
 * to offer the same guarantee.
 */
export class JsonFilePortfolioRepository implements PortfolioRepository {
  /** Absolute or process-relative path of the persisted JSON document. */
  private readonly filePath: string;

  /** Directory holding {@link filePath}; temp files are created here too. */
  private readonly directory: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.directory = path.dirname(filePath);
  }

  /**
   * Reads the persisted Portfolio (Req 5.3).
   *
   * A missing file means nothing has ever been persisted, which is a normal
   * first-run state and resolves with an empty Portfolio (Req 5.5). Every other
   * outcome — an unreadable file, invalid JSON, or JSON that is not a
   * well-formed Portfolio — means persisted data exists but cannot be used, and
   * rejects with a `StartupError` (Req 5.6). The distinction matters: silently
   * treating a corrupted file as "empty" would hand the user a blank Portfolio
   * and let the next save overwrite their real data.
   */
  async load(): Promise<PortfolioState> {
    let contents: string;
    try {
      contents = await fs.readFile(this.filePath, 'utf8');
    } catch (cause) {
      if (isNotFound(cause)) {
        return emptyPortfolioState();
      }
      throw new StartupError(
        `Unable to read persisted portfolio at ${this.filePath}: ${describe(cause)}`,
        cause,
      );
    }

    try {
      return deserializePortfolioState(JSON.parse(contents));
    } catch (cause) {
      throw new StartupError(
        `Unable to parse persisted portfolio at ${this.filePath}: ${describe(cause)}`,
        cause,
      );
    }
  }

  /**
   * Persists `state` in full, all-or-nothing (Req 5.1, 5.2).
   *
   * The document is written to a uniquely named temp file in the *same*
   * directory as the target, flushed to disk, and only then renamed over the
   * target. Same directory matters: `rename` is only atomic within a single
   * filesystem, and a temp file elsewhere (e.g. the OS temp dir) could land on
   * a different one and degrade into a non-atomic copy. Because the rename is
   * atomic, a reader ever sees either the complete previous document or the
   * complete new one, and any failure before the rename leaves the previously
   * persisted file untouched (Req 5.4).
   *
   * The temp file is removed on failure so repeated errors cannot litter the
   * directory.
   *
   * The rename - and only the rename - is retried on a few transient error
   * codes; see {@link renameWithRetry}.
   */
  async save(state: PortfolioState): Promise<void> {
    const document = `${JSON.stringify(serializePortfolioState(state), null, 2)}\n`;
    const tempPath = this.temporaryPath();

    try {
      await fs.mkdir(this.directory, { recursive: true });
      await writeAndFlush(tempPath, document);
      await this.renameWithRetry(tempPath);
    } catch (cause) {
      // Reached only after the rename has given up for good, so discarding the
      // temp file here cannot pull it out from under a pending retry.
      await discard(tempPath);
      throw new PersistenceError(
        `Unable to persist portfolio to ${this.filePath}: ${describe(cause)}`,
        cause,
      );
    }
  }

  /**
   * Renames the fully written temp file over the target, retrying a bounded
   * number of times on the codes listed in {@link isTransientRenameFailure}.
   *
   * Why this exists: a property test doing hundreds of write+sync+rename cycles
   * per run failed once and has never reproduced, including on replays of the
   * reported seed and path. Seed plus path fully determine the generated input,
   * which rules out an input-driven logic bug. The leading remaining hypothesis
   * is a transient rename failure - on Windows, renaming over an existing target
   * can fail with EPERM/EACCES/EBUSY while an antivirus scanner or the search
   * indexer holds the target open for a moment. That hypothesis is plausible but
   * unproven: the original failure was never captured, so this retry is a
   * defence against a suspected cause, not a confirmed fix.
   *
   * Retrying is safe for the atomicity guarantee (Req 5.4). By the time this
   * runs, the temp file is completely written and flushed, so every attempt is
   * the same all-or-nothing swap: the target is either the complete previous
   * document or the complete new one, never a torn mixture. A retry adds
   * attempts at that swap, it cannot add intermediate states.
   *
   * On final failure the behaviour is unchanged from having no retry at all: the
   * caller sees a `PersistenceError` wrapping the underlying filesystem error,
   * and the previously persisted file is untouched.
   */
  private async renameWithRetry(tempPath: string): Promise<void> {
    let delayMs = RENAME_RETRY_INITIAL_DELAY_MS;

    for (let attempt = 1; ; attempt += 1) {
      try {
        await fs.rename(tempPath, this.filePath);
        return;
      } catch (cause) {
        // A non-transient code is reported immediately: retrying a full disk or
        // a read-only filesystem only delays the report and buries the cause.
        // The error thrown is the one that ended the loop, so a real fault is
        // never masked by an earlier transient one.
        if (attempt >= RENAME_ATTEMPTS || !isTransientRenameFailure(cause)) {
          throw cause;
        }
        await delay(delayMs);
        delayMs *= 2;
      }
    }
  }

  /**
   * A collision-free sibling of the target file. The random suffix keeps
   * concurrent or retried saves — including those from another process sharing
   * the file — from writing into the same temp file.
   */
  private temporaryPath(): string {
    return path.join(this.directory, `.${path.basename(this.filePath)}.${randomUUID()}.tmp`);
  }
}

/**
 * Total rename attempts, the first try included.
 *
 * Four attempts with the backoff below spend at most 20 + 40 + 80 = 140 ms
 * waiting, which stays well inside the time a save may take without a user
 * noticing. The locks this absorbs are held for a few tens of milliseconds, so
 * more attempts would mostly buy latency on failures that are not transient at
 * all; fewer would leave no room for the second, longer wait that usually
 * outlasts a scanner.
 */
const RENAME_ATTEMPTS = 4;

/** First backoff, doubled after each failed attempt. */
const RENAME_RETRY_INITIAL_DELAY_MS = 20;

/**
 * Error codes worth retrying for a rename over an existing target.
 *
 * Deliberately narrow. These three are what Windows reports while another
 * process holds the target file open, a condition that clears on its own.
 * Everything else - ENOSPC, EROFS, ENOENT, EISDIR, EIO, EXDEV - describes a
 * state that a retry cannot improve, and retrying it would turn a clear failure
 * into a slow one.
 */
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** True when `cause` is a rename failure that may clear on its own. */
function isTransientRenameFailure(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && TRANSIENT_RENAME_CODES.has(code);
}

/** Resolves after `milliseconds`. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** A Portfolio with zero Holdings and zero Transactions (Req 5.5). */
function emptyPortfolioState(): PortfolioState {
  return { holdings: new Map(), transactions: [] };
}

/**
 * Writes `contents` to `filePath` and flushes it to the storage device before
 * resolving. Without the flush the data could still be sitting in the OS page
 * cache when the rename is recorded, so a crash could leave the target file
 * renamed but empty — exactly the torn state the temp-file dance exists to
 * prevent.
 */
async function writeAndFlush(filePath: string, contents: string): Promise<void> {
  // 'wx' fails rather than overwriting, so a name collision can never silently
  // clobber another writer's temp file.
  const handle = await fs.open(filePath, 'wx');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Best-effort removal of a temp file after a failed save. Errors are swallowed:
 * the caller is already reporting the original failure, and a leftover temp file
 * is harmless next to an intact target file.
 */
async function discard(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignored on purpose - see above.
  }
}

/** True when `cause` is a filesystem error reporting a missing path. */
function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code === 'ENOENT'
  );
}

/** The message of an `Error`-like cause, or its string form otherwise. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
