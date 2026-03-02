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
});

describe('convertToMarkdown', () => {
  it('returns content as-is for markdown', () => {
    const data = new TextEncoder().encode('# Hello');
    expect(convertToMarkdown(data, 'markdown')).toBe('# Hello');
  });

  it('returns null for binary', () => {
    expect(convertToMarkdown(new Uint8Array(), 'binary')).toBeNull();
  });
});
