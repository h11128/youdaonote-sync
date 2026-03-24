import { describe, expect, it } from 'vitest';
import { detectFileType, convertToMarkdown, assertNoRawStructuredContent } from './download.js';

const enc = (s: string) => new TextEncoder().encode(s);

const XML_PREFIX = '<?xml version="1.0"?><note/>';
const JSON_PREFIX = '{"2":"1","5":[{"3":"abc"}]}';
const HTML_DOCTYPE = '<!DOCTYPE html><html><body>hi</body></html>';
const HTML_TAG = '<html><head></head><body>hi</body></html>';
const MD_TEXT = '# Hello world\n\nSome paragraph.';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const EMPTY = new Uint8Array();

describe('detectFileType', () => {
  const cases: { name: string; data: Uint8Array; ext: string; expected: string }[] = [
    { name: 'empty .md', data: EMPTY, ext: '.md', expected: 'markdown' },
    { name: 'markdown text .md', data: enc(MD_TEXT), ext: '.md', expected: 'markdown' },
    { name: 'JSON content .md', data: enc(JSON_PREFIX), ext: '.md', expected: 'json' },
    { name: 'XML content .md', data: enc(XML_PREFIX), ext: '.md', expected: 'xml' },
    { name: 'HTML doctype .md', data: enc(HTML_DOCTYPE), ext: '.md', expected: 'html' },
    { name: 'HTML tag .md', data: enc(HTML_TAG), ext: '.md', expected: 'html' },
    { name: 'binary .md', data: PNG_BYTES, ext: '.md', expected: 'markdown' },

    { name: 'JSON content .note', data: enc(JSON_PREFIX), ext: '.note', expected: 'json' },
    { name: 'XML content .note', data: enc(XML_PREFIX), ext: '.note', expected: 'xml' },
    { name: 'HTML doctype .note', data: enc(HTML_DOCTYPE), ext: '.note', expected: 'html' },
    { name: 'binary .note', data: PNG_BYTES, ext: '.note', expected: 'binary' },

    { name: 'JSON content .clip', data: enc(JSON_PREFIX), ext: '.clip', expected: 'json' },
    { name: 'XML content .clip', data: enc(XML_PREFIX), ext: '.clip', expected: 'xml' },

    { name: 'binary .png', data: PNG_BYTES, ext: '.png', expected: 'binary' },
    { name: 'empty .note', data: EMPTY, ext: '.note', expected: 'binary' },

    {
      name: 'HTML with whitespace .note',
      data: enc('  \n<!DOCTYPE html><html>'),
      ext: '.note',
      expected: 'html',
    },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.expected}`, () => {
      expect(detectFileType(c.data, c.ext)).toBe(c.expected);
    });
  }
});

describe('convertToMarkdown', () => {
  it('returns content as-is for markdown', () => {
    const data = new TextEncoder().encode('# Hello');
    expect(convertToMarkdown(data, 'markdown')).toBe('# Hello');
  });

  it('returns null for binary', () => {
    expect(convertToMarkdown(new Uint8Array(), 'binary')).toBeNull();
  });

  it('converts HTML to markdown', () => {
    const data = new TextEncoder().encode('<h1>Title</h1><p>Hello <strong>world</strong></p>');
    const result = convertToMarkdown(data, 'html');
    expect(result).toContain('# Title');
    expect(result).toContain('**world**');
  });
});

describe('assertNoRawStructuredContent', () => {
  it('passes for normal markdown content in .md file', () => {
    expect(() => {
      assertNoRawStructuredContent('.md', '# Hello\n\nworld', 'markdown');
    }).not.toThrow();
  });

  it('passes for non-.md extensions regardless of content', () => {
    expect(() => {
      assertNoRawStructuredContent('.note', '{"bad":"json"}', 'json');
    }).not.toThrow();
  });

  it('passes for null content (binary)', () => {
    expect(() => {
      assertNoRawStructuredContent('.md', null, 'binary');
    }).not.toThrow();
  });

  it('throws if .md file contains raw JSON after conversion', () => {
    expect(() => {
      assertNoRawStructuredContent('.md', '{"2":"1","5":[]}', 'markdown');
    }).toThrow(/sanity check failed.*JSON/);
  });

  it('throws if .md file contains raw XML after conversion', () => {
    expect(() => {
      assertNoRawStructuredContent('.md', '<?xml version="1.0"?>', 'markdown');
    }).toThrow(/sanity check failed.*XML/);
  });
});
