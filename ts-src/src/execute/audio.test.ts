import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isAudioNoteJson,
  parseAudioNoteJson,
  audioMediaDir,
  isAudioMediaDirName,
  downloadAudioRecords,
} from './audio.js';
import { detectFileType, convertToMarkdown } from './download.js';
import type { YoudaoNoteApi } from '../api/client.js';

const enc = (s: string) => new TextEncoder().encode(s);

const AUDIO_NOTE = {
  version: '2.0',
  recordList: [
    {
      noteID: 'note1',
      recordID: 'recaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      recordSize: 4,
      recordTextContent: 'hello',
    },
    {
      noteID: 'note1',
      recordID: 'recbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      recordSize: 4,
      recordTextContent: 'world',
    },
  ],
};

describe('isAudioNoteJson', () => {
  it('detects recordList voice notes', () => {
    expect(isAudioNoteJson(enc(JSON.stringify(AUDIO_NOTE)))).toBe(true);
  });

  it('rejects rich-note JSON', () => {
    expect(isAudioNoteJson(enc('{"2":"1","5":[{"3":"abc"}]}'))).toBe(false);
  });

  it('rejects non-json', () => {
    expect(isAudioNoteJson(enc('# markdown'))).toBe(false);
  });
});

describe('detectFileType for audio notes', () => {
  it('keeps .audio / recordList JSON as binary (not json→md)', () => {
    const data = enc(JSON.stringify(AUDIO_NOTE));
    expect(detectFileType(data, '.audio')).toBe('binary');
    expect(detectFileType(data, '.md')).toBe('binary');
    expect(convertToMarkdown(data, 'binary')).toBeNull();
  });

  it('still maps rich-note JSON to json', () => {
    expect(detectFileType(enc('{"2":"1","5":[]}'), '.note')).toBe('json');
  });
});

describe('audioMediaDir', () => {
  it('maps foo.audio → foo.media', () => {
    expect(audioMediaDir('/tmp/foo.audio')).toBe('/tmp/foo.media');
    expect(isAudioMediaDirName('foo.media')).toBe(true);
    expect(isAudioMediaDirName('attachments')).toBe(false);
  });
});

describe('downloadAudioRecords', () => {
  it('downloads each recordID via getFileById(convert:false)', async () => {
    const dir = join(tmpdir(), `yd-audio-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const audioPath = join(dir, 'clip.audio');
    const json = JSON.stringify(AUDIO_NOTE);
    writeFileSync(audioPath, json);

    const aacHdr = new Uint8Array([0xff, 0xf1, 0x50, 0x80]);
    const getFileById = vi.fn((_id: string) => {
      const copy = new Uint8Array(aacHdr);
      return Promise.resolve(copy.buffer);
    });
    const api = { getFileById } as unknown as YoudaoNoteApi;

    const n = await downloadAudioRecords(audioPath, api);
    expect(n).toBe(2);
    expect(getFileById).toHaveBeenCalled();
    const firstCall = getFileById.mock.calls[0] as unknown as [string, { convert: boolean }];
    expect(firstCall[1]).toEqual({ convert: false });

    const media = audioMediaDir(audioPath);
    const files = readdirSync(media).sort();
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^000-recaaa.*\.aac$/);
    expect(readFileSync(join(media, files[0]!)).length).toBe(4);

    // metadata preserved
    expect(parseAudioNoteJson(enc(readFileSync(audioPath, 'utf-8')))?.recordList).toHaveLength(2);

    rmSync(dir, { recursive: true, force: true });
  });

  it('skips existing clips with matching recordSize', async () => {
    const dir = join(tmpdir(), `yd-audio-skip-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const audioPath = join(dir, 'clip.audio');
    writeFileSync(audioPath, JSON.stringify(AUDIO_NOTE));
    const media = audioMediaDir(audioPath);
    mkdirSync(media, { recursive: true });
    writeFileSync(join(media, '000-recaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.aac'), new Uint8Array(4));
    writeFileSync(join(media, '001-recbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.aac'), new Uint8Array(4));

    const getFileById = vi.fn();
    const api = { getFileById } as unknown as YoudaoNoteApi;
    const n = await downloadAudioRecords(audioPath, api);
    expect(n).toBe(0);
    expect(getFileById).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips empty recordID without calling API', async () => {
    const dir = join(tmpdir(), `yd-audio-emptyid-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const audioPath = join(dir, 'clip.audio');
    writeFileSync(
      audioPath,
      JSON.stringify({ version: '2.0', recordList: [{ recordID: '  ', recordSize: 1 }] }),
    );
    const getFileById = vi.fn();
    const api = { getFileById } as unknown as YoudaoNoteApi;
    const n = await downloadAudioRecords(audioPath, api);
    expect(n).toBe(0);
    expect(getFileById).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it('replaces orphan .bin when re-downloading as .aac', async () => {
    const dir = join(tmpdir(), `yd-audio-orphan-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const audioPath = join(dir, 'clip.audio');
    const note = {
      version: '2.0',
      recordList: [{ recordID: 'recaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', recordSize: 99 }],
    };
    writeFileSync(audioPath, JSON.stringify(note));
    const media = audioMediaDir(audioPath);
    mkdirSync(media, { recursive: true });
    writeFileSync(join(media, '000-recaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bin'), new Uint8Array(2));

    const aacHdr = new Uint8Array([0xff, 0xf1, 0x50, 0x80]);
    const getFileById = vi.fn(() => Promise.resolve(new Uint8Array(aacHdr).buffer));
    const api = { getFileById } as unknown as YoudaoNoteApi;
    await downloadAudioRecords(audioPath, api);
    const files = readdirSync(media);
    expect(files).toEqual(['000-recaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.aac']);
    rmSync(dir, { recursive: true, force: true });
  });
});
