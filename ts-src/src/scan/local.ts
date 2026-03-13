import { readdirSync, statSync, promises as fsPromises, type Dirent } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import type { LocalFile } from '../types/scan.js';
import { asEpochSeconds, asRelPath, type RelPath } from '../types/common.js';
import { normalizeSep, mapCloudName, compileFilter } from './name.js';
import { requireNonEmpty } from '../util/preconditions.js';
export { patternToRegex } from './name.js';

const LOCAL_ARTIFACT_DIRS = new Set(['images', 'attachments']);
const READDIR_OPTS = { withFileTypes: true, encoding: 'utf-8' } as const;
const CONFLICT_MARKER = '.conflict.';

function shouldSkipEntry(entry: Dirent): boolean {
  return entry.name.startsWith('.') || entry.isSymbolicLink();
}

function isArtifactDir(name: string): boolean {
  return LOCAL_ARTIFACT_DIRS.has(name);
}

function isConflictFile(name: string): boolean {
  return name.includes(CONFLICT_MARKER);
}

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
  result: Map<RelPath, LocalFile>,
): void {
  if (shouldSkipEntry(entry)) return;
  try {
    if (entry.isDirectory()) {
      if (isArtifactDir(entry.name)) return;
      const fullPath = join(scanDir, entry.name);
      const rel = asRelPath(normalizeSep(relative(localDir, fullPath)));
      const st = statSync(fullPath);
      result.set(rel, {
        path: fullPath,
        isDir: true,
        mtime: asEpochSeconds(Math.floor(st.mtimeMs / 1000)),
      });
      const subEntries = scandirRecursive(fullPath, localDir);
      for (const [k, v] of subEntries) result.set(k, v);
    } else if (entry.isFile()) {
      if (isConflictFile(entry.name)) return;
      addLocalFile(join(scanDir, entry.name), entry.name, localDir, result);
    }
  } catch (e: unknown) {
    console.warn(`[scan] cannot access ${join(scanDir, entry.name)}: ${String(e)}`);
  }
}

export function scanLocal(
  localDir: string,
  basePath: RelPath | '' = '',
  opts?: { include?: string[]; exclude?: string[] },
): Map<RelPath, LocalFile> {
  requireNonEmpty('localDir', localDir);
  const scanDir = basePath ? join(localDir, basePath) : localDir;
  const result = new Map<RelPath, LocalFile>();

  let entries: Dirent[];
  try {
    entries = readdirSync(scanDir, READDIR_OPTS);
  } catch (e: unknown) {
    console.warn(`[scan] cannot read directory ${scanDir}: ${String(e)}`);
    return result;
  }

  for (const entry of entries) {
    processEntry(entry, scanDir, localDir, result);
  }

  applyFilterToResult(result, opts);
  return result;
}

function applyFilterToResult(
  result: Map<RelPath, LocalFile>,
  opts?: { include?: string[]; exclude?: string[] },
): void {
  const hasInclude = opts?.include && opts.include.length > 0;
  const hasExclude = opts?.exclude && opts.exclude.length > 0;
  if (!hasInclude && !hasExclude) return;
  const filter = compileFilter(opts.include ?? [], opts.exclude ?? []);
  for (const key of [...result.keys()]) {
    if (!filter(key)) result.delete(key);
  }
}

function scandirRecursive(dirpath: string, localDir: string): Map<RelPath, LocalFile> {
  const target = new Map<RelPath, LocalFile>();
  let entries: Dirent[];
  try {
    entries = readdirSync(dirpath, READDIR_OPTS);
  } catch (e: unknown) {
    console.warn(`[scan] cannot read directory ${dirpath}: ${String(e)}`);
    return target;
  }
  for (const entry of entries) {
    processEntry(entry, dirpath, localDir, target);
  }
  return target;
}

function mapFileRelPath(fullPath: string, name: string, localDir: string): RelPath {
  return asRelPath(normalizeSep(relative(localDir, join(dirname(fullPath), mapCloudName(name)))));
}

function addLocalFile(
  fullPath: string,
  name: string,
  localDir: string,
  target: Map<RelPath, LocalFile>,
): void {
  const ext = extname(name);
  const rel = mapFileRelPath(fullPath, name, localDir);

  if (target.has(rel) && (ext === '.note' || ext === '.clip')) return;

  try {
    const st = statSync(fullPath);
    target.set(rel, {
      path: fullPath,
      isDir: false,
      mtime: asEpochSeconds(Math.floor(st.mtimeMs / 1000)),
      size: st.size,
    });
  } catch {
    /* skip inaccessible files */
  }
}

const EXT_MD = '.md';

function mergeIntoResult(result: Map<RelPath, LocalFile>, incoming: Map<RelPath, LocalFile>): void {
  for (const [k, v] of incoming) {
    const existing = result.get(k);
    const shouldOverwrite = !existing || v.path.endsWith(EXT_MD) || !existing.path.endsWith(EXT_MD);
    if (shouldOverwrite) result.set(k, v);
  }
}

async function addLocalFileAsync(
  fullPath: string,
  name: string,
  localDir: string,
): Promise<Map<RelPath, LocalFile>> {
  const rel = mapFileRelPath(fullPath, name, localDir);
  try {
    const st = await fsPromises.stat(fullPath);
    return new Map([
      [
        rel,
        {
          path: fullPath,
          isDir: false,
          mtime: asEpochSeconds(Math.floor(st.mtimeMs / 1000)),
          size: st.size,
        },
      ],
    ]);
  } catch {
    return new Map();
  }
}

async function scandirRecursiveAsync(
  dirpath: string,
  localDir: string,
): Promise<Map<RelPath, LocalFile>> {
  const target = new Map<RelPath, LocalFile>();
  let entries: Dirent[];
  try {
    entries = await fsPromises.readdir(dirpath, READDIR_OPTS);
  } catch {
    return target;
  }
  for (const entry of entries) {
    if (shouldSkipEntry(entry)) continue;
    try {
      if (entry.isDirectory()) {
        if (isArtifactDir(entry.name)) continue;
        const fullPath = join(dirpath, entry.name);
        const rel = asRelPath(normalizeSep(relative(localDir, fullPath)));
        const st = await fsPromises.stat(fullPath);
        target.set(rel, {
          path: fullPath,
          isDir: true,
          mtime: asEpochSeconds(Math.floor(st.mtimeMs / 1000)),
        });
        const sub = await scandirRecursiveAsync(fullPath, localDir);
        mergeIntoResult(target, sub);
      } else if (entry.isFile()) {
        if (isConflictFile(entry.name)) continue;
        const fileMap = await addLocalFileAsync(join(dirpath, entry.name), entry.name, localDir);
        mergeIntoResult(target, fileMap);
      }
    } catch {
      /* skip inaccessible entries */
    }
  }
  return target;
}

function collectTopLevelDirsAndFiles(entries: Dirent[]): { dirs: Dirent[]; files: Dirent[] } {
  const dirs: Dirent[] = [];
  const files: Dirent[] = [];
  for (const e of entries) {
    if (shouldSkipEntry(e)) continue;
    if (e.isDirectory()) dirs.push(e);
    else if (e.isFile()) files.push(e);
  }
  return { dirs, files };
}

async function addTopLevelDirEntries(
  result: Map<RelPath, LocalFile>,
  dirs: Dirent[],
  scanDir: string,
  localDir: string,
): Promise<void> {
  for (const e of dirs) {
    if (isArtifactDir(e.name)) continue;
    const fullPath = join(scanDir, e.name);
    const rel = asRelPath(normalizeSep(relative(localDir, fullPath)));
    try {
      const st = await fsPromises.stat(fullPath);
      result.set(rel, {
        path: fullPath,
        isDir: true,
        mtime: asEpochSeconds(Math.floor(st.mtimeMs / 1000)),
      });
    } catch {
      /* skip inaccessible */
    }
  }
}

export async function scanLocalParallel(
  localDir: string,
  basePath: RelPath | '' = '',
  opts?: { include?: string[]; exclude?: string[] },
): Promise<Map<RelPath, LocalFile>> {
  requireNonEmpty('localDir', localDir);
  const scanDir = basePath ? join(localDir, basePath) : localDir;
  const result = new Map<RelPath, LocalFile>();

  let entries: Dirent[];
  try {
    entries = await fsPromises.readdir(scanDir, READDIR_OPTS);
  } catch {
    return result;
  }

  const { dirs, files } = collectTopLevelDirsAndFiles(entries);

  const dirResults = await Promise.all(
    dirs
      .filter((e) => !isArtifactDir(e.name))
      .map((e) => scandirRecursiveAsync(join(scanDir, e.name), localDir)),
  );
  for (const m of dirResults) mergeIntoResult(result, m);
  await addTopLevelDirEntries(result, dirs, scanDir, localDir);

  const fileResults = await Promise.all(
    files
      .filter((e) => !isConflictFile(e.name))
      .map((e) => addLocalFileAsync(join(scanDir, e.name), e.name, localDir)),
  );
  for (const m of fileResults) mergeIntoResult(result, m);

  applyFilterToResult(result, opts);
  return result;
}
