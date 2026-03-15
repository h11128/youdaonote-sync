import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SyncLock } from './lock.js';

const TMP = join(tmpdir(), `lock-test-${Date.now()}`);

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('SyncLock', () => {
  it('acquires and releases lock', () => {
    const lock = new SyncLock(TMP);
    expect(lock.acquire()).toBe(true);
    lock.release();
  });

  it('prevents double acquire by same process', () => {
    const lock1 = new SyncLock(TMP);
    const lock2 = new SyncLock(TMP);

    expect(lock1.acquire()).toBe(true);
    expect(lock2.acquire()).toBe(false);
    lock1.release();
  });

  it('allows acquire after release', () => {
    const lock = new SyncLock(TMP);
    expect(lock.acquire()).toBe(true);
    lock.release();
    expect(lock.acquire()).toBe(true);
    lock.release();
  });

  it('takes over stale lock (dead PID)', () => {
    const lockPath = join(TMP, '.sync.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 999999999, started: Date.now() }));

    const lock = new SyncLock(TMP);
    expect(lock.acquire()).toBe(true);
    lock.release();
  });

  it('takes over expired lock (>1 hour)', () => {
    const lockPath = join(TMP, '.sync.lock');
    const expired = Date.now() - 3600 * 1000 - 1;
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started: expired }));

    const lock = new SyncLock(TMP);
    expect(lock.acquire()).toBe(true);
    lock.release();
  });

  it('takes over corrupted lock file', () => {
    const lockPath = join(TMP, '.sync.lock');
    writeFileSync(lockPath, 'not valid json {{{');

    const lock = new SyncLock(TMP);
    expect(lock.acquire()).toBe(true);
    lock.release();
  });

  it('lock file contains valid JSON with pid and started', () => {
    const lock = new SyncLock(TMP);
    lock.acquire();

    const lockPath = join(TMP, '.sync.lock');
    const content = JSON.parse(readFileSync(lockPath, 'utf-8'));
    expect(content.pid).toBe(process.pid);
    expect(typeof content.started).toBe('number');
    lock.release();
  });

  it('release is idempotent', () => {
    const lock = new SyncLock(TMP);
    lock.acquire();
    lock.release();
    lock.release();
  });
});
