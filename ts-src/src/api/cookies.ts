import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { platform, homedir } from 'node:os';
import { env } from 'node:process';
import { requireNonEmpty } from '../util/preconditions.js';
import { logger } from '../util/logger.js';

export interface CookieEntry {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
}

const REQUIRED_COOKIES = ['YNOTE_CSTK', 'YNOTE_LOGIN', 'YNOTE_SESS'] as const;

export function findMissingCookies(cookieNames: string[]): string[] {
  return REQUIRED_COOKIES.filter((r) => !cookieNames.includes(r));
}

export function hasRequiredCookies(cookieNames: string[]): boolean {
  return REQUIRED_COOKIES.every((r) => cookieNames.includes(r));
}

export function loadCookies(cookiesPath: string): { cookies: CookieEntry[]; error: string } {
  requireNonEmpty('cookiesPath', cookiesPath);
  try {
    const raw = readFileSync(cookiesPath, 'utf-8');
    const data = JSON.parse(raw) as { cookies?: unknown[] };
    const arr = data.cookies ?? [];

    if (arr.length === 0) {
      return { cookies: [], error: 'cookies.json has no cookies data' };
    }

    const cookies: CookieEntry[] = [];
    for (const c of arr) {
      if (Array.isArray(c) && c.length >= 4) {
        cookies.push({
          name: String(c[0]),
          value: String(c[1]),
          domain: String(c[2]),
          path: String(c[3]),
        });
      }
    }

    if (cookies.length === 0) {
      return { cookies: [], error: 'No valid cookie entries in cookies.json' };
    }

    return { cookies, error: '' };
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { cookies: [], error: `File not found: ${cookiesPath}` };
    }
    return { cookies: [], error: `Failed to load cookies: ${String(e)}` };
  }
}

export function saveCookies(
  cookiesData: { cookies: CookieEntry[] },
  cookiesPath: string,
  backup = true,
): { ok: boolean; error: string } {
  requireNonEmpty('cookiesPath', cookiesPath);
  try {
    if (backup) backupCookies(cookiesPath);
    const serialized = {
      cookies: cookiesData.cookies.map((c) => [c.name, c.value, c.domain, c.path]),
    };
    mkdirSync(dirname(cookiesPath), { recursive: true });
    writeFileSync(cookiesPath, JSON.stringify(serialized, null, 4), 'utf-8');
    return { ok: true, error: '' };
  } catch (e: unknown) {
    return { ok: false, error: `Failed to save cookies: ${String(e)}` };
  }
}

export function backupCookies(cookiesPath: string): string | null {
  if (!existsSync(cookiesPath)) return null;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    const backupsDir = join(dirname(cookiesPath), '..', 'backups');
    mkdirSync(backupsDir, { recursive: true });
    const backupPath = join(backupsDir, `cookies.json.backup.${ts}`);
    copyFileSync(cookiesPath, backupPath);
    return backupPath;
  } catch (e: unknown) {
    logger.warn(`[cookies] failed to backup ${cookiesPath}: ${String(e)}`);
    return null;
  }
}

function parseSingleCookie(c: unknown): CookieEntry | null {
  if (typeof c !== 'object' || c === null) return null;
  const obj = c as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name : '';
  const value = typeof obj.value === 'string' ? obj.value : '';
  if (!name || !value) return null;
  return {
    name,
    value,
    domain: typeof obj.domain === 'string' ? obj.domain : '.note.youdao.com',
    path: typeof obj.path === 'string' ? obj.path : '/',
  };
}

function parseDesktopCookieEntries(rawCookies: unknown[]): CookieEntry[] {
  const result: CookieEntry[] = [];
  for (const c of rawCookies) {
    const entry = parseSingleCookie(c);
    if (entry) result.push(entry);
  }
  return result;
}

function getDesktopConfigBase(): string {
  const os = platform();
  if (os === 'win32') return env.APPDATA ?? '';
  if (os === 'darwin') return join(homedir(), 'Library', 'Application Support');
  return env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
}

export function getDesktopSettingPath(): string | null {
  const base = getDesktopConfigBase();
  if (!base) return null;
  const p = join(base, 'ynote-desktop', 'setting.json');
  return existsSync(p) ? p : null;
}

export function loadFromDesktop(): { cookies: CookieEntry[]; error: string } {
  const settingPath = getDesktopSettingPath();
  if (!settingPath) {
    return { cookies: [], error: 'Youdao desktop client data not found' };
  }

  try {
    const raw = readFileSync(settingPath, 'utf-8');
    const setting = JSON.parse(raw) as { cookies?: unknown[] };
    const rawCookies = setting.cookies ?? [];

    if (rawCookies.length === 0) {
      return { cookies: [], error: 'Desktop client setting.json has no cookies' };
    }

    const result = parseDesktopCookieEntries(rawCookies);

    if (result.length === 0) {
      return { cookies: [], error: 'Desktop client cookies are empty' };
    }

    const missing = findMissingCookies(result.map((c) => c.name));
    if (missing.length > 0) {
      return { cookies: [], error: `Desktop client missing cookies: ${missing.join(', ')}` };
    }

    return { cookies: result, error: '' };
  } catch (e: unknown) {
    return { cookies: [], error: `Failed to read desktop setting.json: ${String(e)}` };
  }
}

export function createFromDict(dict: Record<string, string>): { cookies: CookieEntry[] } {
  return {
    cookies: REQUIRED_COOKIES.map((name) => ({
      name,
      value: dict[name] ?? '',
      domain: '.note.youdao.com',
      path: '/',
    })),
  };
}
