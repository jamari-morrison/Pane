import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { CloudDurableFlushResult, CloudWalCheckpoint } from '../../../../shared/types/cloudDaemon';

const SYNC_TIMEOUT_MS = 30_000;

export interface DurableFlushDependencies {
  /** Folds the SQLite WAL into the main database file. */
  checkpointWal(): CloudWalCheckpoint | null;
  /** The Pane directory: sessions.db, its WAL, config and the JSON stores live at its top level. */
  paneDirectory: string;
  /** Flushes the whole filesystem holding `directory` (worktrees, agent transcripts). */
  syncFilesystem?(directory: string): Promise<boolean>;
  now?: () => number;
}

/**
 * Makes everything the daemon has written durable on disk: checkpoint the WAL, fsync every
 * file at the top of the Pane directory and the directory itself, then sync the filesystem.
 * `synchronous = NORMAL` leaves WAL commits unsynced until a checkpoint, so a power-off right
 * after the last commit can drop it; this closes that window before a planned stop.
 */
export async function flushDurableState(dependencies: DurableFlushDependencies): Promise<CloudDurableFlushResult> {
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const walCheckpoint = dependencies.checkpointWal();
  const fsynced: string[] = [];

  for (const entry of listTopLevelFiles(dependencies.paneDirectory)) {
    if (fsyncPath(entry)) fsynced.push(entry);
  }
  if (fsyncPath(dependencies.paneDirectory)) fsynced.push(dependencies.paneDirectory);

  const syncFilesystem = dependencies.syncFilesystem ?? syncFilesystemWithCoreutils;
  const syncedFilesystem = await syncFilesystem(dependencies.paneDirectory);

  return { walCheckpoint, fsynced, syncedFilesystem, durationMs: now() - startedAt };
}

function listTopLevelFiles(directory: string): string[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => path.join(directory, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function fsyncPath(target: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, 'r');
    fs.fsyncSync(fd);
    return true;
  } catch {
    // A file removed since the listing, or a platform that cannot fsync a directory.
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** `sync -f` syncs the one filesystem (syncfs); older coreutils fall back to a full `sync`. */
function syncFilesystemWithCoreutils(directory: string): Promise<boolean> {
  if (process.platform === 'win32') return Promise.resolve(false);
  return runSync(['-f', directory]).then(ok => ok || runSync([]));
}

function runSync(args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    execFile('sync', args, { timeout: SYNC_TIMEOUT_MS }, error => resolve(!error));
  });
}
