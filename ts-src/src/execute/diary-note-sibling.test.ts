import { describe, expect, it } from 'vitest';
import {
  bindDiaryNoteTarget,
  diaryNoteSiblingName,
  findNamedFileId,
} from './diary-note-sibling.js';

describe('diaryNoteSiblingName', () => {
  it('maps a diary markdown name to the official-app .note', () => {
    expect(diaryNoteSiblingName('2026年8月13日.md')).toBe('2026年8月13日.note');
  });

  it('ignores non-diary markdown', () => {
    expect(diaryNoteSiblingName('readme.md')).toBeNull();
    expect(diaryNoteSiblingName('2026年8月13日.note')).toBeNull();
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
