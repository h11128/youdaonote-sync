import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renameReplace, replaceViaBackup } from './atomic-replace.js';

describe('renameReplace / replaceViaBackup', () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('replaceViaBackup moves target aside then installs tmp (no unlink-first)', () => {
    dir = join(tmpdir(), `yd-replace-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'note.audio');
    const tmp = join(dir, 'note.tmp');
    writeFileSync(target, 'ORIGINAL');
    writeFileSync(tmp, 'NEW');

    replaceViaBackup(tmp, target);

    expect(readFileSync(target, 'utf-8')).toBe('NEW');
    expect(existsSync(tmp)).toBe(false);
    // no leftover .bak.*
    expect(readdirSync(dir).filter((n) => n.includes('.bak.'))).toEqual([]);
  });

  it('renameReplace overwrites an existing file', () => {
    dir = join(tmpdir(), `yd-rename-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'note.audio');
    const tmp = join(dir, 'note.tmp');
    writeFileSync(target, 'OLD');
    writeFileSync(tmp, 'NEW');

    renameReplace(tmp, target);
    expect(readFileSync(target, 'utf-8')).toBe('NEW');
  });

  it('renameReplace creates target when missing', () => {
    dir = join(tmpdir(), `yd-create-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'note.audio');
    const tmp = join(dir, 'note.tmp');
    writeFileSync(tmp, 'ONLY');

    renameReplace(tmp, target);
    expect(readFileSync(target, 'utf-8')).toBe('ONLY');
  });
});
