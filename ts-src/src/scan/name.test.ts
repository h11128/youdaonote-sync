import { describe, expect, it } from 'vitest';
import { sanitizeFilename, mapCloudName, normalizeSep } from './name.js';

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
