import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushDurableState } from './durableFlush';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('flushDurableState', () => {
  it('checkpoints the WAL, fsyncs the Pane directory files, then syncs the filesystem', async () => {
    const paneDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-cloud-flush-'));
    tempDirs.push(paneDirectory);
    fs.writeFileSync(path.join(paneDirectory, 'sessions.db'), 'db');
    fs.writeFileSync(path.join(paneDirectory, 'sessions.db-wal'), 'wal');
    fs.mkdirSync(path.join(paneDirectory, 'logs'));
    const order: string[] = [];
    const checkpointWal = vi.fn(() => {
      order.push('checkpoint');
      return { busy: 0, log: 3, checkpointed: 3 };
    });
    const syncFilesystem = vi.fn(async () => {
      order.push('sync');
      return true;
    });
    let clock = 100;

    const result = await flushDurableState({ checkpointWal, paneDirectory, syncFilesystem, now: () => (clock += 5) });

    expect(order).toEqual(['checkpoint', 'sync']);
    expect(result.walCheckpoint).toEqual({ busy: 0, log: 3, checkpointed: 3 });
    expect(result.fsynced.slice(0, 2)).toEqual([
      path.join(paneDirectory, 'sessions.db'),
      path.join(paneDirectory, 'sessions.db-wal'),
    ]);
    expect(result.syncedFilesystem).toBe(true);
    expect(result.durationMs).toBe(5);
    expect(syncFilesystem).toHaveBeenCalledWith(paneDirectory);
  });

  it('still syncs when the Pane directory is missing', async () => {
    const result = await flushDurableState({
      checkpointWal: () => null,
      paneDirectory: path.join(os.tmpdir(), 'pane-cloud-flush-missing-dir'),
      syncFilesystem: async () => true,
    });

    expect(result).toMatchObject({ walCheckpoint: null, fsynced: [], syncedFilesystem: true });
  });
});
