import { watch, type FSWatcher } from 'node:fs';
import { normalize } from 'node:path';
import { SyncEngine } from './engine.js';
import type { SyncEngineConfig } from './types/engine-config.js';

/**
 * Sync watcher with local filesystem monitoring + cloud polling.
 *
 * - Uses Node.js recursive fs.watch to detect local file changes
 * - Debounces rapid changes (default 5s) before triggering sync
 * - Polls cloud at a configurable interval
 * - Prevents overlapping sync runs with a lock
 */
export class SyncWatcher {
  private engine: SyncEngine;
  private pollIntervalMs: number;
  private debounceMs: number;
  private localDir: string;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private fsWatcher: FSWatcher | null = null;
  private syncing = false;
  private pendingChanges = new Set<string>();

  constructor(config: SyncEngineConfig, pollIntervalMs = 5 * 60 * 1000, debounceMs = 5000) {
    this.engine = new SyncEngine(config);
    this.pollIntervalMs = pollIntervalMs;
    this.debounceMs = debounceMs;
    this.localDir = config.localDir;
  }

  async start(): Promise<void> {
    if (this.pollTimer) return;

    console.log(`Watcher started`);
    console.log(`  Local dir: ${this.localDir}`);
    console.log(`  Cloud poll interval: ${this.pollIntervalMs / 1000}s`);
    console.log(`  Local change debounce: ${this.debounceMs / 1000}s`);
    console.log(`  Press Ctrl+C to stop\n`);

    // Initial full sync
    await this.doSync('Initial full sync');

    // Start filesystem watcher
    this.startFsWatch();

    // Start cloud polling
    this.pollTimer = setInterval(() => {
      void this.doSync('Cloud poll');
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    this.engine.close();
    console.log('Watcher stopped');
  }

  private startFsWatch(): void {
    try {
      this.fsWatcher = watch(this.localDir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const normalized = normalize(filename).replace(/\\/g, '/');
        if (!this.shouldWatch(normalized)) return;

        this.pendingChanges.add(normalized);
        this.scheduleDebounce();
      });
      this.fsWatcher.on('error', (err) => {
        console.error(`FS watch error: ${err.message}`);
      });
    } catch (e: unknown) {
      console.warn(
        `Could not start filesystem watcher: ${e instanceof Error ? e.message : String(e)}\n` +
          `Falling back to poll-only mode.`,
      );
    }
  }

  private shouldWatch(filePath: string): boolean {
    if (filePath.includes('.git/') || filePath.includes('.git\\')) return false;
    if (filePath.includes('.conflict.')) return false;
    if (filePath.endsWith('.db') || filePath.endsWith('.db-journal')) return false;
    return filePath.endsWith('.md') || filePath.endsWith('.note');
  }

  private scheduleDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const changes = [...this.pendingChanges];
      this.pendingChanges.clear();
      if (changes.length > 0) {
        void this.doSync(`Local changes: ${changes.length} file(s)`);
      }
    }, this.debounceMs);
  }

  private async doSync(reason: string): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;

    const now = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`\n[${now}] ${reason}`);

    try {
      const result = await this.engine.sync();
      const s = result.stats;
      const total = s.downloaded + s.uploaded + s.conflicts + s.moved;
      if (total > 0) {
        let line = `  Downloaded ${s.downloaded}, Uploaded ${s.uploaded}`;
        if (s.conflicts) line += `, Conflicts ${s.conflicts}`;
        if (s.moved) line += `, Moved ${s.moved}`;
        console.log(line);
      } else {
        console.log('  No changes');
      }
    } catch (e: unknown) {
      console.error(`  Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.syncing = false;
    }
  }
}
