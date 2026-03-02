import { describe, expect, it } from 'vitest';
import { sanitizeFilename, normalizeSep } from './path.js';

describe('util/path', () => {
  describe('sanitizeFilename', () => {
    it('replaces < with _', () => {
      expect(sanitizeFilename('file<name>.md')).toBe('file_name.md');
    });
    it('deletes forbidden characters', () => {
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
    it('handles only forbidden chars', () => {
      expect(sanitizeFilename('\\/:*?"<>|')).toBe('_');
    });
    it('deletes newlines', () => {
      expect(sanitizeFilename('line1\nline2\r.md')).toBe('line1line2.md');
    });
  });

  describe('normalizeSep', () => {
    it('converts backslashes to forward slashes', () => {
      expect(normalizeSep('a\\b\\c')).toBe('a/b/c');
    });
    it('leaves forward slashes unchanged', () => {
      expect(normalizeSep('a/b/c')).toBe('a/b/c');
    });
    it('handles mixed', () => {
      expect(normalizeSep('a\\b/c\\d')).toBe('a/b/c/d');
    });
  });
});
