import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { env } from 'node:process';
import {
  findMissingCookies,
  hasRequiredCookies,
  loadCookies,
  saveCookies,
  createFromDict,
  backupCookies,
  loadFromDesktop,
  getDesktopSettingPath,
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

describe('backupCookies', () => {
  it('returns null when file does not exist', () => {
    const path = join(TMP, 'nonexistent.json');
    expect(backupCookies(path)).toBe(null);
  });

  it('creates backup file and returns path', () => {
    const path = join(TMP, 'sub', 'cookies.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ cookies: [['A', '1', '.d', '/']] }));

    const backupPath = backupCookies(path);

    expect(backupPath).not.toBe(null);
    expect(backupPath).toContain('cookies.json.backup.');
    expect(existsSync(backupPath!)).toBe(true);
    expect(readFileSync(backupPath!, 'utf-8')).toEqual(readFileSync(path, 'utf-8'));
  });
});

function setDesktopConfigBase(base: string): void {
  if (platform() === 'win32') {
    env.APPDATA = base;
  } else {
    env.XDG_CONFIG_HOME = base;
  }
}

describe('loadFromDesktop', () => {
  let originalAppData: string | undefined;
  let originalXdgConfig: string | undefined;

  beforeEach(() => {
    originalAppData = env.APPDATA;
    originalXdgConfig = env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    env.APPDATA = originalAppData;
    env.XDG_CONFIG_HOME = originalXdgConfig;
  });

  it('returns error when desktop client data not found', () => {
    setDesktopConfigBase(join(TMP, 'empty-appdata'));
    mkdirSync(join(TMP, 'empty-appdata'), { recursive: true });

    const { cookies, error } = loadFromDesktop();

    expect(cookies).toHaveLength(0);
    expect(error).toBe('Youdao desktop client data not found');
  });

  it('loads cookies from desktop setting.json when present', () => {
    setDesktopConfigBase(TMP);
    const desktopDir = join(TMP, 'ynote-desktop');
    mkdirSync(desktopDir, { recursive: true });
    const settingPath = join(desktopDir, 'setting.json');
    writeFileSync(
      settingPath,
      JSON.stringify({
        cookies: [
          { name: 'YNOTE_CSTK', value: 'cstk-val', domain: '.note.youdao.com', path: '/' },
          { name: 'YNOTE_LOGIN', value: 'login-val', domain: '.note.youdao.com', path: '/' },
          { name: 'YNOTE_SESS', value: 'sess-val', domain: '.note.youdao.com', path: '/' },
        ],
      }),
    );

    const { cookies, error } = loadFromDesktop();

    expect(error).toBe('');
    expect(cookies).toHaveLength(3);
    expect(cookies.map((c) => c.name).sort()).toEqual(['YNOTE_CSTK', 'YNOTE_LOGIN', 'YNOTE_SESS']);
    expect(cookies.find((c) => c.name === 'YNOTE_CSTK')!.value).toBe('cstk-val');
  });
});

describe('loadFromDesktop — error cases', () => {
  let originalAppData: string | undefined;
  let originalXdgConfig: string | undefined;

  beforeEach(() => {
    originalAppData = env.APPDATA;
    originalXdgConfig = env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    env.APPDATA = originalAppData;
    env.XDG_CONFIG_HOME = originalXdgConfig;
  });

  it('returns error when setting.json has no cookies', () => {
    setDesktopConfigBase(TMP);
    const desktopDir = join(TMP, 'ynote-desktop');
    mkdirSync(desktopDir, { recursive: true });
    writeFileSync(join(desktopDir, 'setting.json'), JSON.stringify({ cookies: [] }));

    const { cookies, error } = loadFromDesktop();

    expect(cookies).toHaveLength(0);
    expect(error).toContain('no cookies');
  });

  it('returns error when cookies are empty after parsing', () => {
    setDesktopConfigBase(TMP);
    const desktopDir = join(TMP, 'ynote-desktop');
    mkdirSync(desktopDir, { recursive: true });
    writeFileSync(
      join(desktopDir, 'setting.json'),
      JSON.stringify({
        cookies: [
          { name: '', value: 'x' },
          { name: 'y', value: '' },
        ],
      }),
    );

    const { cookies, error } = loadFromDesktop();

    expect(cookies).toHaveLength(0);
    expect(error).toContain('empty');
  });

  it('returns error when required cookies are missing', () => {
    setDesktopConfigBase(TMP);
    const desktopDir = join(TMP, 'ynote-desktop');
    mkdirSync(desktopDir, { recursive: true });
    writeFileSync(
      join(desktopDir, 'setting.json'),
      JSON.stringify({
        cookies: [{ name: 'YNOTE_CSTK', value: 'only-one', domain: '.note.youdao.com', path: '/' }],
      }),
    );

    const { cookies, error } = loadFromDesktop();

    expect(cookies).toHaveLength(0);
    expect(error).toContain('missing cookies');
    expect(error).toContain('YNOTE_LOGIN');
  });
});

describe('getDesktopSettingPath', () => {
  let originalAppData: string | undefined;
  let originalXdgConfig: string | undefined;

  beforeEach(() => {
    originalAppData = env.APPDATA;
    originalXdgConfig = env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    env.APPDATA = originalAppData;
    env.XDG_CONFIG_HOME = originalXdgConfig;
  });

  it('returns path when setting.json exists', () => {
    setDesktopConfigBase(TMP);
    const desktopDir = join(TMP, 'ynote-desktop');
    mkdirSync(desktopDir, { recursive: true });
    writeFileSync(join(desktopDir, 'setting.json'), '{}');

    const path = getDesktopSettingPath();

    expect(path).toBe(join(TMP, 'ynote-desktop', 'setting.json'));
  });

  it('returns null when setting.json does not exist', () => {
    setDesktopConfigBase(TMP);
    mkdirSync(TMP, { recursive: true });

    const path = getDesktopSettingPath();

    expect(path).toBe(null);
  });
});
