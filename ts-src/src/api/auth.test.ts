import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';

// Control playwright mock: when true, chromium getter throws
const pwThrow = vi.hoisted(() => ({ value: false }));
const { mockLaunchPersistentContext } = vi.hoisted(() => ({
  mockLaunchPersistentContext: vi.fn(),
}));
vi.mock('playwright', () => ({
  get chromium() {
    if (pwThrow.value) throw new Error("Cannot find module 'playwright'");
    return { launchPersistentContext: mockLaunchPersistentContext };
  },
}));

const { mockSaveCookies, mockHasRequiredCookies } = vi.hoisted(() => ({
  mockSaveCookies: vi.fn().mockReturnValue({ ok: true }),
  mockHasRequiredCookies: vi.fn().mockReturnValue(true),
}));
vi.mock('./cookies.js', () => ({
  saveCookies: mockSaveCookies,
  hasRequiredCookies: mockHasRequiredCookies,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

const origExit = process.exit;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  process.exit = vi.fn() as unknown as typeof process.exit;
  process.cwd = vi.fn().mockReturnValue('/test');
  pwThrow.value = false;
  mockHasRequiredCookies.mockReturnValue(true);
  mockSaveCookies.mockReturnValue({ ok: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exit = origExit;
});

const VALID_COOKIES = [
  { name: 'YNOTE_CSTK', value: 'v1', domain: '.note.youdao.com', path: '/' },
  { name: 'YNOTE_LOGIN', value: 'v2', domain: '.note.youdao.com', path: '/' },
  { name: 'YNOTE_SESS', value: 'v3', domain: '.note.youdao.com', path: '/' },
];

function createMockContext(cookies: unknown[] = VALID_COOKIES): {
  cookies: ReturnType<typeof vi.fn>;
  pages: ReturnType<typeof vi.fn>;
  newPage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const mockPage = {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  };
  return {
    cookies: vi.fn().mockResolvedValue(cookies),
    pages: vi.fn().mockReturnValue([mockPage]),
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('refreshCookiesIfNeeded', () => {
  it('returns false when playwright is not available', async () => {
    pwThrow.value = true;
    vi.resetModules();
    const { refreshCookiesIfNeeded } = await import('./auth.js');
    const result = await refreshCookiesIfNeeded();
    pwThrow.value = false;
    expect(result).toBe(false);
  });

  it('returns false when browser_data dir does not exist', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const { refreshCookiesIfNeeded } = await import('./auth.js');
    expect(await refreshCookiesIfNeeded()).toBe(false);
    const callArg = vi.mocked(existsSync).mock.calls[0]?.[0] ?? '';
    expect(callArg).toContain('config');
    expect(callArg).toContain('browser_data');
  });

  it('refreshes and returns true when playwright available and cookies valid', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const ctx = createMockContext();
    mockLaunchPersistentContext.mockResolvedValue(ctx as never);

    const { refreshCookiesIfNeeded } = await import('./auth.js');
    expect(await refreshCookiesIfNeeded()).toBe(true);
    expect(ctx.close).toHaveBeenCalled();
  });

  it('returns false when cookie check fails (hasRequiredCookies returns false)', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    mockHasRequiredCookies.mockReturnValue(false);
    const ctx = createMockContext([{ name: 'OTHER', value: 'x', domain: '', path: '' }]);
    mockLaunchPersistentContext.mockResolvedValue(ctx as never);

    const { refreshCookiesIfNeeded } = await import('./auth.js');
    expect(await refreshCookiesIfNeeded()).toBe(false);
  });

  it('returns false when trySaveCookies fails (saveCookies returns ok: false)', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    mockSaveCookies.mockReturnValue({ ok: false, error: 'save failed' });
    mockLaunchPersistentContext.mockResolvedValue(createMockContext() as never);

    const { refreshCookiesIfNeeded } = await import('./auth.js');
    expect(await refreshCookiesIfNeeded()).toBe(false);
  });

  it('returns false when launchPersistentContext throws', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    mockLaunchPersistentContext.mockRejectedValue(new Error('launch failed'));

    const { refreshCookiesIfNeeded } = await import('./auth.js');
    const result = await refreshCookiesIfNeeded();
    expect(result).toBe(false);
  });
});

describe('browserLogin', () => {
  it('returns 1 when playwright is not available', async () => {
    vi.doMock('playwright', () => {
      throw new Error("Cannot find module 'playwright'");
    });
    vi.resetModules();
    const { browserLogin } = await import('./auth.js');
    const result = await browserLogin();
    expect(result).toBe(1);
    vi.doMock('playwright', () => ({
      get chromium() {
        if (pwThrow.value) throw new Error("Cannot find module 'playwright'");
        return { launchPersistentContext: mockLaunchPersistentContext };
      },
    }));
    vi.resetModules();
  });

  it('returns 0 when existing cookies are valid (early exit)', async () => {
    const ctx = createMockContext();
    mockLaunchPersistentContext.mockResolvedValue(ctx as never);

    const { browserLogin } = await import('./auth.js');
    expect(await browserLogin()).toBe(0);
    expect(ctx.close).toHaveBeenCalled();
  });

  it('returns 1 when login times out (waitForLogin returns false)', async () => {
    mockHasRequiredCookies.mockReturnValue(false);
    const ctx = createMockContext([{ name: 'OTHER', value: 'x', domain: '', path: '' }]);
    mockLaunchPersistentContext.mockResolvedValue(ctx as never);

    const { browserLogin } = await import('./auth.js');
    expect(await browserLogin()).toBe(1);
  });

  it('returns 0 on successful login flow', async () => {
    let cookieCalls = 0;
    mockHasRequiredCookies.mockImplementation(() => {
      cookieCalls++;
      return cookieCalls >= 2;
    });

    const ctx = createMockContext();
    ctx.cookies
      .mockReset()
      .mockResolvedValueOnce([{ name: 'OTHER', value: 'x', domain: '', path: '' }])
      .mockResolvedValue(VALID_COOKIES);
    mockLaunchPersistentContext.mockResolvedValue(ctx as never);

    const { browserLogin } = await import('./auth.js');
    expect(await browserLogin()).toBe(0);
  });
});
