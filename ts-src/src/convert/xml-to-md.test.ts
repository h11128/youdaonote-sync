import { describe, expect, it } from 'vitest';
import { xmlBytesToMarkdown } from './xml-to-md.js';

const NS = 'http://note.youdao.com';

function xml(body: string, listDefs = '<list></list>'): string {
  return `<?xml version="1.0" encoding="UTF-8"?><note xmlns="${NS}">${listDefs}<body>${body}</body></note>`;
}

describe('xmlBytesToMarkdown — basic elements', () => {
  it('converts plain paragraph', () => {
    const input = xml('<para><text>Hello world</text></para>');
    expect(xmlBytesToMarkdown(Buffer.from(input))).toContain('Hello world');
  });

  it('converts headings with level', () => {
    const input = xml('<heading level="2"><text>Title</text></heading>');
    const result = xmlBytesToMarkdown(Buffer.from(input));
    expect(result).toContain('## Title');
  });

  it('converts code block with language', () => {
    const input = xml('<code><text>const x = 1;</text><language>javascript</language></code>');
    const result = xmlBytesToMarkdown(Buffer.from(input));
    expect(result).toContain('```javascript');
    expect(result).toContain('const x = 1;');
  });

  it('converts todo item', () => {
    const input = xml('<todo><text>Buy milk</text></todo>');
    expect(xmlBytesToMarkdown(Buffer.from(input))).toContain('- [ ] Buy milk');
  });

  it('converts quote', () => {
    const input = xml('<quote><text>Famous words</text></quote>');
    expect(xmlBytesToMarkdown(Buffer.from(input))).toContain('> Famous words');
  });

  it('converts horizontal line', () => {
    const input = xml('<horizontal-line></horizontal-line>');
    expect(xmlBytesToMarkdown(Buffer.from(input))).toContain('---');
  });

  it('converts image with source', () => {
    const input = xml(
      '<image><text>alt text</text><source>https://example.com/img.png</source></image>',
    );
    const result = xmlBytesToMarkdown(Buffer.from(input));
    expect(result).toContain('![alt text](https://example.com/img.png)');
  });

  it('converts attachment', () => {
    const input = xml(
      '<attach><filename>doc.pdf</filename><resource>https://example.com/doc.pdf</resource></attach>',
    );
    const result = xmlBytesToMarkdown(Buffer.from(input));
    expect(result).toContain('[doc.pdf](https://example.com/doc.pdf)');
  });

  it('passes para text through unescaped (same as Python)', () => {
    const input = xml('<para><text>**bold** #heading</text></para>');
    const result = xmlBytesToMarkdown(Buffer.from(input));
    expect(result).toContain('**bold** #heading');
  });
});

describe('xmlBytesToMarkdown — lists and tables', () => {
  it('converts list item (unordered)', () => {
    const listDefs = '<list><list id="l1" type="unordered"/></list>';
    const input = xml('<list_item list-id="l1"><text>item text</text></list_item>', listDefs);
    expect(xmlBytesToMarkdown(Buffer.from(input))).toContain('- item text');
  });

  it('converts list item (ordered)', () => {
    const listDefs = '<list><list id="l2" type="ordered"/></list>';
    const input = xml('<list_item list-id="l2"><text>first item</text></list_item>', listDefs);
    expect(xmlBytesToMarkdown(Buffer.from(input))).toContain('1. first item');
  });

  it('converts table with JSON content', () => {
    const tableJson = JSON.stringify({
      widths: [1, 1],
      cells: [{ value: 'A' }, { value: 'B' }, { value: '1' }, { value: '2' }],
    });
    const input = xml(`<table><content>${tableJson}</content></table>`);
    const result = xmlBytesToMarkdown(Buffer.from(input));
    expect(result).toContain('| A | B |');
    expect(result).toContain('| - | - |');
    expect(result).toContain('| 1 | 2 |');
  });

  it('escapes special chars in table cells (encodeMd)', () => {
    const tableJson = JSON.stringify({
      widths: [1],
      cells: [{ value: 'a*b_c#d<e>f&g' }],
    });
    const input = xml(`<table><content><![CDATA[${tableJson}]]></content></table>`);
    const result = xmlBytesToMarkdown(Buffer.from(input));
    expect(result).toContain('a\\*b\\_c\\#d&lt;e&gt;f&amp;g');
  });

  it('handles empty body', () => {
    const input = xml('');
    const result = xmlBytesToMarkdown(Buffer.from(input));
    expect(result).toBe('');
  });

  it('handles Uint8Array input', () => {
    const input = xml('<para><text>test</text></para>');
    const result = xmlBytesToMarkdown(new TextEncoder().encode(input));
    expect(result).toContain('test');
  });
});
