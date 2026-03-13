import { describe, expect, it, afterEach } from 'vitest';
import { formatFileSize, safeLongPath } from './utils.js';

describe('formatFileSize', () => {
  it('returns bytes for values < 1024', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(500)).toBe('500 B');
    expect(formatFileSize(1023)).toBe('1023 B');
  });

  it('returns KB for values in [1024, 1024*1024)', () => {
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('returns MB for values in [1024^2, 1024^3)', () => {
    expect(formatFileSize(1048576)).toBe('1.0 MB');
    expect(formatFileSize(2621440)).toBe('2.5 MB');
  });

  it('returns GB for values >= 1024^3', () => {
    expect(formatFileSize(1073741824)).toBe('1.0 GB');
  });
});

describe('safeLongPath', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('leaves short path unchanged on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const short = 'C:\\Users\\test\\file.md';
    expect(safeLongPath(short)).toBe(short);
  });

  it('adds prefix for long path (>= 260 chars) on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const long = 'C:\\' + 'a'.repeat(257);
    expect(long.length).toBeGreaterThanOrEqual(260);
    expect(safeLongPath(long)).toBe(`\\\\?\\${long}`);
  });

  it('leaves already-prefixed path unchanged on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const prefixed = '\\\\?\\C:\\Users\\test\\file.md';
    expect(safeLongPath(prefixed)).toBe(prefixed);
  });

  it('leaves path unchanged on non-win32', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const path = '/home/user/very/long/path/' + 'a'.repeat(300);
    expect(safeLongPath(path)).toBe(path);
  });
});
