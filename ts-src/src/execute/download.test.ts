import { describe, expect, it } from 'vitest';
import { detectFileType, convertToMarkdown } from './download.js';

describe('detectFileType', () => {
  it('returns markdown for .md extension', () => {
    expect(detectFileType(new Uint8Array(), '.md')).toBe('markdown');
  });

  it('detects XML by prefix', () => {
    const data = new TextEncoder().encode('<?xml version="1.0"?>');
    expect(detectFileType(data, '.note')).toBe('xml');
  });

  it('detects JSON by prefix', () => {
    const data = new TextEncoder().encode('{"5":[]}');
    expect(detectFileType(data, '.note')).toBe('json');
  });

  it('returns binary for unknown prefix', () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header
    expect(detectFileType(data, '.png')).toBe('binary');
  });

  it('detects HTML by <!DOCTYPE html>', () => {
    const data = new TextEncoder().encode('<!DOCTYPE html><html><body>hi</body></html>');
    expect(detectFileType(data, '.note')).toBe('html');
  });

  it('detects HTML by <html> tag', () => {
    const data = new TextEncoder().encode('<html><head></head><body>content</body></html>');
    expect(detectFileType(data, '.note')).toBe('html');
  });

  it('detects HTML with leading whitespace', () => {
    const data = new TextEncoder().encode('  \n<!DOCTYPE html><html>');
    expect(detectFileType(data, '.note')).toBe('html');
  });
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
