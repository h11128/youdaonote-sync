import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { backupFile } from './conflict.js';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('backupFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'conflict-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a .conflict. backup', () => {
    const src = join(tmpDir, 'test.md');
    writeFileSync(src, 'hello');

    const backup = backupFile(src);

    expect(backup).not.toBeNull();
    expect(backup!).toContain('.conflict.');
    expect(existsSync(backup!)).toBe(true);
  });

  it('returns null for non-existent file', () => {
    expect(backupFile(join(tmpDir, 'nonexistent.md'))).toBeNull();
  });
});
