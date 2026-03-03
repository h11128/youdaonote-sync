import { join, relative } from 'node:path';
import { readdirSync, statSync } from 'node:fs';

export interface WalkEntry {
  rel: string;
  absPath: string;
  mtime: number;
  isMd: boolean;
}

/**
 * Shared filesystem walker. Yields non-hidden files with their relative path,
 * absolute path, mtime, and whether they're markdown.
 */
export function walkFiles(
  dir: string,
  root: string,
  cb: (entry: WalkEntry) => void,
): void {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      walkFiles(full, root, cb);
    } else {
      let mtime = 0;
      try { mtime = Math.floor(statSync(full).mtimeMs / 1000); } catch { continue; }
      const rel = relative(root, full).replace(/\\/g, '/');
      cb({ rel, absPath: full, mtime, isMd: ent.name.endsWith('.md') });
    }
  }
}
