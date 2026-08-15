import { describe, expect, it } from 'vitest';
import { bindDiaryNoteTarget, findNamedFileId, noteSiblingName } from './diary-note-sibling.js';

describe('noteSiblingName', () => {
  it('maps any local markdown name to the official-app .note', () => {
    expect(noteSiblingName('2026年8月13日.md')).toBe('2026年8月13日.note');
    expect(noteSiblingName('readme.md')).toBe('readme.note');
  });

  it('ignores non-markdown names', () => {
    expect(noteSiblingName('2026年8月13日.note')).toBeNull();
  });
});

describe('bindDiaryNoteTarget', () => {
  it('rewrites a diary .md create onto the existing .note', async () => {
    const bound = await bindDiaryNoteTarget({
      name: '2026年8月13日.md',
      fileId: 'new-id',
      isCreate: true,
      needsNote: false,
      listParent: () => Promise.resolve([{ name: '2026年8月13日.note', id: 'WEB-note' }]),
    });
    expect(bound).toEqual({
      name: '2026年8月13日.note',
      fileId: 'WEB-note',
      isCreate: false,
      needsNote: true,
    });
  });

  it('rewrites .md to .note on update without listing the parent', async () => {
    const bound = await bindDiaryNoteTarget({
      name: '2026年8月13日.md',
      fileId: 'WEB-note',
      isCreate: false,
      needsNote: true,
      listParent: () => {
        throw new Error('must not list parent on already-bound update');
      },
    });
    expect(bound).toEqual({
      name: '2026年8月13日.note',
      fileId: 'WEB-note',
      isCreate: false,
      needsNote: true,
    });
  });

  it('does not rebind an update that already targets a markdown file', async () => {
    const bound = await bindDiaryNoteTarget({
      name: 'readme.md',
      fileId: 'WEB-md',
      isCreate: false,
      needsNote: false,
      listParent: () => {
        throw new Error('must not list parent on markdown update');
      },
    });
    expect(bound).toEqual({
      name: 'readme.md',
      fileId: 'WEB-md',
      isCreate: false,
      needsNote: false,
    });
  });

  it('leaves a diary .md create unchanged when no .note sibling exists', async () => {
    const bound = await bindDiaryNoteTarget({
      name: '2026年8月13日.md',
      fileId: 'new-id',
      isCreate: true,
      needsNote: false,
      listParent: () => Promise.resolve([]),
    });
    expect(bound).toEqual({
      name: '2026年8月13日.md',
      fileId: 'new-id',
      isCreate: true,
      needsNote: false,
    });
  });
});

describe('findNamedFileId', () => {
  it('returns the matching id', () => {
    const id = findNamedFileId(
      [
        { name: '2026年8月13日.md', id: 'md-id' },
        { name: '2026年8月13日.note', id: 'note-id' },
      ],
      '2026年8月13日.note',
    );
    expect(id).toBe('note-id');
  });
});
