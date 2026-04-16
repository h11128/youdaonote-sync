import { describe, expect, it } from 'vitest';
import { jsonBytesToMarkdown } from './json-to-md.js';

function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

describe('jsonBytesToMarkdown — text and formatting', () => {
  it('converts plain text paragraph', () => {
    const data = encode({
      '5': [{ '5': [{ '7': [{ '8': 'Hello world' }] }] }],
    });
    expect(jsonBytesToMarkdown(data)).toBe('Hello world');
  });

  it('converts heading', () => {
    const data = encode({
      '5': [
        {
          '4': { l: 'h2' },
          '5': [{ '7': [{ '8': 'My Title' }] }],
          '6': 'h',
        },
      ],
    });
    expect(jsonBytesToMarkdown(data)).toBe('## My Title');
  });

  it('converts bold text', () => {
    const data = encode({
      '5': [
        {
          '5': [
            {
              '7': [{ '8': 'bold', '9': [{ '2': 'b' }] }],
            },
          ],
        },
      ],
    });
    expect(jsonBytesToMarkdown(data)).toBe('**bold**');
  });

  it('converts italic text', () => {
    const data = encode({
      '5': [
        {
          '5': [
            {
              '7': [{ '8': 'hello', '9': [{ '2': 'i' }] }],
            },
          ],
        },
      ],
    });
    expect(jsonBytesToMarkdown(data)).toBe('*hello*');
  });

  it('converts unordered list', () => {
    const data = encode({
      '5': [
        {
          '4': { lt: 'unordered', ll: 1 },
          '5': [{ '7': [{ '8': 'item1' }] }],
          '6': 'l',
        },
      ],
    });
    expect(jsonBytesToMarkdown(data)).toBe('- item1');
  });

  it('converts ordered list', () => {
    const data = encode({
      '5': [
        {
          '4': { lt: 'ordered', ll: 1 },
          '5': [{ '7': [{ '8': 'item1' }] }],
          '6': 'l',
        },
      ],
    });
    expect(jsonBytesToMarkdown(data)).toBe('1. item1');
  });
});

describe('jsonBytesToMarkdown — structural elements', () => {
  it('converts quote / blockquote', () => {
    const data = encode({
      '5': [
        {
          '5': [{ '5': [{ '7': [{ '8': 'quoted' }] }] }],
          '6': 'q',
        },
      ],
    });
    expect(jsonBytesToMarkdown(data)).toBe('> quoted\n');
  });

  it('converts highlight block', () => {
    const data = encode({
      '5': [
        {
          '5': [{ '5': [{ '7': [{ '8': 'highlighted' }] }] }],
          '6': 'la',
        },
      ],
    });
    expect(jsonBytesToMarkdown(data)).toContain('```');
    expect(jsonBytesToMarkdown(data)).toContain('highlighted');
  });

  it('converts table with separator row', () => {
    const data = encode({
      '5': [
        {
          '5': [
            {
              '5': [
                { '5': [{ '5': [{ '7': [{ '8': 'A' }] }] }] },
                { '5': [{ '5': [{ '7': [{ '8': 'B' }] }] }] },
              ],
            },
            {
              '5': [
                { '5': [{ '5': [{ '7': [{ '8': '1' }] }] }] },
                { '5': [{ '5': [{ '7': [{ '8': '2' }] }] }] },
              ],
            },
          ],
          '6': 't',
        },
      ],
    });
    const result = jsonBytesToMarkdown(data);
    expect(result).toContain('| A | B |');
    expect(result).toContain('| -- | -- |');
    expect(result).toContain('| 1 | 2 |');
  });
});

describe('jsonBytesToMarkdown — links, images, code', () => {
  it('converts text with link (li with hf)', () => {
    const data = encode({
      '5': [
        {
          '5': [
            {
              '4': { hf: 'https://example.com' },
              '5': [{ '7': [{ '8': 'Example' }] }],
              '6': 'li',
            },
          ],
        },
      ],
    });
    expect(jsonBytesToMarkdown(data)).toBe('[Example](https://example.com)');
  });

  it('converts image', () => {
    const data = encode({
      '5': [{ '4': { u: 'https://img.com/pic.png' }, '6': 'im' }],
    });
    expect(jsonBytesToMarkdown(data)).toBe('![](https://img.com/pic.png)');
  });

  it('converts code block', () => {
    const data = encode({
      '5': [
        {
          '4': { la: 'python' },
          '5': [{ '5': [{ '7': [{ '8': 'print(1)' }] }] }],
          '6': 'cd',
        },
      ],
    });
    expect(jsonBytesToMarkdown(data)).toContain('```python');
    expect(jsonBytesToMarkdown(data)).toContain('print(1)');
  });

  it('returns empty for invalid JSON', () => {
    expect(jsonBytesToMarkdown(new TextEncoder().encode('not json'))).toBe('');
  });

  it('returns empty for missing children', () => {
    expect(jsonBytesToMarkdown(encode({ '2': '1' }))).toBe('');
  });
});

describe('jsonBytesToMarkdown — diagram blocks', () => {
  it('converts Mermaid diagram to mermaid code fence', () => {
    const data = encode({
      '5': [
        {
          '4': { la: 'Mermaid' },
          '5': [
            { '5': [{ '7': [{ '8': 'graph LR' }] }], '6': 'cl' },
            { '5': [{ '7': [{ '8': '  A --> B' }] }], '6': 'cl' },
          ],
          '6': 'diagram',
        },
      ],
    });
    const result = jsonBytesToMarkdown(data);
    expect(result).toContain('```mermaid');
    expect(result).toContain('graph LR');
    expect(result).toContain('  A --> B');
    expect(result).toContain('```');
  });

  it('converts PlantUML diagram to plantuml code fence', () => {
    const data = encode({
      '5': [
        {
          '4': { la: 'PlantUML' },
          '5': [
            { '5': [{ '7': [{ '8': '@startuml' }] }], '6': 'cl' },
            { '5': [{ '7': [{ '8': 'A -> B' }] }], '6': 'cl' },
            { '5': [{ '7': [{ '8': '@enduml' }] }], '6': 'cl' },
          ],
          '6': 'diagram',
        },
      ],
    });
    const result = jsonBytesToMarkdown(data);
    expect(result).toContain('```plantuml');
    expect(result).toContain('@startuml');
    expect(result).toContain('A -> B');
  });

  it('unknown diagram language defaults to plantuml', () => {
    const data = encode({
      '5': [
        {
          '4': { la: 'SomeOther' },
          '5': [{ '5': [{ '7': [{ '8': 'content' }] }], '6': 'cl' }],
          '6': 'diagram',
        },
      ],
    });
    const result = jsonBytesToMarkdown(data);
    expect(result).toContain('```plantuml');
  });
});

describe('jsonBytesToMarkdown — multi-children blocks', () => {
  it('heading with link child reads all children', () => {
    const data = encode({
      '5': [
        {
          '4': { l: 'h2' },
          '5': [
            {
              '4': { hf: 'https://example.com' },
              '5': [{ '7': [{ '8': 'Title' }] }],
              '6': 'li',
            },
          ],
          '6': 'h',
        },
      ],
    });
    expect(jsonBytesToMarkdown(data)).toBe('## [Title](https://example.com)');
  });

  it('heading with bold span and link child', () => {
    const data = encode({
      '5': [
        {
          '4': { l: 'h2' },
          '5': [
            { '7': [{ '8': 'See ', '9': [{ '2': 'b' }] }] },
            {
              '4': { hf: 'https://x.com' },
              '5': [{ '7': [{ '8': 'here' }] }],
              '6': 'li',
            },
          ],
          '6': 'h',
        },
      ],
    });
    expect(jsonBytesToMarkdown(data)).toBe('## **See **[here](https://x.com)');
  });

  it('list with link child reads all children', () => {
    const data = encode({
      '5': [
        {
          '4': { lt: 'unordered', ll: 1 },
          '5': [
            { '7': [{ '8': 'see ' }] },
            {
              '4': { hf: 'https://d.com' },
              '5': [{ '7': [{ '8': 'docs' }] }],
              '6': 'li',
            },
            { '7': [{ '8': ' here' }] },
          ],
          '6': 'l',
        },
      ],
    });
    expect(jsonBytesToMarkdown(data)).toBe('- see [docs](https://d.com) here');
  });
});

describe('jsonBytesToMarkdown — list separators and indent', () => {
  it('consecutive list items use single newline separator', () => {
    const data = encode({
      '5': [
        {
          '4': { lt: 'unordered', ll: 1 },
          '5': [{ '7': [{ '8': 'a' }] }],
          '6': 'l',
        },
        {
          '4': { lt: 'unordered', ll: 1 },
          '5': [{ '7': [{ '8': 'b' }] }],
          '6': 'l',
        },
      ],
    });
    expect(jsonBytesToMarkdown(data)).toBe('- a\n- b');
  });

  it('nested list uses 2-space indent', () => {
    const data = encode({
      '5': [
        {
          '4': { lt: 'unordered', ll: 1 },
          '5': [{ '7': [{ '8': 'top' }] }],
          '6': 'l',
        },
        {
          '4': { lt: 'unordered', ll: 2 },
          '5': [{ '7': [{ '8': 'nested' }] }],
          '6': 'l',
        },
      ],
    });
    expect(jsonBytesToMarkdown(data)).toBe('- top\n  - nested');
  });
});
