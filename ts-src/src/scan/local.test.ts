import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { scanLocal, scanLocalParallel, patternToRegex } from './local.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { asRelPath } from '../types/common.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'scan-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('scanLocal: basic scanning', () => {
  it('scans files and directories', () => {
    mkdirSync(join(tmpDir, 'subdir'));
    writeFileSync(join(tmpDir, 'root.md'), 'hello');
    writeFileSync(join(tmpDir, 'subdir', 'child.md'), 'world');

    const result = scanLocal(tmpDir);

    expect(result.has(asRelPath('root.md'))).toBe(true);
    expect(result.has(asRelPath('subdir'))).toBe(true);
    expect(result.has(asRelPath('subdir/child.md'))).toBe(true);
    expect(result.get(asRelPath('root.md'))!.isDir).toBe(false);
    expect(result.get(asRelPath('subdir'))!.isDir).toBe(true);
  });

  it('maps .note extension to .md', () => {
    writeFileSync(join(tmpDir, 'document.note'), 'content');

    const result = scanLocal(tmpDir);

    expect(result.has(asRelPath('document.md'))).toBe(true);
    expect(result.has(asRelPath('document.note'))).toBe(false);
  });

  it('skips dot-files and dot-dirs', () => {
    mkdirSync(join(tmpDir, '.hidden'));
    writeFileSync(join(tmpDir, '.gitignore'), '');
    writeFileSync(join(tmpDir, 'visible.md'), '');

    const result = scanLocal(tmpDir);

    expect(result.has(asRelPath('.hidden'))).toBe(false);
    expect(result.has(asRelPath('.gitignore'))).toBe(false);
    expect(result.has(asRelPath('visible.md'))).toBe(true);
  });

  it('skips images/ and attachments/ artifact dirs', () => {
    mkdirSync(join(tmpDir, 'images'));
    mkdirSync(join(tmpDir, 'attachments'));
    writeFileSync(join(tmpDir, 'images', 'pic.png'), '');
    writeFileSync(join(tmpDir, 'attachments', 'doc.pdf'), '');

    const result = scanLocal(tmpDir);

    expect(result.has(asRelPath('images'))).toBe(false);
    expect(result.has(asRelPath('attachments'))).toBe(false);
  });

  it('skips *.media dirs for voice clip binaries', () => {
    mkdirSync(join(tmpDir, '语音_x.media'));
    writeFileSync(join(tmpDir, '语音_x.media', '000-rec.aac'), '');
    writeFileSync(join(tmpDir, '语音_x.audio'), '{}');

    const result = scanLocal(tmpDir);

    expect(result.has(asRelPath('语音_x.media'))).toBe(false);
    expect(result.has(asRelPath('语音_x.audio'))).toBe(true);
  });

  it('skips .conflict. files', () => {
    writeFileSync(join(tmpDir, 'file.conflict.20240101.md'), '');
    writeFileSync(join(tmpDir, 'normal.md'), '');

    const result = scanLocal(tmpDir);

    expect([...result.keys()].some((k) => k.includes('conflict'))).toBe(false);
    expect(result.has(asRelPath('normal.md'))).toBe(true);
  });

  it('when .note and .md both exist, .md wins', () => {
    writeFileSync(join(tmpDir, 'doc.md'), 'markdown version');
    writeFileSync(join(tmpDir, 'doc.note'), 'note version');

    const result = scanLocal(tmpDir);

    const entry = result.get(asRelPath('doc.md'));
    expect(entry).toBeDefined();
    expect(entry!.path).toContain('doc.md');
  });

  it('returns empty map for non-existent directory', () => {
    const result = scanLocal(join(tmpDir, 'nonexistent'));
    expect(result.size).toBe(0);
  });
});

describe('scanLocalParallel', () => {
  it('produces same results as scanLocal', async () => {
    mkdirSync(join(tmpDir, 'subdir'));
    writeFileSync(join(tmpDir, 'root.md'), 'hello');
    writeFileSync(join(tmpDir, 'subdir', 'child.md'), 'world');

    const syncResult = scanLocal(tmpDir);
    const asyncResult = await scanLocalParallel(tmpDir);

    expect(asyncResult.size).toBe(syncResult.size);
    for (const [k, v] of syncResult) {
      expect(asyncResult.has(k)).toBe(true);
      expect(asyncResult.get(k)!.path).toBe(v.path);
      expect(asyncResult.get(k)!.isDir).toBe(v.isDir);
      expect(asyncResult.get(k)!.mtime).toBe(v.mtime);
    }
  });

  it('respects include/exclude filters', async () => {
    writeFileSync(join(tmpDir, 'keep.md'), '');
    writeFileSync(join(tmpDir, 'secret.md'), '');

    const result = await scanLocalParallel(tmpDir, '', { exclude: ['secret*'] });

    expect(result.has(asRelPath('keep.md'))).toBe(true);
    expect(result.has(asRelPath('secret.md'))).toBe(false);
  });

  it('skips *.media dirs like scanLocal', async () => {
    mkdirSync(join(tmpDir, '语音_x.media'));
    writeFileSync(join(tmpDir, '语音_x.media', '000-rec.aac'), '');
    writeFileSync(join(tmpDir, '语音_x.audio'), '{}');

    const result = await scanLocalParallel(tmpDir);
    expect(result.has(asRelPath('语音_x.media'))).toBe(false);
    expect(result.has(asRelPath('语音_x.audio'))).toBe(true);
  });
});

describe('scanLocal: advanced filtering', () => {
  it('skips symbolic links to files and directories', () => {
    writeFileSync(join(tmpDir, 'real.md'), 'real content');
    mkdirSync(join(tmpDir, 'realdir'));
    writeFileSync(join(tmpDir, 'realdir', 'child.md'), 'child');

    try {
      symlinkSync(join(tmpDir, 'real.md'), join(tmpDir, 'link-file.md'));
      symlinkSync(join(tmpDir, 'realdir'), join(tmpDir, 'link-dir'), 'junction');
    } catch {
      // symlink creation may fail without privileges on Windows — skip test
      return;
    }

    const result = scanLocal(tmpDir);

    expect(result.has(asRelPath('real.md'))).toBe(true);
    expect(result.has(asRelPath('realdir'))).toBe(true);
    expect(result.has(asRelPath('link-file.md'))).toBe(false);
    expect(result.has(asRelPath('link-dir'))).toBe(false);
    // child of symlinked dir should not appear
    expect(result.has(asRelPath('link-dir/child.md'))).toBe(false);
  });

  it('applies exclude filter', () => {
    writeFileSync(join(tmpDir, 'keep.md'), '');
    writeFileSync(join(tmpDir, 'secret.md'), '');

    const result = scanLocal(tmpDir, '', { exclude: ['secret*'] });

    expect(result.has(asRelPath('keep.md'))).toBe(true);
    expect(result.has(asRelPath('secret.md'))).toBe(false);
  });
});

describe('patternToRegex', () => {
  const cases: { name: string; pattern: string; match: string[]; noMatch: string[] }[] = [
    {
      name: 'literal filename',
      pattern: 'secret.md',
      match: ['secret.md', 'dir/secret.md'],
      noMatch: ['secret.txt', 'xsecret.md'],
    },
    {
      name: 'wildcard *',
      pattern: '*.tmp',
      match: ['a.tmp', 'dir/b.tmp'],
      noMatch: ['a.txt', 'tmp'],
    },
    {
      name: 'single char ?',
      pattern: 'doc?.md',
      match: ['doc1.md', 'dir/docX.md'],
      noMatch: ['doc12.md', 'doc.md'],
    },
    {
      name: 'special regex chars',
      pattern: 'file(1).md',
      match: ['file(1).md', 'sub/file(1).md'],
      noMatch: ['file1.md'],
    },
    {
      name: 'nested path',
      pattern: 'archive/*',
      match: ['archive/old.md'],
      noMatch: ['archive2/old.md'],
    },
  ];

  cases.forEach(({ name, pattern, match, noMatch }) => {
    it(name, () => {
      const re = patternToRegex(pattern);
      for (const m of match)
        expect(re.test(m), `expected "${m}" to match /${re.source}/`).toBe(true);
      for (const n of noMatch)
        expect(re.test(n), `expected "${n}" NOT to match /${re.source}/`).toBe(false);
    });
  });
});
