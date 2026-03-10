import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { scanLocal, patternToRegex } from './local.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

    expect(result.has('root.md')).toBe(true);
    expect(result.has('subdir')).toBe(true);
    expect(result.has('subdir/child.md')).toBe(true);
    expect(result.get('root.md')!.isDir).toBe(false);
    expect(result.get('subdir')!.isDir).toBe(true);
  });

  it('maps .note extension to .md', () => {
    writeFileSync(join(tmpDir, 'document.note'), 'content');

    const result = scanLocal(tmpDir);

    expect(result.has('document.md')).toBe(true);
    expect(result.has('document.note')).toBe(false);
  });

  it('skips dot-files and dot-dirs', () => {
    mkdirSync(join(tmpDir, '.hidden'));
    writeFileSync(join(tmpDir, '.gitignore'), '');
    writeFileSync(join(tmpDir, 'visible.md'), '');

    const result = scanLocal(tmpDir);

    expect(result.has('.hidden')).toBe(false);
    expect(result.has('.gitignore')).toBe(false);
    expect(result.has('visible.md')).toBe(true);
  });

  it('skips images/ and attachments/ artifact dirs', () => {
    mkdirSync(join(tmpDir, 'images'));
    mkdirSync(join(tmpDir, 'attachments'));
    writeFileSync(join(tmpDir, 'images', 'pic.png'), '');
    writeFileSync(join(tmpDir, 'attachments', 'doc.pdf'), '');

    const result = scanLocal(tmpDir);

    expect(result.has('images')).toBe(false);
    expect(result.has('attachments')).toBe(false);
  });

  it('skips .conflict. files', () => {
    writeFileSync(join(tmpDir, 'file.conflict.20240101.md'), '');
    writeFileSync(join(tmpDir, 'normal.md'), '');

    const result = scanLocal(tmpDir);

    expect([...result.keys()].some((k) => k.includes('conflict'))).toBe(false);
    expect(result.has('normal.md')).toBe(true);
  });

  it('when .note and .md both exist, .md wins', () => {
    writeFileSync(join(tmpDir, 'doc.md'), 'markdown version');
    writeFileSync(join(tmpDir, 'doc.note'), 'note version');

    const result = scanLocal(tmpDir);

    const entry = result.get('doc.md');
    expect(entry).toBeDefined();
    expect(entry!.path).toContain('doc.md');
  });

  it('returns empty map for non-existent directory', () => {
    const result = scanLocal(join(tmpDir, 'nonexistent'));
    expect(result.size).toBe(0);
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

    expect(result.has('real.md')).toBe(true);
    expect(result.has('realdir')).toBe(true);
    expect(result.has('link-file.md')).toBe(false);
    expect(result.has('link-dir')).toBe(false);
    // child of symlinked dir should not appear
    expect(result.has('link-dir/child.md')).toBe(false);
  });

  it('applies exclude filter', () => {
    writeFileSync(join(tmpDir, 'keep.md'), '');
    writeFileSync(join(tmpDir, 'secret.md'), '');

    const result = scanLocal(tmpDir, '', { exclude: ['secret*'] });

    expect(result.has('keep.md')).toBe(true);
    expect(result.has('secret.md')).toBe(false);
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
