/**
 * Additional diagnose subcommands: cache, rebuild, duplicates, check-content.
 * Extracted to satisfy max-lines and complexity limits.
 */

import { dirname, join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SyncEngine } from '../engine/engine.js';
import { asDirId, asEpochSeconds, asFileId, type RelPath } from '../types/common.js';
import type { CloudFile, LocalFile } from '../types/scan.js';
import type { MetadataRecord } from '../types/metadata.js';
import { MetadataStore } from '../metadata/store.js';
import { computeContentHashFromFile, initXxhash } from '../algo/hash.js';
import type { DiagnoseConfig } from './diagnose.js';

function createEngineForRebuild(cfg: DiagnoseConfig): SyncEngine {
  return new SyncEngine({
    cookiesPath: cfg.cookiesPath,
    metadataPath: cfg.metadataPath,
    localDir: cfg.localDir,
    dryRun: true,
  });
}

export function cmdCache(cfg: DiagnoseConfig): void {
  const meta = new MetadataStore(cfg.metadataPath);
  const files = meta.getAllFiles();
  const dirs = meta.getAllDirs();

  let withFileId = 0;
  let withoutFileId = 0;
  let fileIdButCloudMtimeZero = 0;
  let fileIdButNotLocal = 0;

  for (const [path, rec] of files) {
    const hasId = rec.fileId !== '';
    if (hasId) {
      withFileId++;
      if (rec.cloudMtime === 0) fileIdButCloudMtimeZero++;
      if (!existsSync(join(cfg.localDir, path))) fileIdButNotLocal++;
    } else {
      withoutFileId++;
    }
  }

  console.log('='.repeat(60));
  console.log('  Metadata cache summary');
  console.log('='.repeat(60));
  console.log(`  Total files:           ${files.size}`);
  console.log(`  With file_id:          ${withFileId}`);
  console.log(`  Without file_id:       ${withoutFileId}`);
  console.log(`  file_id but cloud_mtime=0: ${fileIdButCloudMtimeZero}`);
  console.log(`  file_id but not local: ${fileIdButNotLocal}`);
  console.log(`  Total directories:     ${dirs.size}`);
  meta.close();
}

interface RebuildStats {
  filesUpserted: number;
  filesCached: number;
  filesLocalOnly: number;
  dirsAdded: number;
}

interface RebuildUpsertCtx {
  path: RelPath;
  cloud: CloudFile;
  local: LocalFile;
  existing: MetadataRecord | null;
  meta: MetadataStore;
  dryRun: boolean;
}

function rebuildUpsert(ctx: RebuildUpsertCtx): void {
  const { path, cloud, local, existing, meta, dryRun } = ctx;
  if (dryRun) return;
  const mtimeMatch =
    existing !== null && existing.cloudMtime === cloud.mtime && existing.localMtime === local.mtime;
  const contentHash = mtimeMatch ? existing.contentHash : null;
  meta.setFileInfo(path, {
    fileId: asFileId(cloud.id),
    cloudMtime: asEpochSeconds(cloud.mtime),
    localMtime: asEpochSeconds(local.mtime),
    parentId: asDirId(cloud.parentId),
    domain: cloud.domain,
    createTime: asEpochSeconds(cloud.ctime),
    contentHash: contentHash ?? computeContentHashFromFile(local.path),
  });
}

function rebuildCacheCloud(
  path: RelPath,
  cloud: CloudFile,
  meta: MetadataStore,
  dryRun: boolean,
): void {
  if (dryRun) return;
  meta.cacheCloudFileInfo(path, {
    fileId: asFileId(cloud.id),
    cloudMtime: asEpochSeconds(cloud.mtime),
    parentId: asDirId(cloud.parentId),
    domain: cloud.domain,
    createTime: asEpochSeconds(cloud.ctime),
  });
}

function rebuildLocalOnly(
  path: RelPath,
  local: LocalFile,
  meta: MetadataStore,
  dryRun: boolean,
): void {
  if (dryRun) return;
  const hash = computeContentHashFromFile(local.path);
  meta.setFileInfo(path, {
    fileId: asFileId(''),
    cloudMtime: asEpochSeconds(0),
    localMtime: asEpochSeconds(local.mtime),
    contentHash: hash,
  });
}

function rebuildProcessPath(
  path: RelPath,
  cloud: CloudFile | undefined,
  local: LocalFile | undefined,
  ctx: {
    meta: MetadataStore;
    existingFiles: Map<RelPath, MetadataRecord>;
    dryRun: boolean;
    stats: RebuildStats;
  },
): void {
  const { meta, existingFiles, dryRun, stats } = ctx;
  if (cloud?.isDir) return;

  const existing = existingFiles.get(path);
  if (cloud && local) {
    rebuildUpsert({
      path,
      cloud,
      local,
      existing: existing ?? null,
      meta,
      dryRun,
    });
    stats.filesUpserted++;
  } else if (cloud) {
    rebuildCacheCloud(path, cloud, meta, dryRun);
    stats.filesCached++;
  } else if (local) {
    rebuildLocalOnly(path, local, meta, dryRun);
    stats.filesLocalOnly++;
  }
}

export async function cmdRebuild(cfg: DiagnoseConfig, dryRun: boolean): Promise<void> {
  await initXxhash();
  const engine = createEngineForRebuild(cfg);
  const { cloudSnap, localSnap } = await engine.collectItems();
  engine.close();

  const meta = new MetadataStore(cfg.metadataPath);
  const existingFiles = meta.getAllFiles();
  const existingDirs = meta.getAllDirs();
  const stats: RebuildStats = {
    filesUpserted: 0,
    filesCached: 0,
    filesLocalOnly: 0,
    dirsAdded: 0,
  };

  const allPaths = new Set<RelPath>([...cloudSnap.keys(), ...localSnap.keys()]);
  const ctx = { meta, existingFiles, dryRun, stats };
  for (const path of allPaths) {
    if (path.includes('.conflict.')) continue;
    rebuildProcessPath(path, cloudSnap.get(path), localSnap.get(path), ctx);
  }

  for (const [path, cloud] of cloudSnap) {
    if (cloud.isDir && !existingDirs.has(path)) {
      if (!dryRun) meta.setDirInfo(path, asDirId(cloud.id), asDirId(cloud.parentId));
      stats.dirsAdded++;
    }
  }

  console.log('='.repeat(60));
  console.log('  Rebuild metadata' + (dryRun ? ' (dry-run)' : ''));
  console.log('='.repeat(60));
  console.log(`  Files upserted (cloud+local): ${stats.filesUpserted}`);
  console.log(`  Files cached (cloud only):   ${stats.filesCached}`);
  console.log(`  Files local only:            ${stats.filesLocalOnly}`);
  console.log(`  Directories added:           ${stats.dirsAdded}`);
  meta.close();
}

function md5Raw(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex');
}

function md5Normalized(buf: Buffer): string {
  let b = buf;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  const text = b.toString('utf-8').replace(/\r\n/g, '\n');
  return createHash('md5').update(text, 'utf-8').digest('hex');
}

type DuplicateCategory = 'identical' | 'crlf_only' | 'real_diff';

function classifyDuplicateGroup(paths: string[]): DuplicateCategory {
  const rawHashes: string[] = [];
  const normHashes: string[] = [];
  for (const p of paths) {
    try {
      const buf = readFileSync(p);
      rawHashes.push(md5Raw(buf));
      normHashes.push(md5Normalized(buf));
    } catch {
      rawHashes.push('');
      normHashes.push('');
    }
  }
  const rawSet = new Set(rawHashes);
  const normSet = new Set(normHashes);
  if (rawSet.size === 1 && rawHashes[0] !== '') return 'identical';
  if (normSet.size === 1 && normHashes[0] !== '') return 'crlf_only';
  return 'real_diff';
}

function walkForDuplicates(localDir: string, base: string, byName: Map<string, string[]>): void {
  const dir = base ? join(localDir, base) : localDir;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.includes('.conflict.')) continue;
    if (e.isDirectory() && e.name === '.git') continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      walkForDuplicates(localDir, rel, byName);
    } else {
      const list = byName.get(e.name) ?? [];
      list.push(join(localDir, rel));
      byName.set(e.name, list);
    }
  }
}

function findDirPairs(dirHashes: Map<string, Set<string>>): [string, string, number][] {
  const dirs = [...dirHashes.keys()];
  const pairs: [string, string, number][] = [];
  for (let i = 0; i < dirs.length; i++) {
    for (let j = i + 1; j < dirs.length; j++) {
      const di = dirs[i];
      const dj = dirs[j];
      if (di === undefined || dj === undefined) continue;
      const a = dirHashes.get(di);
      const b = dirHashes.get(dj);
      if (a && b) {
        const shared = [...a].filter((h) => b.has(h)).length;
        if (shared >= 3) pairs.push([di, dj, shared]);
      }
    }
  }
  return pairs;
}

function printDuplicateSummary(
  identical: string[][],
  crlfOnly: string[][],
  realDiff: string[][],
  dirPairs: [string, string, number][],
): void {
  console.log('='.repeat(60));
  console.log('  Duplicate scan');
  console.log('='.repeat(60));
  console.log(`  Identical (same content):    ${identical.length} groups`);
  console.log(`  CRLF-only differences:       ${crlfOnly.length} groups`);
  console.log(`  Real content differences:    ${realDiff.length} groups`);
  if (identical.length > 0) {
    console.log('\n  Identical groups:');
    for (const paths of identical.slice(0, 10)) {
      console.log(`    ${paths.join(' | ')}`);
    }
    if (identical.length > 10) console.log(`    ... and ${identical.length - 10} more`);
  }
  if (dirPairs.length > 0) {
    console.log('\n  Directory-level duplicates (3+ shared files):');
    for (const [d1, d2, n] of dirPairs.slice(0, 5)) {
      console.log(`    ${d1} <-> ${d2} (${n} shared)`);
    }
    if (dirPairs.length > 5) console.log(`    ... and ${dirPairs.length - 5} more pairs`);
  }
}

export function cmdDuplicates(localDir: string): void {
  const byName = new Map<string, string[]>();
  walkForDuplicates(localDir, '', byName);

  const identical: string[][] = [];
  const crlfOnly: string[][] = [];
  const realDiff: string[][] = [];

  for (const [, paths] of byName) {
    if (paths.length < 2) continue;
    const cat = classifyDuplicateGroup(paths);
    if (cat === 'identical') identical.push(paths);
    else if (cat === 'crlf_only') crlfOnly.push(paths);
    else realDiff.push(paths);
  }

  const dirHashes = new Map<string, Set<string>>();
  for (const paths of identical) {
    const first = paths[0];
    if (first === undefined) continue;
    const hash = md5Raw(readFileSync(first));
    for (const p of paths) {
      const dir = dirname(p);
      const set = dirHashes.get(dir) ?? new Set();
      set.add(hash);
      dirHashes.set(dir, set);
    }
  }

  const dirPairs = findDirPairs(dirHashes);
  printDuplicateSummary(identical, crlfOnly, realDiff, dirPairs);
}
