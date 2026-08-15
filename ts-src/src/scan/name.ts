export { sanitizeFilename, normalizeSep } from '../util/path.js';
export { cachedCloudName, mapCloudName } from './cloud-identity.js';

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
