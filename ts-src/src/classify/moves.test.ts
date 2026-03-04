import { describe, expect, it } from 'vitest';
import { detectMoves, commonAncestorDepth } from './moves.js';
import { asContentHash } from '../types/common.js';
import type { FileState } from '../types/state.js';

function entry(kind: FileState['kind'], hash: string | null) {
  return {
    state: { kind } as FileState,
    hash: hash ? asContentHash(hash) : null,
  };
}

describe('detectMoves phase 3 hash matching', () => {
  it('detects cloud-side rename (cloudDeleted + cloudNew with same hash)', () => {
    const classified = new Map([
      ['/old/file.md', entry('cloudDeleted', 'hash-123')],
      ['/new/file.md', entry('cloudNew', 'hash-123')],
    ]);

    const result = detectMoves(classified);

    expect(result.get('/new/file.md')).toEqual({ kind: 'moved', oldPath: '/old/file.md' });
    expect(result.get('/old/file.md')).toEqual({ kind: 'gone' });
  });

  it('detects local-side rename (localDeleted + localNew with same hash)', () => {
    const classified = new Map([
      ['/old/note.md', entry('localDeleted', 'hash-456')],
      ['/new/note.md', entry('localNew', 'hash-456')],
    ]);

    const result = detectMoves(classified);

    expect(result.get('/new/note.md')).toEqual({ kind: 'moved', oldPath: '/old/note.md' });
    expect(result.get('/old/note.md')).toEqual({ kind: 'gone' });
  });

  it('does not match when hashes differ', () => {
    const classified = new Map([
      ['/old.md', entry('cloudDeleted', 'hash-a')],
      ['/new.md', entry('cloudNew', 'hash-b')],
    ]);

    const result = detectMoves(classified);

    expect(result.size).toBe(0);
  });

  it('does not match when hash is null', () => {
    const classified = new Map([
      ['/old.md', entry('cloudDeleted', null)],
      ['/new.md', entry('cloudNew', null)],
    ]);

    const result = detectMoves(classified);

    expect(result.size).toBe(0);
  });

  it('pairs multiple moves with same hash 1:1', () => {
    const classified = new Map([
      ['/del-1.md', entry('cloudDeleted', 'hash-x')],
      ['/del-2.md', entry('cloudDeleted', 'hash-x')],
      ['/new-1.md', entry('cloudNew', 'hash-x')],
      ['/new-2.md', entry('cloudNew', 'hash-x')],
      ['/new-3.md', entry('cloudNew', 'hash-x')],
    ]);

    const result = detectMoves(classified);

    const moved = [...result.entries()].filter(([, s]) => s.kind === 'moved');
    expect(moved.length).toBe(2);
  });

  it('ignores entries with unrelated states', () => {
    const classified = new Map([
      ['/synced.md', entry('synced', 'hash-123')],
      ['/modified.md', entry('localModified', 'hash-123')],
    ]);

    const result = detectMoves(classified);

    expect(result.size).toBe(0);
  });
});

describe('detectMoves phase 2 filename normalization', () => {
  it('phase 2: matches by normalized filename in same directory', () => {
    // sanitize('<') → '_', sanitize('>') → deleted
    // so 'hello<world>.md' normalizes to 'hello_world.md'
    const classified = new Map([
      ['docs/hello<world>.md', entry('cloudDeleted', null)],
      ['docs/hello_world.md', entry('cloudNew', null)],
    ]);

    const result = detectMoves(classified);

    expect(result.get('docs/hello_world.md')).toEqual({
      kind: 'moved',
      oldPath: 'docs/hello<world>.md',
    });
  });

  it('phase 2: does not match across different directories', () => {
    const classified = new Map([
      ['dir-a/file.md', entry('cloudDeleted', null)],
      ['dir-b/file.md', entry('cloudNew', null)],
    ]);

    const result = detectMoves(classified);

    // Phase 2 won't match (different dirs), but phase 3 filename matching
    // requires ancestor depth >= 1, which fails for dir-a vs dir-b
    expect(result.size).toBe(0);
  });
});

describe('detectMoves phase 3B cross-directory', () => {
  it('phase 3B: matches cross-directory with shared ancestor', () => {
    const classified = new Map([
      ['project/old-dir/meeting-recap.md', entry('cloudDeleted', null)],
      ['project/new-dir/meeting-recap.md', entry('cloudNew', null)],
    ]);

    const result = detectMoves(classified);

    expect(result.get('project/new-dir/meeting-recap.md')).toEqual({
      kind: 'moved',
      oldPath: 'project/old-dir/meeting-recap.md',
    });
  });

  it('phase 3B: skips generic filenames without hash evidence', () => {
    const classified = new Map([
      ['a/readme.md', entry('cloudDeleted', null)],
      ['b/readme.md', entry('cloudNew', null)],
    ]);

    // No hash, no common ancestor → should not match generic names
    const result = detectMoves(classified);

    expect(result.size).toBe(0);
  });

  it('phase 3B: matches generic filenames when hash matches', () => {
    const classified = new Map([
      ['a/readme.md', entry('cloudDeleted', 'hash-same')],
      ['b/readme.md', entry('cloudNew', 'hash-same')],
    ]);

    // Hash match works even for generic names (phase 3A, hash matching)
    const result = detectMoves(classified);

    expect(result.get('b/readme.md')).toEqual({ kind: 'moved', oldPath: 'a/readme.md' });
  });

  it('phase 3B: picks closest ancestor when multiple candidates', () => {
    const classified = new Map([
      ['project/sub/old/doc.md', entry('localDeleted', null)],
      ['project/sub/new/doc.md', entry('localNew', null)],
      ['other/dir/doc.md', entry('localNew', null)],
    ]);

    const result = detectMoves(classified);

    // project/sub/new has depth 2 with project/sub/old; other/dir has depth 0
    expect(result.get('project/sub/new/doc.md')).toEqual({
      kind: 'moved',
      oldPath: 'project/sub/old/doc.md',
    });
    expect(result.has('other/dir/doc.md')).toBe(false);
  });
});

describe('commonAncestorDepth', () => {
  it('returns 0 for unrelated paths', () => {
    expect(commonAncestorDepth('a/file.md', 'b/file.md')).toBe(0);
  });

  it('returns shared prefix depth', () => {
    expect(commonAncestorDepth('a/b/c/file.md', 'a/b/d/file.md')).toBe(2);
  });

  it('handles root-level files', () => {
    expect(commonAncestorDepth('file1.md', 'file2.md')).toBe(0);
  });

  it('handles backslash separators', () => {
    expect(commonAncestorDepth('a\\b\\file.md', 'a\\b\\other.md')).toBe(2);
  });
});
