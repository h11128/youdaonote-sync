import { describe, expect, it } from 'vitest';
import { detectMoves } from './moves.js';
import { asContentHash } from '../types/common.js';
import type { ContentHash } from '../types/common.js';
import type { FileState } from '../types/state.js';

function entry(kind: FileState['kind'], hash: string | null) {
  return {
    state: { kind } as FileState,
    hash: hash ? asContentHash(hash) : null,
  };
}

describe('detectMoves', () => {
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

    // Only 2 pairs (limited by the 2 deleted entries)
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
