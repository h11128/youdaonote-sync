import { describe, expect, it } from 'vitest';
import { markdownToNoteJson } from './md-to-note.js';

describe('markdownToNoteJson', () => {
  it('produces valid JSON', () => {
    const result = markdownToNoteJson('Hello world');
    const parsed = JSON.parse(result);
    expect(parsed['2']).toBe('1');
    expect(parsed['5']).toBeInstanceOf(Array);
    expect(parsed['5'].length).toBeGreaterThan(0);
  });

  it('handles headings', () => {
    const result = markdownToNoteJson('## My Heading');
    const parsed = JSON.parse(result);
    const first = parsed['5'][0];
    expect(first['6']).toBe('h');
    expect(first['4']['l']).toBe('h2');
  });

  it('handles code blocks', () => {
    const md = '```python\nprint(1)\n```';
    const result = markdownToNoteJson(md);
    const parsed = JSON.parse(result);
    const codeBlock = parsed['5'].find((e: Record<string, unknown>) => e['6'] === 'cd');
    expect(codeBlock).toBeDefined();
    expect(codeBlock['4']['la']).toBe('python');
  });

  it('handles unordered lists', () => {
    const result = markdownToNoteJson('- item one');
    const parsed = JSON.parse(result);
    const first = parsed['5'][0];
    expect(first['6']).toBe('l');
    expect(first['4']['lt']).toBe('unordered');
  });

  it('handles ordered lists', () => {
    const result = markdownToNoteJson('1. first item');
    const parsed = JSON.parse(result);
    const first = parsed['5'][0];
    expect(first['6']).toBe('l');
    expect(first['4']['lt']).toBe('ordered');
  });

  it('handles multi-line quotes', () => {
    const md = '> line 1\n> line 2';
    const result = markdownToNoteJson(md);
    const parsed = JSON.parse(result);
    const quote = parsed['5'].find((e: Record<string, unknown>) => e['6'] === 'q');
    expect(quote).toBeDefined();
  });

  it('handles images', () => {
    const result = markdownToNoteJson('![alt](https://img.com/pic.png)');
    const parsed = JSON.parse(result);
    const img = parsed['5'].find((e: Record<string, unknown>) => e['6'] === 'im');
    expect(img).toBeDefined();
    expect(img['4']['u']).toBe('https://img.com/pic.png');
  });
});
