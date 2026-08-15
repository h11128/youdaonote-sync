/**
 * One identity for "this local path is that cloud file".
 * Live listing, cache snap, calibrate, and upload must all use these rules.
 */
import { posix } from 'node:path';
import { NoteDomain } from '../types/common.js';
import type { CloudFile } from '../types/scan.js';
import { sanitizeFilename as sanitizeFromUtil } from '../util/path.js';
import { logger } from '../util/logger.js';

/** Official-app sibling of a local `.md` (Youdao hides the extension). */
export function officialAppName(localName: string): string | null {
  if (!localName.toLowerCase().endsWith('.md')) return null;
  return `${localName.slice(0, -3)}.note`;
}

/** Rebuild official-app name when cache only stored the local `.md` path. */
export function cachedCloudName(relPath: string, domain: number): string {
  const base = posix.basename(relPath.replace(/\\/g, '/'));
  const note = officialAppName(base);
  if (domain === (NoteDomain.NOTE as number) && note) return note;
  return base;
}

/**
 * Map a cloud filename to the local filename.
 * `.note` / `.clip` / no extension → `.md`; other names stay after sanitize.
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

/** True when this name/ext/domain should stay an official-app `.note`. */
export function needsOfficialNote(name: string, ext?: string, domain?: NoteDomain): boolean {
  if (domain === NoteDomain.NOTE) return true;
  if (domainFromCloudName(name) === NoteDomain.NOTE) return true;
  return !!ext && domainFromCloudName(`stem${ext}`) === NoteDomain.NOTE;
}

/** Infer Youdao domain from the official filename when the listing omits it. */
export function domainFromCloudName(name: string): NoteDomain {
  const lower = name.toLowerCase();
  if (lower.endsWith('.note') || lower.endsWith('.clip') || posix.extname(name) === '') {
    return NoteDomain.NOTE;
  }
  return NoteDomain.MARKDOWN;
}

export function cloudNameRank(name: string): number {
  if (name.endsWith('.note') || name.endsWith('.clip')) return 2;
  if (name.endsWith('.md')) return 0;
  return 1;
}

/** When `.note` and `.md` map to the same local path, keep the official-app `.note`. */
export function pickPreferredCloud(prev: CloudFile | undefined, next: CloudFile): CloudFile {
  if (!prev) return next;
  const prevRank = cloudNameRank(prev.name);
  const nextRank = cloudNameRank(next.name);
  if (nextRank !== prevRank) {
    const keep = nextRank > prevRank ? next : prev;
    logger.warn(`Cloud scan: stem collision "${prev.name}" vs "${next.name}" → keep ${keep.name}`);
    return keep;
  }
  return next.mtime >= prev.mtime ? next : prev;
}
