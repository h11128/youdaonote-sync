import { readFileSync, statSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { extname } from 'node:path';
import type { ContentHash } from './types/common.js';
import { asContentHash } from './types/common.js';
import { initXxhash, xxh128, createXxh64 } from './algo/xxhash.js';

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.note', '.clip', '.json', '.xml', '.html', '.htm',
  '.css', '.js', '.ts', '.py', '.sh', '.yaml', '.yml', '.toml', '.ini',
  '.cfg', '.csv', '.log', '.rst', '.tex', '.bib', '.org',
]);

const MD_NORMALIZABLE_EXTENSIONS = new Set(['.md', '.txt']);

const CHUNK_SIZE = 256 * 1024; // 256 KB
const SMALL_FILE_THRESHOLD = 1024 * 1024; // 1 MB

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
          return t && [...t].every((ch) => '-: '.includes(ch)) ? '---' : t;
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
    s = s.replace(/\\([_$~&*#{}|.!\[\]()])/g, '$1');
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
 * Compute content hash (xxHash-128) from raw bytes.
 *
 * For text content: normalizes CRLF → LF, strips BOM, normalizes MD formatting.
 * For binary content: hashes raw bytes as-is.
 */
export function computeContentHashFromBytes(data: Uint8Array, filePath: string): ContentHash | null {
  try {
    if (isTextFile(filePath)) {
      const text = normalizeTextContent(Buffer.from(data), filePath);
      return asContentHash(xxh128(text));
    }
    // Binary: hash two h64 passes to produce 128-bit
    const h0 = createXxh64(0n);
    const h1 = createXxh64(0x9e3779b97f4a7c15n);
    h0.update(data);
    h1.update(data);
    const hi = h0.digest().toString(16).padStart(16, '0');
    const lo = h1.digest().toString(16).padStart(16, '0');
    return asContentHash(hi + lo);
  } catch {
    return null;
  }
}

const LARGE_BINARY_CHUNK = 1024 * 1024; // 1 MB chunks for streaming binary hash

/**
 * Compute content hash (xxHash-128) from a file on disk.
 *
 * Small files (≤ 1MB): read all at once.
 * Large text files (> 1MB): chunk-based with CRLF boundary handling.
 * Large binary files (> 1MB): streaming chunk-based hash (zero-copy equivalent).
 * .md/.txt files: always fully read for normalization (rarely > 1MB).
 */
export function computeContentHashFromFile(filePath: string): ContentHash | null {
  try {
    const st = statSync(filePath);
    const isText = isTextFile(filePath);

    // .md/.txt always need full read for normalization
    if (isMdNormalizable(filePath) || st.size <= SMALL_FILE_THRESHOLD) {
      const data = readFileSync(filePath);
      return computeContentHashFromBytes(data, filePath);
    }

    // Large binary file: streaming chunk-based hash
    if (!isText) {
      return hashLargeBinaryFile(filePath);
    }

    // Large text file (non-md): chunk-based with CRLF handling
    const fd = openSync(filePath, 'r');
    const h0 = createXxh64(0n);
    const h1 = createXxh64(0x9e3779b97f4a7c15n);
    const chunk = Buffer.alloc(CHUNK_SIZE);
    let firstChunk = true;
    let prevEndsWithCr = false;
    let bytesRead: number;

    try {
      while ((bytesRead = readSync(fd, chunk, 0, CHUNK_SIZE, null)) > 0) {
        let slice = chunk.subarray(0, bytesRead);

        if (firstChunk) {
          if (slice.length >= 3 && slice[0] === 0xef && slice[1] === 0xbb && slice[2] === 0xbf) {
            slice = slice.subarray(3);
          }
          firstChunk = false;
        }

        if (prevEndsWithCr && slice.length > 0 && slice[0] === 0x0a) {
          slice = slice.subarray(1);
        }

        let str = slice.toString('utf-8');
        str = str.replace(/\r\n/g, '\n');

        prevEndsWithCr = slice.length > 0 && slice[slice.length - 1] === 0x0d;
        if (prevEndsWithCr) {
          str = str.slice(0, -1) + '\n';
        }

        h0.update(str);
        h1.update(str);
      }
    } finally {
      closeSync(fd);
    }

    const hi = h0.digest().toString(16).padStart(16, '0');
    const lo = h1.digest().toString(16).padStart(16, '0');
    return asContentHash(hi + lo);
  } catch {
    return null;
  }
}

/**
 * Hash a large binary file using streaming chunks.
 * Avoids loading the entire file into memory at once.
 * Equivalent to Python's mmap-based approach for binary files.
 */
function hashLargeBinaryFile(filePath: string): ContentHash | null {
  const fd = openSync(filePath, 'r');
  try {
    const h0 = createXxh64(0n);
    const h1 = createXxh64(0x9e3779b97f4a7c15n);
    const chunk = Buffer.alloc(LARGE_BINARY_CHUNK);
    let bytesRead: number;

    while ((bytesRead = readSync(fd, chunk, 0, LARGE_BINARY_CHUNK, null)) > 0) {
      const slice = bytesRead === LARGE_BINARY_CHUNK ? chunk : chunk.subarray(0, bytesRead);
      h0.update(slice);
      h1.update(slice);
    }

    const hi = h0.digest().toString(16).padStart(16, '0');
    const lo = h1.digest().toString(16).padStart(16, '0');
    return asContentHash(hi + lo);
  } finally {
    closeSync(fd);
  }
}

/** Ensure xxhash WASM is loaded. Must be called once before hashing. */
export { initXxhash };
