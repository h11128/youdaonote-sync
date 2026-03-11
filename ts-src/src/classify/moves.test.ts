import { describe, expect, it } from 'vitest';
import { detectMoves, commonAncestorDepth } from './moves.js';
import { asContentHash, asRelPath } from '../types/common.js';
import type { ContentHash, RelPath } from '../types/common.js';
import type { FileState } from '../types/state.js';

interface ClassifiedEntry {
  state: FileState;
  hash: ContentHash | null;
}

function entry(kind: FileState['kind'], hash: string | null): ClassifiedEntry {
  const state = { kind };
  return {
    state: state as FileState,
    hash: hash ? asContentHash(hash) : null,
  };
}

function classifiedMap(entries: [string, ClassifiedEntry][]): Map<RelPath, ClassifiedEntry> {
  return new Map(entries.map(([k, v]) => [asRelPath(k), v]));
}

describe('detectMoves phase 3 hash matching', () => {
  it('detects cloud-side rename (cloudDeleted + cloudNew with same hash)', () => {
    const classified = classifiedMap([
      ['/old/file.md', entry('cloudDeleted', 'hash-123')],
      ['/new/file.md', entry('cloudNew', 'hash-123')],
    ]);

    const result = detectMoves(classified);

    expect(result.get(asRelPath('/new/file.md'))).toEqual({
      kind: 'moved',
      oldPath: asRelPath('/old/file.md'),
    });
    expect(result.get(asRelPath('/old/file.md'))).toEqual({ kind: 'gone' });
  });

  it('detects local-side rename (localDeleted + localNew with same hash)', () => {
    const classified = classifiedMap([
      ['/old/note.md', entry('localDeleted', 'hash-456')],
      ['/new/note.md', entry('localNew', 'hash-456')],
    ]);

    const result = detectMoves(classified);

    expect(result.get(asRelPath('/new/note.md'))).toEqual({
      kind: 'moved',
      oldPath: asRelPath('/old/note.md'),
    });
    expect(result.get(asRelPath('/old/note.md'))).toEqual({ kind: 'gone' });
  });

  it('does not match when hashes differ', () => {
    const classified = classifiedMap([
      ['/old.md', entry('cloudDeleted', 'hash-a')],
      ['/new.md', entry('cloudNew', 'hash-b')],
    ]);

    const result = detectMoves(classified);

    expect(result.size).toBe(0);
  });

  it('does not match when hash is null', () => {
    const classified = classifiedMap([
      ['/old.md', entry('cloudDeleted', null)],
      ['/new.md', entry('cloudNew', null)],
    ]);

    const result = detectMoves(classified);

    expect(result.size).toBe(0);
  });

  it('pairs multiple moves with same hash 1:1', () => {
    const classified = classifiedMap([
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
    const classified = classifiedMap([
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
    const classified = classifiedMap([
      ['docs/hello<world>.md', entry('cloudDeleted', null)],
      ['docs/hello_world.md', entry('cloudNew', null)],
    ]);

    const result = detectMoves(classified);

    expect(result.get(asRelPath('docs/hello_world.md'))).toEqual({
      kind: 'moved',
      oldPath: asRelPath('docs/hello<world>.md'),
    });
  });

  it('phase 2: does not match across different directories', () => {
    const classified = classifiedMap([
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
    const classified = classifiedMap([
      ['project/old-dir/meeting-recap.md', entry('cloudDeleted', null)],
      ['project/new-dir/meeting-recap.md', entry('cloudNew', null)],
    ]);

    const result = detectMoves(classified);

    expect(result.get(asRelPath('project/new-dir/meeting-recap.md'))).toEqual({
      kind: 'moved',
      oldPath: asRelPath('project/old-dir/meeting-recap.md'),
    });
  });

  it('phase 3B: skips generic filenames without hash evidence', () => {
    const classified = classifiedMap([
      ['a/readme.md', entry('cloudDeleted', null)],
      ['b/readme.md', entry('cloudNew', null)],
    ]);

    // No hash, no common ancestor → should not match generic names
    const result = detectMoves(classified);

    expect(result.size).toBe(0);
  });

  it('phase 3B: matches generic filenames when hash matches', () => {
    const classified = classifiedMap([
      ['a/readme.md', entry('cloudDeleted', 'hash-same')],
      ['b/readme.md', entry('cloudNew', 'hash-same')],
    ]);

    // Hash match works even for generic names (phase 3A, hash matching)
    const result = detectMoves(classified);

    expect(result.get(asRelPath('b/readme.md'))).toEqual({
      kind: 'moved',
      oldPath: asRelPath('a/readme.md'),
    });
  });

  it('phase 3B: picks closest ancestor when multiple candidates', () => {
    const classified = classifiedMap([
      ['project/sub/old/doc.md', entry('localDeleted', null)],
      ['project/sub/new/doc.md', entry('localNew', null)],
      ['other/dir/doc.md', entry('localNew', null)],
    ]);

    const result = detectMoves(classified);

    // project/sub/new has depth 2 with project/sub/old; other/dir has depth 0
    expect(result.get(asRelPath('project/sub/new/doc.md'))).toEqual({
      kind: 'moved',
      oldPath: asRelPath('project/sub/old/doc.md'),
    });
    expect(result.has(asRelPath('other/dir/doc.md'))).toBe(false);
  });
});

describe('detectMoves phase 4 cross-side matching', () => {
  it('matches cloudNew + localNew with same hash (simultaneous rename)', () => {
    const classified = classifiedMap([
      ['cloud/renamed.md', entry('cloudNew', 'hash-abc')],
      ['local/renamed.md', entry('localNew', 'hash-abc')],
    ]);

    const result = detectMoves(classified);

    expect(result.get(asRelPath('local/renamed.md'))).toEqual({
      kind: 'moved',
      oldPath: asRelPath('cloud/renamed.md'),
    });
    expect(result.get(asRelPath('cloud/renamed.md'))).toEqual({ kind: 'gone' });
  });

  it('does not match cloudNew + localNew when hashes differ', () => {
    const classified = classifiedMap([
      ['cloud/a.md', entry('cloudNew', 'hash-1')],
      ['local/b.md', entry('localNew', 'hash-2')],
    ]);

    const result = detectMoves(classified);

    expect(result.size).toBe(0);
  });

  it('does not match cloudNew + localNew when both hashes are null', () => {
    const classified = classifiedMap([
      ['cloud/a.md', entry('cloudNew', null)],
      ['local/b.md', entry('localNew', null)],
    ]);

    const result = detectMoves(classified);

    expect(result.size).toBe(0);
  });

  it('cross-side: pairs 1:1 when multiple candidates share same hash', () => {
    const classified = classifiedMap([
      ['cloud/file1.md', entry('cloudNew', 'hash-dup')],
      ['cloud/file2.md', entry('cloudNew', 'hash-dup')],
      ['local/file1.md', entry('localNew', 'hash-dup')],
    ]);

    const result = detectMoves(classified);

    const moved = [...result.entries()].filter(([, s]) => s.kind === 'moved');
    expect(moved.length).toBe(1);
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
