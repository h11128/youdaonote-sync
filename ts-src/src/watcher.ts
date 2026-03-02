import { SyncEngine } from './engine.js';
import type { SyncEngineConfig } from './engine.js';

/**
 * Poll-based sync watcher.
 * Runs the sync engine at a configured interval.
 */
export class SyncWatcher {
  private engine: SyncEngine;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(config: SyncEngineConfig, intervalMs = 5 * 60 * 1000) {
    this.engine = new SyncEngine(config);
    this.intervalMs = intervalMs;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    console.log(`Watcher started (interval: ${this.intervalMs / 1000}s)`);

    await this.runOnce();

    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.engine.close();
    console.log('Watcher stopped');
  }

  private async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.engine.sync();
      const s = result.stats;
      const total = s.downloaded + s.uploaded + s.conflicts + s.moved;
      if (total > 0) {
        console.log(
          `Sync: ↓${s.downloaded} ↑${s.uploaded} ⚡${s.conflicts} →${s.moved} ` +
          `(${s.skipped} skipped, ${s.errors} errors)`,
        );
      }
    } catch (e: unknown) {
      console.error(`Sync error: ${e}`);
    } finally {
      this.running = false;
    }
  }
}
