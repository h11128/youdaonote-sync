import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateImages, downloadAsset } from './images.js';

describe('downloadAsset', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'img-test-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('saves fetched content and returns absolute path', async () => {
    const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(imageData.buffer),
      }),
    );

    const result = await downloadAsset(
      'https://note.youdao.com/yws/res/12345/photo.png',
      join(tmpDir, 'images'),
      { Cookie: 'x=1' },
    );

    expect(result).not.toBeNull();
    expect(result).toContain('photo.png');
  });

  it('returns null on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    const result = await downloadAsset('https://note.youdao.com/bad', tmpDir, {});
    expect(result).toBeNull();
  });

  it('returns null on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const result = await downloadAsset('https://note.youdao.com/404', tmpDir, {});
    expect(result).toBeNull();
  });
});

describe('migrateImages: relative path output', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'migrate-test-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('rewrites youdao image URLs to relative paths', async () => {
    const imageData = new Uint8Array([0xff, 0xd8]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(imageData.buffer),
      }),
    );

    const mdPath = join(tmpDir, 'diary', 'note.md');
    mkdirSync(join(tmpDir, 'diary'), { recursive: true });
    writeFileSync(mdPath, '![img](https://note.youdao.com/yws/res/123/photo.jpg)\n');

    const count = await migrateImages(
      mdPath,
      join(tmpDir, 'diary', 'images'),
      join(tmpDir, 'diary', 'attachments'),
      { Cookie: 'c=1' },
    );

    expect(count).toBe(1);
    const content = readFileSync(mdPath, 'utf-8');
    expect(content).toContain('images/photo.jpg');
    expect(content).not.toContain('note.youdao.com');
    expect(content).not.toContain(tmpDir.replace(/\\/g, '/'));
  });

  it('rewrites attachment URLs to relative paths', async () => {
    const attachData = new Uint8Array([0x50, 0x4b]);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(attachData.buffer),
      }),
    );

    const mdPath = join(tmpDir, 'doc.md');
    writeFileSync(mdPath, '[report](https://note.youdao.com/yws/res/456/report.pdf)\n');

    const count = await migrateImages(mdPath, join(tmpDir, 'images'), join(tmpDir, 'attachments'), {
      Cookie: 'c=1',
    });

    expect(count).toBe(1);
    const content = readFileSync(mdPath, 'utf-8');
    expect(content).toContain('attachments/report.pdf');
    expect(content).not.toContain('note.youdao.com');
  });

  it('returns 0 for file with no youdao URLs', async () => {
    const mdPath = join(tmpDir, 'plain.md');
    writeFileSync(mdPath, '# Just text\nNo images here.');

    const count = await migrateImages(mdPath, join(tmpDir, 'images'), join(tmpDir, 'att'), {});
    expect(count).toBe(0);
  });

  it('returns 0 for nonexistent file', async () => {
    const count = await migrateImages(
      join(tmpDir, 'nope.md'),
      join(tmpDir, 'images'),
      join(tmpDir, 'att'),
      {},
    );
    expect(count).toBe(0);
  });
});
