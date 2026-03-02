import type { XXHashAPI, XXHash } from 'xxhash-wasm';

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

/** xxHash3 128-bit hex string (via h64 concat for 128-bit). */
export function xxh128(data: string): string {
  const h = ensureInit();
  const hi = h.h64(data, 0n).toString(16).padStart(16, '0');
  const lo = h.h64(data, 0x9e3779b97f4a7c15n).toString(16).padStart(16, '0');
  return hi + lo;
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

/** Streaming xxHash64 hasher. */
export function createXxh64(seed = 0n): XXHash<bigint> {
  return ensureInit().create64(seed);
}

/** Check if xxhash has been initialized. */
export function isXxhashReady(): boolean {
  return api !== null;
}
