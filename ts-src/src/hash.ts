import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { ContentHash } from './types/common.js';
import { asContentHash } from './types/common.js';
import { initXxhash, xxh128 } from './algo/xxhash.js';
import { requireNonEmpty } from './util/preconditions.js';

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

/**
 * Normalize Markdown formatting to eliminate insignificant editor differences.
 *
 * Used before content hashing so that the same document saved by different
 * editors (Youdao reformats Markdown) produces an identical hash.
 */
export function normalizeMdFormatting(text: string): string {
  const bq = '(?:>\\s*)*'; // optional nested blockquote prefix
  const result: string[] = [];
  for (const rawLine of text.split('\n')) {
    let s = rawLine.replace(/\s+$/, '');
    if (!s) continue;
    // empty blockquote lines
    if (/^\s*>[\s>]*$/.test(s)) continue;
    // code fence lines
    if (/^\s*```\w*\s*$/.test(s)) continue;
    // horizontal rules
    if (/^[\s]*(\*\s*\*\s*\*[\s*]*|-\s*-\s*-[\s-]*)$/.test(s)) {
      s = '---';
    }
    // table separator: | --- | --- |
    if (/^\|[\s:|-]+\|$/.test(s)) {
      const cells = s.split('|');
      s = cells
        .map((c) => {
          const t = c.trim();
          return t && Array.from(t).every((ch) => '-: '.includes(ch)) ? '---' : t;
        })
        .join('|');
    }
    // unordered list marker: > * / * → > - / -
    s = s.replace(new RegExp(`^(\\s*${bq})\\*(\\s+)`), '$1-$2');
    // extra spaces after list markers
    s = s.replace(new RegExp(`^(\\s*${bq}\\d+\\.)\\s{2,}`), '$1 ');
    s = s.replace(new RegExp(`^(\\s*${bq}-)\\s{2,}`), '$1 ');
    // strip leading whitespace
    s = s.replace(/^\s+/, '');
    // table cell padding normalization
    if (s.startsWith('|')) {
      s = s.replace(/\s*\|\s*/g, '|');
    }
    // collapse internal consecutive spaces
    s = s.replace(/ {2,}/g, ' ');
    // backslash escapes
    s = s.replace(/\\([[_$~&*#{}|.!\]()])/g, '$1');
    // angle-bracket links: <https://...> → https://...
    s = s.replace(/<(https?:\/\/[^>]+)>/g, '$1');
    // remove inline code backticks
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

/** Ensure xxhash WASM is loaded. Must be called once before hashing. */
export { initXxhash };
