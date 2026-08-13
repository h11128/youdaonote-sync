import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { refuseEmptyOverwrite } from './empty-overwrite-guard.js';

function makeDir(): string {
  const dir = join(tmpdir(), `yd-empty-ow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('refuseEmptyOverwrite', () => {
  it('throws when empty download would replace non-empty local', () => {
    const dir = makeDir();
    const localPath = join(dir, 'diary.md');
    writeFileSync(localPath, '# keep me\n');
    expect(() => {
      refuseEmptyOverwrite({ localPath, markdown: '', raw: new Uint8Array() });
    }).toThrow(/REFUSE: empty download/);
    expect(readFileSync(localPath, 'utf8')).toBe('# keep me\n');
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws when conversion yields empty markdown but raw bytes exist', () => {
    const dir = makeDir();
    const localPath = join(dir, 'diary.md');
    writeFileSync(localPath, '# keep me\n');
    expect(() => {
      refuseEmptyOverwrite({
        localPath,
        markdown: '\n\n',
        raw: new Uint8Array([0x7b, 0x7d]),
      });
    }).toThrow(/REFUSE: empty download/);
    expect(readFileSync(localPath, 'utf8')).toBe('# keep me\n');
    rmSync(dir, { recursive: true, force: true });
  });

  it('allows empty download when local is missing', () => {
    const dir = makeDir();
    refuseEmptyOverwrite({
      localPath: join(dir, 'missing.md'),
      markdown: '',
      raw: new Uint8Array(),
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('allows empty download when local is already empty', () => {
    const dir = makeDir();
    const localPath = join(dir, 'empty.md');
    writeFileSync(localPath, '');
    refuseEmptyOverwrite({ localPath, markdown: '', raw: new Uint8Array() });
    rmSync(dir, { recursive: true, force: true });
  });

  it('allows non-empty download over non-empty local', () => {
    const dir = makeDir();
    const localPath = join(dir, 'diary.md');
    writeFileSync(localPath, 'old');
    refuseEmptyOverwrite({
      localPath,
      markdown: '# new\n',
      raw: new Uint8Array([1, 2, 3]),
    });
    rmSync(dir, { recursive: true, force: true });
  });
});
