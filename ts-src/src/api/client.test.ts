import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { YoudaoNoteApi } from './client.js';
import type { CookieEntry } from './cookies.js';

vi.stubGlobal('fetch', vi.fn());

const { loadFromDesktopMock } = vi.hoisted(() => ({
  loadFromDesktopMock: vi.fn(() => ({
    cookies: [] as CookieEntry[],
    error: 'Youdao desktop client data not found',
  })),
}));

vi.mock('./cookies.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadFromDesktop: () => loadFromDesktopMock(),
  };
});

describe('YoudaoNoteApi.generateFileId', () => {
  it('returns string matching WEB[0-9a-f]{32}', () => {
    const id = YoudaoNoteApi.generateFileId();
    expect(id).toMatch(/^WEB[0-9a-f]{32}$/);
  });

  it('returns unique ids on multiple calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      ids.add(YoudaoNoteApi.generateFileId());
    }
    expect(ids.size).toBe(10);
  });
});

let tmpDir: string;
let cookiesPath: string;

const validCookies: CookieEntry[] = [
  { name: 'YNOTE_CSTK', value: 'test-cstk', domain: '.note.youdao.com', path: '/' },
  { name: 'YNOTE_LOGIN', value: 'login', domain: '.note.youdao.com', path: '/' },
  { name: 'YNOTE_SESS', value: 'sess', domain: '.note.youdao.com', path: '/' },
];

function writeCookiesFile() {
  writeFileSync(
    cookiesPath,
    JSON.stringify({
      cookies: validCookies.map((c) => [c.name, c.value, c.domain, c.path]),
    }),
  );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'client-test-'));
  cookiesPath = join(tmpDir, 'cookies.json');
  mkdirSync(tmpDir, { recursive: true });
  vi.mocked(fetch).mockReset();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('loginByCookies and getCookieHeader', () => {
  it('applies cookies and builds cookie header', () => {
    writeCookiesFile();

    const api = new YoudaoNoteApi(cookiesPath);
    const err = api.loginByCookies();

    expect(err).toBeNull();
    const header = api.getCookieHeader();
    expect(header).toContain('YNOTE_CSTK=test-cstk');
    expect(header).toContain('YNOTE_LOGIN=login');
    expect(header).toContain('YNOTE_SESS=sess');
  });

  it('returns error when cookies file missing', () => {
    const api = new YoudaoNoteApi(join(tmpDir, 'nonexistent.json'));
    const err = api.loginByCookies();

    expect(err).toBeTruthy();
    expect(err).toMatch(/Cookie load failed|Desktop|not found/i);
  });
});

describe('getRootId with mocked fetch', () => {
  it('returns root id on success', async () => {
    writeCookiesFile();
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ fileEntry: { id: 'root-dir-123' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const api = new YoudaoNoteApi(cookiesPath);
    api.loginByCookies();
    const rootId = await api.getRootId();

    expect(rootId).toBe('root-dir-123');
    expect(fetch).toHaveBeenCalled();
  });

  it('throws when not logged in', async () => {
    const api = new YoudaoNoteApi(join(tmpDir, 'nonexistent.json'));
    api.loginByCookies();

    await expect(api.getRootId()).rejects.toThrow('Not logged in');
  });
});

describe('auth retry on 401', () => {
  it('retries with refreshed cookies after 401', async () => {
    writeCookiesFile();

    const refreshedCookies: CookieEntry[] = [
      { name: 'YNOTE_CSTK', value: 'new-cstk', domain: '.note.youdao.com', path: '/' },
      { name: 'YNOTE_LOGIN', value: 'l', domain: '.note.youdao.com', path: '/' },
      { name: 'YNOTE_SESS', value: 's', domain: '.note.youdao.com', path: '/' },
    ];
    loadFromDesktopMock.mockReturnValueOnce({ cookies: refreshedCookies, error: '' });

    let callCount = 0;
    vi.mocked(fetch).mockImplementation((() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response('Unauthorized', { status: 401 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ fileEntry: { id: 'root-456' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }) as typeof fetch);

    const api = new YoudaoNoteApi(cookiesPath);
    api.loginByCookies();
    const rootId = await api.getRootId();

    expect(rootId).toBe('root-456');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
