import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { mockSync, mockClose, capturedWatchCallback, mockFsWatcher, mockWatch } = vi.hoisted(() => {
  const cbRef = { current: null as ((a: string, b: string) => void) | null };
  const watcher = { on: vi.fn(), close: vi.fn() };
  return {
    mockSync: vi.fn().mockResolvedValue({
      stats: { downloaded: 0, uploaded: 0, conflicts: 0, moved: 0 },
      classified: new Map(),
    }),
    mockClose: vi.fn(),
    capturedWatchCallback: cbRef,
    mockFsWatcher: watcher,
    mockWatch: vi.fn((_dir: string, _opts: unknown, cb: (a: string, b: string) => void) => {
      cbRef.current = cb;
      return watcher;
    }),
  };
});

vi.mock('./engine.js', () => ({
  SyncEngine: vi.fn().mockImplementation(() => ({
    sync: mockSync,
    close: mockClose,
  })),
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<Record<string, unknown>>();
  return { ...fs, watch: mockWatch };
});

import { SyncWatcher } from './watcher.js';

describe('SyncWatcher', () => {
  let tmpDir: string;
  let watcher: SyncWatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = mkdtempSync(join(tmpdir(), 'watcher-test-'));
    vi.clearAllMocks();
    capturedWatchCallback.current = null;
    watcher = new SyncWatcher(
      {
        cookiesPath: join(tmpDir, 'cookies.json'),
        metadataPath: join(tmpDir, 'meta.db'),
        localDir: tmpDir,
      },
      60_000,
      100,
    );
  });

  afterEach(() => {
    watcher.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('shouldWatch filtering (indirect)', () => {
    const shouldTrigger = [
      { name: '.md files', path: 'notes/readme.md' },
      { name: '.note files', path: 'doc.note' },
    ];

    for (const { name, path } of shouldTrigger) {
      it(`triggers sync for ${name}`, async () => {
        await watcher.start();
        capturedWatchCallback.current!('change', path);
        await vi.advanceTimersByTimeAsync(150);

        expect(mockSync).toHaveBeenCalled();
      });
    }

    const shouldNotTrigger = [
      { name: '.git paths', paths: ['.git/config', 'sub/.git/HEAD'] },
      { name: '.conflict. files', paths: ['file.conflict.123.md'] },
      { name: '.db files', paths: ['meta.db'] },
      { name: '.db-journal files', paths: ['meta.db-journal'] },
    ];

    for (const { name, paths } of shouldNotTrigger) {
      it(`does not trigger sync for ${name}`, async () => {
        await watcher.start();
        const before = mockSync.mock.calls.length;

        for (const p of paths) capturedWatchCallback.current!('change', p);
        await vi.advanceTimersByTimeAsync(150);

        expect(mockSync.mock.calls.length).toBe(before);
      });
    }
  });

  describe('lifecycle', () => {
    it('calls fs.watch on start', async () => {
      await watcher.start();

      expect(mockWatch).toHaveBeenCalledWith(tmpDir, { recursive: true }, expect.any(Function));
    });

    it('closes watcher and engine on stop', async () => {
      await watcher.start();
      watcher.stop();

      expect(mockFsWatcher.close).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    });
  });
});
