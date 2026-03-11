/**
 * Browser-based authentication via Playwright.
 *
 * Supports:
 * - Interactive browser login (persistent context with QR/password)
 * - Headless cookie refresh (reuse existing browser state)
 *
 * Playwright is an optional peer dependency — imported dynamically to
 * avoid errors when only the sync engine (no login) is used.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { saveCookies, hasRequiredCookies, type CookieEntry } from './cookies.js';

const NOTE_URL = 'https://note.youdao.com/web/';
const REQUIRED_COOKIE_NAMES = ['YNOTE_CSTK', 'YNOTE_LOGIN', 'YNOTE_SESS'];
const LOGIN_TIMEOUT_S = 300;
const POLL_INTERVAL_S = 2;

function getConfigDir(): string {
  return join(process.cwd(), 'config');
}

function getBrowserDataDir(): string {
  return join(getConfigDir(), 'browser_data');
}

function getCookiesPath(): string {
  return join(getConfigDir(), 'cookies.json');
}

// ── Playwright type stubs (optional peer dep) ──

interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

interface PlaywrightPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
}

interface PlaywrightContext {
  cookies(): Promise<PlaywrightCookie[]>;
  pages(): PlaywrightPage[];
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightBrowserType {
  launchPersistentContext(
    userDataDir: string,
    opts: Record<string, unknown>,
  ): Promise<PlaywrightContext>;
}

interface PlaywrightModule {
  chromium: PlaywrightBrowserType;
}

async function loadPlaywright(): Promise<PlaywrightModule | null> {
  try {
    const mod = 'playwright';
    return (await import(/* webpackIgnore: true */ mod)) as unknown as PlaywrightModule;
  } catch {
    return null;
  }
}

// ── Cookie helpers ──

function convertPlaywrightCookies(cookies: PlaywrightCookie[]): CookieEntry[] {
  return cookies
    .filter((c) => REQUIRED_COOKIE_NAMES.includes(c.name))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '.note.youdao.com',
      path: c.path || '/',
    }));
}

function trySaveCookies(cookies: PlaywrightCookie[]): boolean {
  const entries = convertPlaywrightCookies(cookies);
  if (entries.length < REQUIRED_COOKIE_NAMES.length) return false;
  return saveCookies({ cookies: entries }, getCookiesPath()).ok;
}

function hasCookies(cookies: PlaywrightCookie[]): boolean {
  return hasRequiredCookies(cookies.map((c) => c.name));
}

// ── Public API ──

/**
 * Attempt headless cookie refresh using existing browser state.
 * Returns true if cookies were successfully refreshed.
 */
export async function refreshCookiesIfNeeded(headless = true): Promise<boolean> {
  const pw = await loadPlaywright();
  if (!pw) return false;

  const browserDataDir = getBrowserDataDir();
  if (!existsSync(browserDataDir)) return false;

  console.log('Attempting to refresh cookies...');

  try {
    const context = await pw.chromium.launchPersistentContext(browserDataDir, {
      headless,
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
    });

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(NOTE_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    const ok = hasCookies(await context.cookies()) && trySaveCookies(await context.cookies());
    if (ok) console.log('Cookies refreshed successfully.');
    await context.close();
    return ok;
  } catch (e: unknown) {
    console.error(`Cookie refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Interactive browser login flow.
 * Opens a visible browser window for the user to log in.
 * Returns 0 on success, 1 on failure.
 */
export async function browserLogin(): Promise<number> {
  console.log('\n' + '='.repeat(60));
  console.log('  Youdao Note Login');
  console.log('='.repeat(60) + '\n');

  const pw = await loadPlaywright();
  if (!pw) {
    console.error(
      'Playwright is not installed. Run:\n\n  npm install playwright\n  npx playwright install chromium\n',
    );
    return 1;
  }

  const browserDataDir = getBrowserDataDir();
  mkdirSync(browserDataDir, { recursive: true });

  const context = await pw.chromium.launchPersistentContext(browserDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
    args: ['--start-maximized'],
  });

  try {
    const result = await doLogin(context);
    return result;
  } finally {
    await context.close();
  }
}

async function doLogin(context: PlaywrightContext): Promise<number> {
  // Check if existing browser state already has valid cookies
  const existing = await context.cookies();
  if (hasCookies(existing) && trySaveCookies(existing)) {
    console.log('Detected existing login state, verified!');
    console.log(`Cookies saved to: ${getCookiesPath()}`);
    return 0;
  }

  const page = context.pages()[0] ?? (await context.newPage());
  console.log('Opening Youdao Note...');
  console.log('Please complete login in the browser window.');
  console.log(`Waiting for login (timeout: ${LOGIN_TIMEOUT_S / 60} minutes)...\n`);
  await page.goto(NOTE_URL);

  const loggedIn = await waitForLogin(context, page);
  if (!loggedIn) {
    console.error('Timeout waiting for login. Please try again.');
    return 1;
  }

  await page.waitForTimeout(2000);
  console.log('\nExtracting cookies...');

  if (!trySaveCookies(await context.cookies())) {
    console.error('Failed to extract all required cookies.');
    return 1;
  }

  console.log(`\nCookies saved to: ${getCookiesPath()}`);
  console.log('\nLogin successful! Available commands:');
  console.log('  npx youdaonote-sync sync      # Sync notes');
  console.log('  npx youdaonote-sync watch     # Watch mode\n');
  return 0;
}

async function waitForLogin(context: PlaywrightContext, page: PlaywrightPage): Promise<boolean> {
  let waited = 0;
  while (waited < LOGIN_TIMEOUT_S) {
    if (hasCookies(await context.cookies())) {
      console.log('Login detected!');
      return true;
    }
    await page.waitForTimeout(POLL_INTERVAL_S * 1000);
    waited += POLL_INTERVAL_S;
    if (waited % 10 === 0) console.log(`  Waited ${waited}s...`);
  }
  return false;
}
