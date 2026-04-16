import { describe, expect, it } from 'vitest';
import { markdownToNoteJson } from './md-to-note.js';
import { jsonBytesToMarkdown } from './json-to-md.js';

type N = Record<string, unknown>;

function parse(md: string): N {
  return JSON.parse(markdownToNoteJson(md)) as N;
}

function blocks(md: string): N[] {
  return (parse(md)['5'] as N[] | undefined) ?? [];
}

function firstBlock(md: string): N {
  return blocks(md)[0]!;
}

function getSpans(block: N): N[] {
  const children = block['5'] as N[] | undefined;
  if (!children?.length) return [];
  const first = children[0]!;
  return (first['7'] as N[] | undefined) ?? [];
}

function getAllChildren(block: N): N[] {
  return (block['5'] as N[] | undefined) ?? [];
}

describe('markdownToNoteJson — structure', () => {
  it('produces valid JSON', () => {
    const parsed = parse('Hello world');
    expect(parsed['2']).toBe('1');
    expect(parsed['5']).toBeInstanceOf(Array);
    expect((parsed['5'] as N[]).length).toBeGreaterThan(0);
  });

  it('handles headings', () => {
    const first = firstBlock('## My Heading');
    expect(first['6']).toBe('h');
    expect((first['4'] as N).l).toBe('h2');
  });

  it('handles code blocks', () => {
    const all = blocks('```python\nprint(1)\n```');
    const codeBlock = all.find((e) => e['6'] === 'cd');
    expect(codeBlock).toBeDefined();
    expect((codeBlock!['4'] as N).la).toBe('python');
  });

  it('handles mermaid as diagram node (converted to PlantUML)', () => {
    const all = blocks('```mermaid\ngraph LR\n  A --> B\n```');
    const diagram = all.find((e) => e['6'] === 'diagram');
    expect(diagram).toBeDefined();
    expect((diagram!['4'] as N).la).toBe('PlantUML');
    expect(all.find((e) => e['6'] === 'cd')).toBeUndefined();
  });

  it('handles plantuml as diagram node', () => {
    const all = blocks('```plantuml\n@startuml\nA -> B\n@enduml\n```');
    const diagram = all.find((e) => e['6'] === 'diagram');
    expect(diagram).toBeDefined();
    expect((diagram!['4'] as N).la).toBe('PlantUML');
  });

  it('diagram children use "cl" type', () => {
    const all = blocks('```mermaid\ngraph LR\n```');
    const diagram = all.find((e) => e['6'] === 'diagram');
    expect(diagram).toBeDefined();
    const children = diagram?.['5'] as N[] | undefined;
    expect(children?.length).toBeGreaterThan(0);
    expect(children?.[0]?.['6']).toBe('cl');
  });

  it('handles unordered lists', () => {
    const first = firstBlock('- item one');
    expect(first['6']).toBe('l');
    expect((first['4'] as N).lt).toBe('unordered');
  });

  it('handles ordered lists', () => {
    const first = firstBlock('1. first item');
    expect(first['6']).toBe('l');
    expect((first['4'] as N).lt).toBe('ordered');
  });

  it('handles multi-line quotes', () => {
    const all = blocks('> line 1\n> line 2');
    const quote = all.find((e) => e['6'] === 'q');
    expect(quote).toBeDefined();
  });

  it('handles images', () => {
    const all = blocks('![alt](https://img.com/pic.png)');
    const img = all.find((e) => e['6'] === 'im');
    expect(img).toBeDefined();
    expect((img!['4'] as N).u).toBe('https://img.com/pic.png');
  });

  it('handles tables', () => {
    const all = blocks('| A | B |\n| -- | -- |\n| 1 | 2 |');
    const table = all.find((e) => e['6'] === 't');
    expect(table).toBeDefined();
    const rows = (table!['5'] as N[] | undefined) ?? [];
    expect(rows).toHaveLength(2);
  });

  it('skips blank lines (no empty paragraphs)', () => {
    const all = blocks('Line one\n\nLine two');
    expect(all).toHaveLength(2);
  });
});

describe('markdownToNoteJson — inline formatting', () => {
  it('bold text produces span with "9":[{"2":"b"}]', () => {
    const spans = getSpans(firstBlock('**bold text**'));
    expect(spans).toHaveLength(1);
    expect(spans[0]!['8']).toBe('bold text');
    expect(spans[0]!['9']).toEqual([{ '2': 'b' }]);
  });

  it('italic text produces span with "9":[{"2":"i"}]', () => {
    const spans = getSpans(firstBlock('*italic*'));
    expect(spans).toHaveLength(1);
    expect(spans[0]!['8']).toBe('italic');
    expect(spans[0]!['9']).toEqual([{ '2': 'i' }]);
  });

  it('bold+italic produces span with both attrs', () => {
    const spans = getSpans(firstBlock('***bold italic***'));
    expect(spans).toHaveLength(1);
    expect(spans[0]!['8']).toBe('bold italic');
    expect(spans[0]!['9']).toEqual([{ '2': 'b' }, { '2': 'i' }]);
  });

  it('mixed plain and bold splits into multiple spans', () => {
    const spans = getSpans(firstBlock('hello **world** end'));
    expect(spans).toHaveLength(3);
    expect(spans[0]!['8']).toBe('hello ');
    expect(spans[0]!['9']).toBeUndefined();
    expect(spans[1]!['8']).toBe('world');
    expect(spans[1]!['9']).toEqual([{ '2': 'b' }]);
    expect(spans[2]!['8']).toBe(' end');
    expect(spans[2]!['9']).toBeUndefined();
  });

  it('inline code backticks are preserved as literal text', () => {
    const spans = getSpans(firstBlock('use `foo()` here'));
    expect(spans).toHaveLength(1);
    expect(spans[0]!['8']).toBe('use `foo()` here');
  });

  it('link produces "6":"li" child with "4":{"hf":url}', () => {
    const children = getAllChildren(firstBlock('[Example](https://example.com)'));
    const link = children.find((c) => c['6'] === 'li');
    expect(link).toBeDefined();
    expect((link!['4'] as N).hf).toBe('https://example.com');
    const linkSpans = ((link!['5'] as N[])[0]!['7'] as N[] | undefined) ?? [];
    expect(linkSpans[0]!['8']).toBe('Example');
  });

  it('mixed text with link splits into span-line and link-child', () => {
    const children = getAllChildren(firstBlock('see [docs](https://d.com) now'));
    expect(children.length).toBe(3);
    const spanLine = children[0]!;
    expect((spanLine['7'] as N[])[0]!['8']).toBe('see ');
    const link = children[1]!;
    expect(link['6']).toBe('li');
    const trailing = children[2]!;
    expect((trailing['7'] as N[])[0]!['8']).toBe(' now');
  });
});

describe('markdownToNoteJson — inline in block elements', () => {
  it('heading with bold: # **title** -> h block with bold span', () => {
    const block = firstBlock('# **Sleep Quality**');
    expect(block['6']).toBe('h');
    const children = getAllChildren(block);
    const spanLine = children.find((c) => c['7']);
    const spans = (spanLine?.['7'] as N[] | undefined) ?? [];
    expect(spans).toHaveLength(1);
    expect(spans[0]!['8']).toBe('Sleep Quality');
    expect(spans[0]!['9']).toEqual([{ '2': 'b' }]);
  });

  it('list item with bold preserves formatting', () => {
    const block = firstBlock('- **important** item');
    expect(block['6']).toBe('l');
    const children = getAllChildren(block);
    const spanLine = children.find((c) => c['7']);
    const spans = (spanLine?.['7'] as N[] | undefined) ?? [];
    expect(spans.length).toBeGreaterThanOrEqual(2);
    expect(spans[0]!['8']).toBe('important');
    expect(spans[0]!['9']).toEqual([{ '2': 'b' }]);
  });

  it('quote with bold preserves formatting', () => {
    const block = firstBlock('> **quoted bold**');
    expect(block['6']).toBe('q');
    const qChildren = getAllChildren(block);
    const inner = getAllChildren(qChildren[0]!);
    const spanLine = inner.find((c) => c['7']);
    const spans = (spanLine?.['7'] as N[] | undefined) ?? [];
    expect(spans[0]!['8']).toBe('quoted bold');
    expect(spans[0]!['9']).toEqual([{ '2': 'b' }]);
  });
});

function roundtrip(md: string): string {
  const json = markdownToNoteJson(md);
  const buf = new TextEncoder().encode(json);
  return jsonBytesToMarkdown(buf);
}

describe('roundtrip: md -> note JSON -> md', () => {
  const cases = [
    { name: 'plain text', md: 'Hello world', expected: 'Hello world' },
    { name: 'bold text', md: '**bold**', expected: '**bold**' },
    { name: 'italic text', md: '*italic*', expected: '*italic*' },
    { name: 'bold+italic', md: '***both***', expected: '***both***' },
    { name: 'mixed bold', md: 'hello **world** end', expected: 'hello **world** end' },
    { name: 'heading', md: '## Title', expected: '## Title' },
    { name: 'heading with bold', md: '# **Bold Title**', expected: '# **Bold Title**' },
    { name: 'link', md: '[docs](https://d.com)', expected: '[docs](https://d.com)' },
    { name: 'unordered list', md: '- item', expected: '- item' },
    { name: 'ordered list', md: '1. item', expected: '1. item' },
    { name: 'image', md: '![](https://img.com/a.png)', expected: '![](https://img.com/a.png)' },
    { name: 'inline code', md: 'use `foo()` here', expected: 'use `foo()` here' },
    {
      name: 'heading with link',
      md: '## [Title](https://example.com)',
      expected: '## [Title](https://example.com)',
    },
    {
      name: 'heading bold+link',
      md: '## **See** [here](https://x.com)',
      expected: '## **See** [here](https://x.com)',
    },
    { name: 'list with bold', md: '- **important** item', expected: '- **important** item' },
    {
      name: 'list with link',
      md: '- see [docs](https://d.com) here',
      expected: '- see [docs](https://d.com) here',
    },
    { name: 'quote with bold', md: '> **quoted bold**', expected: '> **quoted bold**' },
    {
      name: 'paragraph with link',
      md: 'See [docs](https://d.com) for details',
      expected: 'See [docs](https://d.com) for details',
    },
    {
      name: 'multi-item list',
      md: '- item 1\n- item 2\n- item 3',
      expected: '- item 1\n- item 2\n- item 3',
    },
    { name: 'nested list', md: '- level 1\n  - level 2', expected: '- level 1\n  - level 2' },
    {
      name: 'table',
      md: '| A | B |\n| -- | -- |\n| 1 | 2 |',
      expected: '| A | B |\n| -- | -- |\n| 1 | 2 |',
    },
    {
      name: '3-row table',
      md: '| H1 | H2 |\n| -- | -- |\n| A | B |\n| C | D |',
      expected: '| H1 | H2 |\n| -- | -- |\n| A | B |\n| C | D |',
    },
    { name: 'HR', md: '---', expected: '---' },
    {
      name: 'plantuml diagram',
      md: '```plantuml\n@startuml\nA -> B\n@enduml\n```',
      expected: '```plantuml\n@startuml\nA -> B\n@enduml\n```',
    },
  ];

  for (const { name, md, expected } of cases) {
    it(name, () => {
      expect(roundtrip(md).trim()).toBe(expected);
    });
  }
});
