import { posix } from 'node:path';
import { NoteDomain } from '../types/common.js';
import { sanitizeFilename as sanitizeFromUtil } from '../util/path.js';

export { sanitizeFilename, normalizeSep } from '../util/path.js';

/**
 * Map a cloud filename to the local filename.
 *
 * Two steps:
 * 1. Character sanitization (sanitizeFilename)
 * 2. Extension mapping: .note / .clip / no extension → .md
 */
/** Rebuild official-app name when cache only stored the local `.md` path. */
export function cachedCloudName(relPath: string, domain: number): string {
  const base = posix.basename(relPath.replace(/\\/g, '/'));
  if (domain === (NoteDomain.NOTE as number) && base.toLowerCase().endsWith('.md')) {
    return `${base.slice(0, -3)}.note`;
  }
  return base;
}

export function mapCloudName(name: string): string {
  name = sanitizeFromUtil(name);
  const ext = posix.extname(name);
  if (ext === '.note' || ext === '.clip' || ext === '') {
    const stem = ext ? name.slice(0, -ext.length) : name;
    return stem + '.md';
  }
  return name;
}

export function patternToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (!ch) break;
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        regex += '\\[';
        i++;
        continue;
      }
      let inner = pattern.slice(i + 1, close);
      if (inner.startsWith('!')) inner = '^' + inner.slice(1);
      regex += `[${inner}]`;
      i = close + 1;
    } else if (ch === '*') {
      regex += '.*';
      i++;
    } else if (ch === '?') {
      regex += '.';
      i++;
    } else {
      regex += ch.replace(/[.+^${}()|\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`(^|/)${regex}$`);
}

export function compileFilter(include: string[], exclude: string[]): (path: string) => boolean {
  const includeRes = include.map(patternToRegex);
  const excludeRes = exclude.map(patternToRegex);

  return (path: string) => {
    if (excludeRes.some((re) => re.test(path))) return false;
    if (includeRes.length === 0) return true;
    return includeRes.some((re) => re.test(path));
  };
}
