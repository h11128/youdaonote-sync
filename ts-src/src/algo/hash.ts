import { readFileSync, statSync, promises as fsPromises } from 'node:fs';
import { extname } from 'node:path';
import type { ContentHash, EpochSeconds, RelPath } from '../types/common.js';
import { asContentHash } from '../types/common.js';
import { initXxhash, xxh128 } from './xxhash.js';
import { requireNonEmpty } from '../util/preconditions.js';
import { pLimit } from '../util/concurrency.js';

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.note',
  '.clip',
  '.json',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.ts',
  '.py',
  '.sh',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.csv',
  '.log',
  '.rst',
  '.tex',
  '.bib',
  '.org',
]);

const MD_NORMALIZABLE_EXTENSIONS = new Set(['.md', '.txt']);

function isTextFile(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function isMdNormalizable(filePath: string): boolean {
  return MD_NORMALIZABLE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

// Pre-compiled regexes for normalizeMdFormatting — avoid per-line RegExp construction
const RE_TRAILING_WS = /\s+$/;
const RE_EMPTY_BQ = /^\s*>[\s>]*$/;
const RE_CODE_FENCE = /^\s*```\w*\s*$/;
const RE_HRULE = /^[\s]*(\*\s*\*\s*\*[\s*]*|-\s*-\s*-[\s-]*)$/;
const RE_TABLE_SEP = /^\|[\s:|-]+\|$/;
const BQ = '(?:>\\s*)*';
const RE_UL_STAR = new RegExp(`^(\\s*${BQ})\\*(\\s+)`);
const RE_OL_SPACES = new RegExp(`^(\\s*${BQ}\\d+\\.)\\s{2,}`);
const RE_UL_SPACES = new RegExp(`^(\\s*${BQ}-)\\s{2,}`);
const RE_LEADING_WS = /^\s+/;
const RE_TABLE_CELL_PAD = /\s*\|\s*/g;
const RE_MULTI_SPACE = / {2,}/g;
const RE_BACKSLASH_ESC = /\\([[_$~&*#{}|.!\]()])/g;
const RE_ANGLE_LINK = /<(https?:\/\/[^>]+)>/g;

/**
 * Normalize Markdown formatting to eliminate insignificant editor differences.
 *
 * Used before content hashing so that the same document saved by different
 * editors (Youdao reformats Markdown) produces an identical hash.
 */
export function normalizeMdFormatting(text: string): string {
  const result: string[] = [];
  for (const rawLine of text.split('\n')) {
    let s = rawLine.replace(RE_TRAILING_WS, '');
    if (!s) continue;
    if (RE_EMPTY_BQ.test(s)) continue;
    if (RE_CODE_FENCE.test(s)) {
      result.push('---fence---');
      continue;
    }
    if (RE_HRULE.test(s)) {
      s = '---';
    }
    if (RE_TABLE_SEP.test(s)) {
      const cells = s.split('|');
      s = cells
        .map((c) => {
          const t = c.trim();
          return t && Array.from(t).every((ch) => '-: '.includes(ch)) ? '---' : t;
        })
        .join('|');
    }
    s = s.replace(RE_UL_STAR, '$1-$2');
    s = s.replace(RE_OL_SPACES, '$1 ');
    s = s.replace(RE_UL_SPACES, '$1 ');
    s = s.replace(RE_LEADING_WS, '');
    if (s.startsWith('|')) {
      s = s.replace(RE_TABLE_CELL_PAD, '|');
    }
    s = s.replace(RE_MULTI_SPACE, ' ');
    s = s.replace(RE_BACKSLASH_ESC, '$1');
    s = s.replace(RE_ANGLE_LINK, '$1');
    s = s.replaceAll('`', '');
    result.push(s);
  }
  return result.join('\n');
}

function normalizeTextContent(buf: Buffer, filePath: string): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    buf = buf.subarray(3);
  }
  let text = buf.toString('utf-8').replace(/\r\n/g, '\n');
  if (isMdNormalizable(filePath)) {
    text = normalizeMdFormatting(text);
  }
  return text;
}

/**
 * Compute content hash (XXH3-128) from raw bytes.
 * Compatible with Python's xxhash.xxh3_128().
 *
 * For text content: normalizes CRLF → LF, strips BOM, normalizes MD formatting.
 * For binary content: hashes raw bytes as-is.
 */
export function computeContentHashFromBytes(
  data: Uint8Array,
  filePath: string,
): ContentHash | null {
  requireNonEmpty('filePath', filePath);
  if (isTextFile(filePath)) {
    const text = normalizeTextContent(Buffer.from(data), filePath);
    return asContentHash(xxh128(text));
  }
  return asContentHash(xxh128(Buffer.from(data)));
}

/**
 * Compute content hash (XXH3-128) from a file on disk.
 * Compatible with Python's xxhash.xxh3_128().
 *
 * Text files: normalizes CRLF → LF, strips BOM, normalizes MD formatting, then hashes.
 * Binary files: reads and hashes raw bytes.
 */
export function computeContentHashFromFile(filePath: string): ContentHash | null {
  requireNonEmpty('filePath', filePath);
  try {
    statSync(filePath);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const data = readFileSync(filePath);
  return computeContentHashFromBytes(data, filePath);
}

const STREAM_THRESHOLD = 50 * 1024 * 1024; // 50 MB

/**
 * Async version of computeContentHashFromFile.
 * For files > 50 MB, reads asynchronously to avoid blocking the event loop.
 */
export async function computeContentHashFromFileAsync(
  filePath: string,
): Promise<ContentHash | null> {
  requireNonEmpty('filePath', filePath);
  try {
    const st = await fsPromises.stat(filePath);
    if (st.size > STREAM_THRESHOLD) {
      const data = await fsPromises.readFile(filePath);
      return computeContentHashFromBytes(data, filePath);
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const data = readFileSync(filePath);
  return computeContentHashFromBytes(data, filePath);
}

/**
 * Interface for hash cache lookups — implemented by MetadataStore.
 * Keeps hash.ts decoupled from the metadata layer.
 */
export interface HashCacheLookup {
  getCachedHashesBulk(
    entries: readonly { relPath: RelPath; mtime: EpochSeconds; size: number }[],
  ): Map<RelPath, ContentHash>;
  setCachedHashesBulk(
    entries: readonly { path: string; mtime: EpochSeconds; size: number; hash: ContentHash }[],
  ): void;
}

export interface HashFileEntry {
  relPath: RelPath;
  absPath: string;
  mtime?: EpochSeconds | undefined;
  size?: number | undefined;
}

export interface HashConcurrentResult {
  cacheHits: number;
  computed: number;
}

/**
 * Compute hashes for multiple files with bounded concurrency.
 * When `cache` is provided, skips files whose (mtime, size) match the cache
 * and persists newly computed hashes back to the cache.
 */
export async function computeHashesConcurrent(
  files: readonly HashFileEntry[],
  target: Map<RelPath, ContentHash | null>,
  opts?: { concurrency?: number; cache?: HashCacheLookup | undefined },
): Promise<HashConcurrentResult> {
  const concurrency = opts?.concurrency ?? 8;
  const cache = opts?.cache;

  let cacheHits = 0;
  if (cache) {
    const cacheable = files.filter(
      (f): f is HashFileEntry & { mtime: EpochSeconds; size: number } =>
        !target.has(f.relPath) && f.mtime != null && f.size != null,
    );
    const cached = cache.getCachedHashesBulk(cacheable);
    for (const [relPath, hash] of cached) {
      target.set(relPath, hash);
      cacheHits++;
    }
  }

  const remaining = files.filter((f) => !target.has(f.relPath));
  const newEntries: { path: string; mtime: EpochSeconds; size: number; hash: ContentHash }[] = [];
  const limit = pLimit(concurrency);

  await Promise.all(
    remaining.map((entry) =>
      limit(async () => {
        if (target.has(entry.relPath)) return;
        const hash = await computeContentHashFromFileAsync(entry.absPath);
        target.set(entry.relPath, hash);
        if (hash && cache && entry.mtime != null && entry.size != null) {
          newEntries.push({ path: entry.relPath, mtime: entry.mtime, size: entry.size, hash });
        }
      }),
    ),
  );

  if (cache && newEntries.length > 0) {
    cache.setCachedHashesBulk(newEntries);
  }

  return { cacheHits, computed: remaining.length };
}

/** Ensure xxhash WASM is loaded. Must be called once before hashing. */
export { initXxhash };
