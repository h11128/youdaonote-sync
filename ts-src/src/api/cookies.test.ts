import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findMissingCookies,
  hasRequiredCookies,
  loadCookies,
  saveCookies,
  createFromDict,
} from './cookies.js';

const TMP = join(tmpdir(), `cookies-test-${Date.now()}`);

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('findMissingCookies', () => {
  it('returns all when none present', () => {
    expect(findMissingCookies([])).toEqual(['YNOTE_CSTK', 'YNOTE_LOGIN', 'YNOTE_SESS']);
  });

  it('returns empty when all present', () => {
    expect(findMissingCookies(['YNOTE_CSTK', 'YNOTE_LOGIN', 'YNOTE_SESS'])).toEqual([]);
  });

  it('returns only missing ones', () => {
    expect(findMissingCookies(['YNOTE_CSTK'])).toEqual(['YNOTE_LOGIN', 'YNOTE_SESS']);
  });
});

describe('hasRequiredCookies', () => {
  it('true when all present', () => {
    expect(hasRequiredCookies(['YNOTE_CSTK', 'YNOTE_LOGIN', 'YNOTE_SESS', 'EXTRA'])).toBe(true);
  });

  it('false when any missing', () => {
    expect(hasRequiredCookies(['YNOTE_CSTK', 'YNOTE_LOGIN'])).toBe(false);
  });
});

describe('loadCookies', () => {
  it('parses valid cookies.json', () => {
    const path = join(TMP, 'cookies.json');
    writeFileSync(
      path,
      JSON.stringify({
        cookies: [['YNOTE_CSTK', 'val1', '.note.youdao.com', '/']],
      }),
    );

    const { cookies, error } = loadCookies(path);
    expect(error).toBe('');
    expect(cookies).toHaveLength(1);
    expect(cookies[0]!.name).toBe('YNOTE_CSTK');
    expect(cookies[0]!.value).toBe('val1');
  });

  it('returns error for missing file', () => {
    const { cookies, error } = loadCookies(join(TMP, 'nonexistent.json'));
    expect(cookies).toHaveLength(0);
    expect(error).toContain('File not found');
  });

  it('returns error for empty cookies array', () => {
    const path = join(TMP, 'empty.json');
    writeFileSync(path, JSON.stringify({ cookies: [] }));
    const { error } = loadCookies(path);
    expect(error).toContain('no cookies');
  });

  it('skips invalid cookie entries', () => {
    const path = join(TMP, 'mixed.json');
    writeFileSync(
      path,
      JSON.stringify({
        cookies: [['valid', 'v', 'd', '/'], 'not-an-array', [1, 2]],
      }),
    );

    const { cookies } = loadCookies(path);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]!.name).toBe('valid');
  });

  it('returns error for invalid JSON', () => {
    const path = join(TMP, 'bad.json');
    writeFileSync(path, '{not json');
    const { error } = loadCookies(path);
    expect(error).toContain('Failed to load');
  });
});

describe('saveCookies', () => {
  it('saves and can be loaded back', () => {
    const path = join(TMP, 'sub', 'cookies.json');
    const cookies = [{ name: 'A', value: '1', domain: '.d', path: '/' }];
    const { ok } = saveCookies({ cookies }, path, false);
    expect(ok).toBe(true);

    const { cookies: loaded } = loadCookies(path);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.name).toBe('A');
  });
});

describe('createFromDict', () => {
  it('creates entries for all required cookies', () => {
    const { cookies } = createFromDict({ YNOTE_CSTK: 'c', YNOTE_LOGIN: 'l', YNOTE_SESS: 's' });
    expect(cookies).toHaveLength(3);
    expect(cookies.map((c) => c.name).sort()).toEqual(['YNOTE_CSTK', 'YNOTE_LOGIN', 'YNOTE_SESS']);
  });

  it('uses empty string for missing values', () => {
    const { cookies } = createFromDict({});
    expect(cookies.every((c) => c.value === '')).toBe(true);
  });
});
