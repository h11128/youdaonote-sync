import { describe, it, expect } from 'vitest';
import { buildTree, diffTrees } from './merkle.js';
import type { TreeHash } from './merkle.js';
import type { ContentHash } from '../types/common.js';
import type { LocalFile } from '../types/scan.js';

function lf(path: string, isDir: boolean, mtime = 0): LocalFile {
  return { path, isDir, mtime };
}

describe('buildTree', () => {
  it('returns root hash for empty tree', () => {
    const result = buildTree(new Map(), new Map());
    expect(result.size).toBe(1);
    expect(result.has('')).toBe(true);
  });

  it('produces deterministic hashes', () => {
    const files = new Map<string, LocalFile>([
      ['a.md', lf('/x/a.md', false)],
      ['b.md', lf('/x/b.md', false)],
    ]);
    const hashes = new Map<string, ContentHash | null>([
      ['a.md', 'abc123' as ContentHash],
      ['b.md', 'def456' as ContentHash],
    ]);
    const t1 = buildTree(files, hashes);
    const t2 = buildTree(files, hashes);
    expect(t1.get('')).toBe(t2.get(''));
  });

  it('root hash changes when a file hash changes', () => {
    const files = new Map<string, LocalFile>([
      ['a.md', lf('/x/a.md', false)],
    ]);
    const h1 = new Map([['a.md', 'hash1' as ContentHash]]);
    const h2 = new Map([['a.md', 'hash2' as ContentHash]]);
    const t1 = buildTree(files, h1);
    const t2 = buildTree(files, h2);
    expect(t1.get('')).not.toBe(t2.get(''));
  });

  it('handles nested directories', () => {
    const files = new Map<string, LocalFile>([
      ['docs', lf('/x/docs', true)],
      ['docs/a.md', lf('/x/docs/a.md', false)],
    ]);
    const hashes = new Map([['docs/a.md', 'h1' as ContentHash]]);
    const tree = buildTree(files, hashes);
    expect(tree.has('')).toBe(true);
    expect(tree.has('docs')).toBe(true);
    expect(tree.size).toBe(2);
  });
});

describe('diffTrees', () => {
  it('returns empty set when roots match', () => {
    const t = new Map<string, TreeHash>([['', 'abc' as TreeHash]]);
    expect(diffTrees(t, t).size).toBe(0);
  });

  it('detects changed directories', () => {
    const old = new Map<string, TreeHash>([['', 'a' as TreeHash], ['docs', 'b' as TreeHash]]);
    const fresh = new Map<string, TreeHash>([['', 'a2' as TreeHash], ['docs', 'b' as TreeHash]]);
    const changed = diffTrees(old, fresh);
    expect(changed.has('')).toBe(true);
    expect(changed.has('docs')).toBe(false);
  });

  it('detects new directories', () => {
    const old = new Map<string, TreeHash>([['', 'x' as TreeHash]]);
    const fresh = new Map<string, TreeHash>([['', 'y' as TreeHash], ['new', 'z' as TreeHash]]);
    const changed = diffTrees(old, fresh);
    expect(changed.has('new')).toBe(true);
  });
});
