import {
  openSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  existsSync,
  closeSync,
  constants,
} from 'node:fs';
import { join } from 'node:path';

const STALE_THRESHOLD_MS = 3600 * 1000; // 1 hour
const LOCK_FILENAME = '.sync.lock';

interface LockInfo {
  pid: number;
  started: number;
}

/**
 * PID-based cross-process sync lock.
 *
 * Uses O_CREAT|O_EXCL for atomic file creation to prevent race conditions.
 * Stale locks (> 1 hour or dead PID) are automatically taken over.
 */
export class SyncLock {
  private lockPath: string;

  constructor(localDir: string) {
    this.lockPath = join(localDir, LOCK_FILENAME);
  }

  acquire(): boolean {
    // Atomic create — fails if file exists
    try {
      const fd = openSync(this.lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      const info: LockInfo = { pid: process.pid, started: Date.now() };
      writeFileSync(fd, JSON.stringify(info));
      closeSync(fd);
      return true;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    }

    // Lock file exists — check if we can take over
    try {
      const raw = readFileSync(this.lockPath, 'utf-8');
      const info = JSON.parse(raw) as LockInfo;
      if (isPidAlive(info.pid) && Date.now() - info.started < STALE_THRESHOLD_MS) {
        return false;
      }
    } catch {
      // Corrupted lock file — take over
    }

    // Take over: remove + re-create atomically
    try {
      unlinkSync(this.lockPath);
    } catch {
      /* ignore */
    }
    try {
      const fd = openSync(this.lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      const info: LockInfo = { pid: process.pid, started: Date.now() };
      writeFileSync(fd, JSON.stringify(info));
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  }

  release(): void {
    try {
      if (existsSync(this.lockPath)) unlinkSync(this.lockPath);
    } catch {
      /* ignore */
    }
  }
}

function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM means the process exists but we don't have permission to signal it
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
