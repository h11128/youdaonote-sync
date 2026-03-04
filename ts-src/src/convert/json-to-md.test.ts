import { describe, expect, it } from 'vitest';
import { jsonBytesToMarkdown } from './json-to-md.js';

function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

describe('jsonBytesToMarkdown', () => {
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
