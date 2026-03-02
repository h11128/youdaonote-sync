import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { ContentHash } from './types/common.js';
import { asContentHash } from './types/common.js';

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.note', '.clip', '.json', '.xml', '.html', '.htm',
  '.css', '.js', '.ts', '.py', '.sh', '.yaml', '.yml', '.toml', '.ini',
  '.cfg', '.csv', '.log', '.rst', '.tex', '.bib', '.org',
]);

const CHUNK_SIZE = 256 * 1024; // 256 KB
const SMALL_FILE_THRESHOLD = 1024 * 1024; // 1 MB

function isTextFile(filePath: string): boolean {
  return TEXT_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/**
 * Compute content hash (MD5) from raw bytes.
 *
 * For text content: normalizes CRLF → LF, strips BOM.
 * For binary content: hashes raw bytes as-is.
 */
export function computeContentHashFromBytes(data: Uint8Array, filePath: string): ContentHash | null {
  try {
    const h = createHash('md5');
    if (isTextFile(filePath)) {
      let buf = Buffer.from(data);
      if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        buf = buf.subarray(3);
      }
      const normalized = buf.toString('utf-8').replace(/\r\n/g, '\n');
      h.update(normalized, 'utf-8');
    } else {
      h.update(data);
    }
    return asContentHash(h.digest('hex'));
  } catch {
    return null;
  }
}

/**
 * Compute content hash (MD5) from a file on disk.
 *
 * Small files (≤ 1MB): read all at once.
 * Large files (> 1MB): chunk-based reading with CRLF boundary handling.
 * Binary files: raw hash, no normalization.
 */
export function computeContentHashFromFile(filePath: string): ContentHash | null {
  try {
    const st = statSync(filePath);
    const isText = isTextFile(filePath);

    if (st.size <= SMALL_FILE_THRESHOLD || !isText) {
      const data = readFileSync(filePath);
      return computeContentHashFromBytes(data, filePath);
    }

    // Large text file: chunk-based with CRLF handling
    const { openSync, readSync, closeSync } = require('node:fs') as typeof import('node:fs');
    const fd = openSync(filePath, 'r');
    const h = createHash('md5');
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

        h.update(str, 'utf-8');
      }
    } finally {
      closeSync(fd);
    }

    return asContentHash(h.digest('hex'));
  } catch {
    return null;
  }
}
