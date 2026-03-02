import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { computeContentHashFromBytes, computeContentHashFromFile } from './hash.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('computeContentHashFromBytes', () => {
  it('normalizes CRLF for text files', () => {
    const crlf = new TextEncoder().encode('hello\r\nworld');
    const lf = new TextEncoder().encode('hello\nworld');
    const hashCrlf = computeContentHashFromBytes(crlf, 'test.md');
    const hashLf = computeContentHashFromBytes(lf, 'test.md');
    expect(hashCrlf).toBe(hashLf);
  });

  it('does NOT normalize CRLF for binary files', () => {
    const crlf = new TextEncoder().encode('hello\r\nworld');
    const lf = new TextEncoder().encode('hello\nworld');
    const hashCrlf = computeContentHashFromBytes(crlf, 'image.png');
    const hashLf = computeContentHashFromBytes(lf, 'image.png');
    expect(hashCrlf).not.toBe(hashLf);
  });

  it('strips BOM for text files', () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello')]);
    const noBom = new TextEncoder().encode('hello');
    const hashBom = computeContentHashFromBytes(bom, 'test.txt');
    const hashNoBom = computeContentHashFromBytes(noBom, 'test.txt');
    expect(hashBom).toBe(hashNoBom);
  });

  it('does NOT strip BOM for binary files', () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello')]);
    const noBom = new TextEncoder().encode('hello');
    const hashBom = computeContentHashFromBytes(bom, 'file.pdf');
    const hashNoBom = computeContentHashFromBytes(noBom, 'file.pdf');
    expect(hashBom).not.toBe(hashNoBom);
  });

  it('returns a non-null hex string', () => {
    const hash = computeContentHashFromBytes(new TextEncoder().encode('test'), 'file.md');
    expect(hash).not.toBeNull();
    expect(hash!).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('computeContentHashFromFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hash-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('produces same hash for CRLF and LF text files', () => {
    const crlfPath = join(tmpDir, 'crlf.md');
    const lfPath = join(tmpDir, 'lf.md');
    writeFileSync(crlfPath, 'hello\r\nworld', 'utf-8');
    writeFileSync(lfPath, 'hello\nworld', 'utf-8');

    expect(computeContentHashFromFile(crlfPath)).toBe(computeContentHashFromFile(lfPath));
  });

  it('produces different hash for CRLF and LF binary files', () => {
    const crlfPath = join(tmpDir, 'crlf.png');
    const lfPath = join(tmpDir, 'lf.png');
    writeFileSync(crlfPath, Buffer.from('hello\r\nworld'));
    writeFileSync(lfPath, Buffer.from('hello\nworld'));

    expect(computeContentHashFromFile(crlfPath)).not.toBe(computeContentHashFromFile(lfPath));
  });

  it('returns null for non-existent file', () => {
    expect(computeContentHashFromFile(join(tmpDir, 'nope.md'))).toBeNull();
  });

  it('handles empty file', () => {
    const p = join(tmpDir, 'empty.md');
    writeFileSync(p, '');
    const hash = computeContentHashFromFile(p);
    expect(hash).not.toBeNull();
  });
});
