import { join, relative } from 'node:path';
import { readdirSync, statSync } from 'node:fs';
import { asEpochSeconds, asRelPath, type EpochSeconds, type RelPath } from '../types/common.js';
import { requireNonEmpty } from '../util/preconditions.js';

export interface WalkEntry {
  rel: RelPath;
  absPath: string;
  mtime: EpochSeconds;
  isMd: boolean;
}

/**
 * Shared filesystem walker. Yields non-hidden files with their relative path,
 * absolute path, mtime, and whether they're markdown.
 */
export function walkFiles(dir: string, root: string, cb: (entry: WalkEntry) => void): void {
  requireNonEmpty('dir', dir);
  requireNonEmpty('root', root);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e: unknown) {
    console.warn(`[walk] cannot read directory ${dir}: ${String(e)}`);
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      walkFiles(full, root, cb);
    } else {
      let mtime: EpochSeconds;
      try {
        mtime = asEpochSeconds(Math.floor(statSync(full).mtimeMs / 1000));
      } catch {
        continue;
      }
      const rel = asRelPath(relative(root, full).replace(/\\/g, '/'));
      cb({ rel, absPath: full, mtime, isMd: ent.name.endsWith('.md') });
    }
  }
}
