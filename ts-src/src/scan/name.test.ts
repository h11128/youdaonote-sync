import { describe, expect, it } from 'vitest';
import { cachedCloudName, sanitizeFilename, mapCloudName, normalizeSep } from './name.js';
import {
  domainFromCloudName,
  needsOfficialNote,
  officialAppName,
  pickPreferredCloud,
} from './cloud-identity.js';
import { asDirId, asEpochSeconds, asFileId, NoteDomain } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';

describe('sanitizeFilename', () => {
  it('replaces < with _', () => {
    expect(sanitizeFilename('file<name>.md')).toBe('file_name.md');
  });

  it('deletes forbidden characters', () => {
    // Only `<` is replaced with `_`, all others are deleted
    expect(sanitizeFilename('a\\b/c"d:e|f*g?h#i>j')).toBe('abcdefghij');
  });

  it('strips leading/trailing whitespace', () => {
    expect(sanitizeFilename('  hello.md  ')).toBe('hello.md');
  });

  it('collapses consecutive spaces', () => {
    expect(sanitizeFilename('a    b.md')).toBe('a b.md');
  });

  it('strips trailing whitespace from stem', () => {
    expect(sanitizeFilename('hello   .md')).toBe('hello.md');
  });

  it('handles empty extension', () => {
    expect(sanitizeFilename('justname')).toBe('justname');
  });

  it('handles name with only forbidden chars', () => {
    // `<` → `_`, everything else deleted
    expect(sanitizeFilename('\\/:*?"<>|')).toBe('_');
  });

  it('deletes newlines', () => {
    expect(sanitizeFilename('line1\nline2\r.md')).toBe('line1line2.md');
  });
});

describe('cachedCloudName', () => {
  it('restores .note when cache domain is NOTE but path is local .md', () => {
    expect(cachedCloudName('内在世界/日记/2026/2026年8月13日.md', NoteDomain.NOTE)).toBe(
      '2026年8月13日.note',
    );
  });

  it('keeps markdown basename for MARKDOWN domain', () => {
    expect(cachedCloudName('docs/readme.md', NoteDomain.MARKDOWN)).toBe('readme.md');
  });
});

describe('mapCloudName', () => {
  it('converts .note to .md', () => {
    expect(mapCloudName('document.note')).toBe('document.md');
  });

  it('converts .clip to .md', () => {
    expect(mapCloudName('article.clip')).toBe('article.md');
  });

  it('adds .md when no extension', () => {
    expect(mapCloudName('untitled')).toBe('untitled.md');
  });

  it('preserves .md extension', () => {
    expect(mapCloudName('readme.md')).toBe('readme.md');
  });

  it('preserves other extensions', () => {
    expect(mapCloudName('data.json')).toBe('data.json');
  });

  it('sanitizes before mapping', () => {
    expect(mapCloudName('bad<name.note')).toBe('bad_name.md');
  });
});

describe('normalizeSep', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizeSep('a\\b\\c')).toBe('a/b/c');
  });

  it('leaves forward slashes unchanged', () => {
    expect(normalizeSep('a/b/c')).toBe('a/b/c');
  });
});

describe('officialAppName', () => {
  it('maps any local .md to the official-app .note name', () => {
    expect(officialAppName('2026年8月13日.md')).toBe('2026年8月13日.note');
    expect(officialAppName('readme.md')).toBe('readme.note');
  });

  it('leaves non-markdown names alone', () => {
    expect(officialAppName('2026年8月13日.note')).toBeNull();
  });
});

describe('pickPreferredCloud', () => {
  function file(id: string, name: string): CloudFile {
    return {
      id: asFileId(id),
      parentId: asDirId('root'),
      name,
      isDir: false,
      mtime: asEpochSeconds(1),
      ctime: asEpochSeconds(1),
      domain: NoteDomain.NOTE,
    };
  }

  it('infers NOTE domain from official-app names', () => {
    expect(domainFromCloudName('day.note')).toBe(NoteDomain.NOTE);
    expect(domainFromCloudName('readme.md')).toBe(NoteDomain.MARKDOWN);
  });

  it('needsOfficialNote follows domainFromCloudName plus existing NOTE domain', () => {
    expect(needsOfficialNote('day.md', '.md')).toBe(false);
    expect(needsOfficialNote('day.note', '.note')).toBe(true);
    expect(needsOfficialNote('untitled', '')).toBe(true);
    expect(needsOfficialNote('day.md', '.md', NoteDomain.NOTE)).toBe(true);
  });

  it('keeps .note when the same local path also has .md', () => {
    const keep = pickPreferredCloud(file('md', 'day.md'), file('note', 'day.note'));
    expect(keep.id).toBe('note');
    expect(keep.name).toBe('day.note');
  });
});
