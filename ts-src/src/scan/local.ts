import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import type { LocalFile } from '../types/scan.js';
import { normalizeSep, mapCloudName } from './name.js';

const LOCAL_ARTIFACT_DIRS = new Set(['images', 'attachments']);

/**
 * Recursively scan a local directory, returning a map of relative paths → LocalFile.
 *
 * Path mapping rules match scan_cloud:
 * - .note/.clip/no extension → mapped to .md
 * - When .note and .md both exist, .md takes priority
 * - images/ and attachments/ are download artifacts, skipped
 */
function processEntry(
  entry: Dirent,
  scanDir: string,
  localDir: string,
  result: Map<string, LocalFile>,
): void {
  if (entry.name.startsWith('.')) return;
  if (entry.isSymbolicLink()) return;

  if (entry.isDirectory()) {
    if (LOCAL_ARTIFACT_DIRS.has(entry.name)) return;
    const fullPath = join(scanDir, entry.name);
    const rel = normalizeSep(relative(localDir, fullPath));
    try {
      const st = statSync(fullPath);
      result.set(rel, {
        path: fullPath,
        isDir: true,
        mtime: Math.floor(st.mtimeMs / 1000),
      });
    } catch {
      /* skip inaccessible dirs */
    }
    const subEntries = scandirRecursive(fullPath, localDir);
    for (const [k, v] of subEntries) result.set(k, v);
  } else if (entry.isFile()) {
    if (entry.name.includes('.conflict.')) return;
    addLocalFile(join(scanDir, entry.name), entry.name, localDir, result);
  }
}

export function scanLocal(
  localDir: string,
  basePath = '',
  opts?: { include?: string[]; exclude?: string[] },
): Map<string, LocalFile> {
  const scanDir = basePath ? join(localDir, basePath) : localDir;
  const result = new Map<string, LocalFile>();

  let entries: Dirent[];
  try {
    entries = readdirSync(scanDir, { withFileTypes: true, encoding: 'utf-8' });
  } catch {
    return result;
  }

  for (const entry of entries) {
    processEntry(entry, scanDir, localDir, result);
  }

  const hasInclude = opts?.include && opts.include.length > 0;
  const hasExclude = opts?.exclude && opts.exclude.length > 0;
  if (hasInclude || hasExclude) {
    const filter = compileFilter(opts.include ?? [], opts.exclude ?? []);
    for (const key of [...result.keys()]) {
      if (!filter(key)) result.delete(key);
    }
  }

  return result;
}

function processRecursiveEntry(
  entry: Dirent,
  dirpath: string,
  localDir: string,
  target: Map<string, LocalFile>,
): void {
  if (entry.name.startsWith('.')) return;
  if (entry.isSymbolicLink()) return;
  try {
    if (entry.isDirectory()) {
      if (LOCAL_ARTIFACT_DIRS.has(entry.name)) return;
      const fullPath = join(dirpath, entry.name);
      const rel = normalizeSep(relative(localDir, fullPath));
      const st = statSync(fullPath);
      target.set(rel, {
        path: fullPath,
        isDir: true,
        mtime: Math.floor(st.mtimeMs / 1000),
      });
      const sub = scandirRecursive(fullPath, localDir);
      for (const [k, v] of sub) target.set(k, v);
    } else if (entry.isFile()) {
      if (entry.name.includes('.conflict.')) return;
      addLocalFile(join(dirpath, entry.name), entry.name, localDir, target);
    }
  } catch {
    /* skip inaccessible entries */
  }
}

function scandirRecursive(dirpath: string, localDir: string): Map<string, LocalFile> {
  const target = new Map<string, LocalFile>();
  let entries: Dirent[];
  try {
    entries = readdirSync(dirpath, { withFileTypes: true, encoding: 'utf-8' });
  } catch {
    return target;
  }
  for (const entry of entries) {
    processRecursiveEntry(entry, dirpath, localDir, target);
  }
  return target;
}

function addLocalFile(
  fullPath: string,
  name: string,
  localDir: string,
  target: Map<string, LocalFile>,
): void {
  const ext = extname(name);
  const mappedName = mapCloudName(name);
  const parentDir = dirname(fullPath);
  const rel = normalizeSep(relative(localDir, join(parentDir, mappedName)));

  // When both .note and .md exist for the same stem, .md takes priority
  if (target.has(rel) && (ext === '.note' || ext === '.clip')) return;

  try {
    const st = statSync(fullPath);
    target.set(rel, {
      path: fullPath,
      isDir: false,
      mtime: Math.floor(st.mtimeMs / 1000),
      size: st.size,
    });
  } catch {
    /* skip inaccessible files */
  }
}

function compileFilter(include: string[], exclude: string[]): (path: string) => boolean {
  const includeRes = include.map(patternToRegex);
  const excludeRes = exclude.map(patternToRegex);

  return (path: string) => {
    if (excludeRes.some((re) => re.test(path))) return false;
    if (includeRes.length === 0) return true;
    return includeRes.some((re) => re.test(path));
  };
}

export function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`(^|/)${escaped}$`);
}
