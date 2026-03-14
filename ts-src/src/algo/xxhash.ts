import { createRequire } from 'node:module';
import type { XXHashAPI } from 'xxhash-wasm';

const require_ = createRequire(import.meta.url);
const { XXH3_128 } = require_('xxh3-ts') as { XXH3_128: (data: Buffer, seed?: bigint) => bigint };

let api: XXHashAPI | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Initialize the xxhash WASM module. Must be called once before using
 * xxhash functions. Safe to call multiple times (idempotent, deduped).
 */
export async function initXxhash(): Promise<void> {
  if (api) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const xxhash = (await import('xxhash-wasm')).default;
    api = await xxhash();
  })();
  return initPromise;
}

function ensureInit(): XXHashAPI {
  if (!api) throw new Error('xxhash not initialized — call initXxhash() first');
  return api;
}

/**
 * XXH3 128-bit hash, compatible with Python's xxhash.xxh3_128().
 * Accepts string or Buffer. Returns 32-char hex string.
 */
export function xxh128(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  const hash = XXH3_128(buf);
  return hash.toString(16).padStart(32, '0');
}

/** xxHash64 of a string, returned as hex string. */
export function xxh64ToString(data: string, seed = 0n): string {
  return ensureInit().h64(data, seed).toString(16).padStart(16, '0');
}

/** xxHash64 of a Uint8Array buffer, returned as bigint. */
export function xxh64Raw(data: Uint8Array, seed = 0n): bigint {
  return ensureInit().h64Raw(data, seed);
}

/** xxHash32 of a string, returned as hex string. */
export function xxh32ToString(data: string, seed = 0): string {
  return ensureInit().h32(data, seed).toString(16).padStart(8, '0');
}

/** Check if xxhash has been initialized. */
export function isXxhashReady(): boolean {
  return api !== null;
}
