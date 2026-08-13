import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectFileType,
  convertToMarkdown,
  assertNoRawStructuredContent,
  downloadFile,
} from './download.js';
import { audioMediaDir } from './audio.js';
import type { YoudaoNoteApi } from '../api/client.js';
import { asFileId } from '../types/common.js';

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
      name: 'audio note JSON .audio → binary (preserve metadata)',
      data: enc('{"version":"2.0","recordList":[{"recordID":"abc","recordSize":1}]}'),
      ext: '.audio',
      expected: 'binary',
    },

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

describe('downloadFile voice notes', () => {
  it('saves .audio JSON and downloads clips via getFileById(convert:false)', async () => {
    const dir = join(tmpdir(), `yd-dl-audio-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const localPath = join(dir, 'voice.audio');
    const noteJson = JSON.stringify({
      version: '2.0',
      recordList: [
        { recordID: 'clipaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', recordSize: 4 },
        { recordID: 'clipbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', recordSize: 4 },
      ],
    });
    const aacHdr = new Uint8Array([0xff, 0xf1, 0x50, 0x80]);
    const getFileById = vi.fn((id: string, opts?: { convert?: boolean }) => {
      if (id === 'note-audio-1') {
        expect(opts?.convert).toBeUndefined();
        return Promise.resolve(enc(noteJson).buffer);
      }
      expect(opts).toEqual({ convert: false });
      return Promise.resolve(new Uint8Array(aacHdr).buffer);
    });
    const api = { getFileById } as unknown as YoudaoNoteApi;

    const result = await downloadFile(api, asFileId('note-audio-1'), localPath);
    expect(result.fileType).toBe('binary');
    expect(readFileSync(localPath, 'utf-8')).toBe(noteJson);
    expect(readFileSync(localPath).length).toBeGreaterThan(0);

    const clips = readdirSync(audioMediaDir(localPath)).sort();
    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatch(/^000-clipaaa.*\.aac$/);
    expect(getFileById).toHaveBeenCalledTimes(3);

    rmSync(dir, { recursive: true, force: true });
  });

  it('does not json-to-md empty an audio note (regression)', async () => {
    const dir = join(tmpdir(), `yd-dl-empty-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const localPath = join(dir, 'voice.audio');
    const noteJson =
      '{"version":"2.0","recordList":[{"recordID":"onlyonerecordidxxxxxxxxxxxxx","recordSize":4}]}';
    const getFileById = vi.fn((id: string) => {
      if (id === 'note-1') return Promise.resolve(enc(noteJson).buffer);
      return Promise.resolve(new Uint8Array([0xff, 0xf1, 0x50, 0x80]).buffer);
    });
    const api = { getFileById } as unknown as YoudaoNoteApi;

    await downloadFile(api, asFileId('note-1'), localPath);
    // Old bug: json-to-md on rich-note schema → empty string → 0-byte file
    expect(readFileSync(localPath).length).toBe(noteJson.length);
    expect(readdirSync(audioMediaDir(localPath))).toHaveLength(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it('stores null contentHash for empty download bytes', async () => {
    const dir = join(tmpdir(), `yd-dl-zerobytes-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const localPath = join(dir, 'empty.bin');
    const api = {
      getFileById: vi.fn(() => Promise.resolve(new ArrayBuffer(0))),
    } as unknown as YoudaoNoteApi;
    const emptyHash = '99aa06d3014798d86001c324468d497f';
    const hashFn = vi.fn(() => emptyHash as never);

    const result = await downloadFile(api, asFileId('empty-1'), localPath, { hashFn });

    expect(result.contentHash).toBeNull();
    expect(result.rawContentHash).toBeNull();
    expect(hashFn).not.toHaveBeenCalled();

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('downloadFile empty overwrite', () => {
  it('refuses empty download over non-empty local', async () => {
    const dir = join(tmpdir(), `yd-dl-refuse-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const localPath = join(dir, 'diary.md');
    writeFileSync(localPath, '# keep handwritten\n');
    const api = {
      getFileById: vi.fn(() => Promise.resolve(new ArrayBuffer(0))),
    } as unknown as YoudaoNoteApi;

    await expect(downloadFile(api, asFileId('empty-2'), localPath)).rejects.toThrow(
      /REFUSE: empty download/,
    );
    expect(readFileSync(localPath, 'utf-8')).toBe('# keep handwritten\n');

    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses json-to-md empty string over non-empty local', async () => {
    const dir = join(tmpdir(), `yd-dl-jsonempty-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const localPath = join(dir, 'diary.md');
    writeFileSync(localPath, '# keep handwritten\n');
    const api = {
      getFileById: vi.fn(() => Promise.resolve(enc('{"2":"1"}').buffer)),
    } as unknown as YoudaoNoteApi;

    await expect(downloadFile(api, asFileId('empty-json'), localPath)).rejects.toThrow(
      /REFUSE: empty download/,
    );
    expect(readFileSync(localPath, 'utf-8')).toBe('# keep handwritten\n');

    rmSync(dir, { recursive: true, force: true });
  });
});
