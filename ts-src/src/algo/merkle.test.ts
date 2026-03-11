import { describe, it, expect } from 'vitest';
import { buildTree, diffTrees } from './merkle.js';
import type { TreeHash } from './merkle.js';
import { asEpochSeconds, asRelPath } from '../types/common.js';
import type { ContentHash, RelPath } from '../types/common.js';
import type { LocalFile } from '../types/scan.js';

function lf(absPath: string, isDir: boolean, mtime = asEpochSeconds(0)): LocalFile {
  return { path: absPath, isDir, mtime };
}

describe('buildTree', () => {
  it('returns root hash for empty tree', () => {
    const result = buildTree(new Map<RelPath, LocalFile>(), new Map<RelPath, ContentHash | null>());
    expect(result.size).toBe(1);
    expect(result.has(asRelPath(''))).toBe(true);
  });

  it('produces deterministic hashes', () => {
    const files = new Map<RelPath, LocalFile>([
      [asRelPath('a.md'), lf('/x/a.md', false)],
      [asRelPath('b.md'), lf('/x/b.md', false)],
    ]);
    const hashes = new Map<RelPath, ContentHash | null>([
      [asRelPath('a.md'), 'abc123' as ContentHash],
      [asRelPath('b.md'), 'def456' as ContentHash],
    ]);
    const t1 = buildTree(files, hashes);
    const t2 = buildTree(files, hashes);
    expect(t1.get(asRelPath(''))).toBe(t2.get(asRelPath('')));
  });

  it('root hash changes when a file hash changes', () => {
    const files = new Map<RelPath, LocalFile>([[asRelPath('a.md'), lf('/x/a.md', false)]]);
    const h1 = new Map<RelPath, ContentHash | null>([[asRelPath('a.md'), 'hash1' as ContentHash]]);
    const h2 = new Map<RelPath, ContentHash | null>([[asRelPath('a.md'), 'hash2' as ContentHash]]);
    const t1 = buildTree(files, h1);
    const t2 = buildTree(files, h2);
    expect(t1.get(asRelPath(''))).not.toBe(t2.get(asRelPath('')));
  });

  it('handles nested directories', () => {
    const files = new Map<RelPath, LocalFile>([
      [asRelPath('docs'), lf('/x/docs', true)],
      [asRelPath('docs/a.md'), lf('/x/docs/a.md', false)],
    ]);
    const hashes = new Map<RelPath, ContentHash | null>([
      [asRelPath('docs/a.md'), 'h1' as ContentHash],
    ]);
    const tree = buildTree(files, hashes);
    expect(tree.has(asRelPath(''))).toBe(true);
    expect(tree.has(asRelPath('docs'))).toBe(true);
    expect(tree.size).toBe(2);
  });
});

describe('diffTrees', () => {
  it('returns empty set when roots match', () => {
    const t = new Map<RelPath, TreeHash>([[asRelPath(''), 'abc' as TreeHash]]);
    expect(diffTrees(t, t).size).toBe(0);
  });

  it('detects changed directories', () => {
    const old = new Map<RelPath, TreeHash>([
      [asRelPath(''), 'a' as TreeHash],
      [asRelPath('docs'), 'b' as TreeHash],
    ]);
    const fresh = new Map<RelPath, TreeHash>([
      [asRelPath(''), 'a2' as TreeHash],
      [asRelPath('docs'), 'b' as TreeHash],
    ]);
    const changed = diffTrees(old, fresh);
    expect(changed.has(asRelPath(''))).toBe(true);
    expect(changed.has(asRelPath('docs'))).toBe(false);
  });

  it('detects new directories', () => {
    const old = new Map<RelPath, TreeHash>([[asRelPath(''), 'x' as TreeHash]]);
    const fresh = new Map<RelPath, TreeHash>([
      [asRelPath(''), 'y' as TreeHash],
      [asRelPath('new'), 'z' as TreeHash],
    ]);
    const changed = diffTrees(old, fresh);
    expect(changed.has(asRelPath('new'))).toBe(true);
  });
});
