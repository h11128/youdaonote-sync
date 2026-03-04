import { posix } from 'node:path';
import { sanitizeFilename as sanitizeFromUtil } from '../util/path.js';

export { sanitizeFilename, normalizeSep } from '../util/path.js';

/**
 * Map a cloud filename to the local filename.
 *
 * Two steps:
 * 1. Character sanitization (sanitizeFilename)
 * 2. Extension mapping: .note / .clip / no extension → .md
 */
export function mapCloudName(name: string): string {
  name = sanitizeFromUtil(name);
  const ext = posix.extname(name);
  if (ext === '.note' || ext === '.clip' || ext === '') {
    const stem = ext ? name.slice(0, -ext.length) : name;
    return stem + '.md';
  }
  return name;
}
