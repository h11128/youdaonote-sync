import { extname } from 'node:path';
import type { MetadataStore } from '../metadata/store.js';
import type { ContentHash, EpochSeconds, RelPath } from '../types/common.js';
import type { CloudFile, LocalFile } from '../types/scan.js';
import type { FileState, SyncAction } from '../types/state.js';
import { stateToAction } from '../types/state.js';
import { patternToRegex } from '../scan/local.js';
import { emptyStats, type SyncStats } from '../execute/executor.js';
import { computeContentHashFromFileAsync } from '../algo/hash.js';
import { pLimit } from '../util/concurrency.js';
import { writeDryrunReport } from './helpers-dryrun.js';

const HASHABLE_EXTS = new Set([
  '.md',
  '.txt',
  '.html',
  '.htm',
  '.xml',
  '.json',
  '.css',
  '.js',
  '.csv',
]);

function isConflictCandidate(state: FileState): boolean {
  return state.kind === 'cloudModifiedContent' || state.kind === 'conflict';
}

function collectConflictCandidates(
  classified: Map<RelPath, FileState>,
  cloudSnap: ReadonlyMap<RelPath, CloudFile>,
): { relPath: RelPath; cloudFile: CloudFile }[] {
  const candidates: { relPath: RelPath; cloudFile: CloudFile }[] = [];
  for (const [relPath, state] of classified) {
    if (!isConflictCandidate(state)) continue;
    if (!HASHABLE_EXTS.has(extname(relPath).toLowerCase())) continue;
    const cf = cloudSnap.get(relPath);
    if (cf) candidates.push({ relPath, cloudFile: cf });
  }
  return candidates;
}

/**
 * Filter cloud snapshot by include/exclude patterns (matches local scan filtering).
 * Removes entries that don't match include patterns or that match exclude patterns.
 */
export function filterCloudSnap(
  cloudSnap: Map<RelPath, CloudFile>,
  opts: { include?: string[]; exclude?: string[] },
): void {
  const includeRes = (opts.include ?? []).map(patternToRegex);
  const excludeRes = (opts.exclude ?? []).map(patternToRegex);

  for (const path of [...cloudSnap.keys()]) {
    if (excludeRes.some((re) => re.test(path))) {
      cloudSnap.delete(path);
      continue;
    }
    if (includeRes.length > 0 && !includeRes.some((re) => re.test(path))) {
      cloudSnap.delete(path);
    }
  }
}

/**
 * Filter classified entries by sync direction.
 * 'pull' keeps only downloads/conflicts; 'push' keeps only uploads.
 * Non-matching entries are set to 'gone' (skipped).
 */
export function filterByDirection(
  classified: Map<RelPath, FileState>,
  direction: 'pull' | 'push',
): void {
  const allowedActions: Set<SyncAction> =
    direction === 'pull' ? new Set(['download', 'conflict']) : new Set(['upload']);

  for (const [path, state] of classified) {
    const action = stateToAction(state);
    if (action === 'skip' || action === 'move') continue;
    if (!allowedActions.has(action)) {
      classified.set(path, { kind: 'gone' });
    }
  }
}

export { collectConflictCandidates, HASHABLE_EXTS };

function collectUploadWarnings(
  classified: Map<RelPath, FileState>,
  meta: MetadataStore,
): { path: RelPath; reasons: string[] }[] {
  const warnings: { path: RelPath; reasons: string[] }[] = [];
  for (const [path, state] of classified) {
    if (stateToAction(state) !== 'upload') continue;
    const info = meta.getFileInfo(path);
    if (!info) continue;

    const reasons: string[] = [];
    if (!info.fileId && info.cloudMtime > 0) {
      reasons.push('metadata 有记录但 file_id 为空');
    }
    if (info.lastSyncAt > 0) {
      const d = new Date(info.lastSyncAt * 1000);
      reasons.push(`曾在 ${d.toISOString().slice(0, 16).replace('T', ' ')} 同步过`);
    }
    if (reasons.length > 0) warnings.push({ path, reasons });
  }
  return warnings;
}

function printUploadWarnings(warnings: { path: RelPath; reasons: string[] }[]): void {
  console.log();
  console.log('='.repeat(60));
  console.log(`  ⚠ 可疑 UPLOAD 诊断（${warnings.length} 个文件）`);
  console.log('='.repeat(60));
  console.log('  以下文件标记为上传，但 metadata 显示它们曾与云端关联。');
  console.log();
  for (const { path, reasons } of warnings) {
    console.log(`  ${path}`);
    for (const r of reasons) console.log(`    → ${r}`);
  }
  console.log();
}

/** Print per-item preview of sync actions. */
export function printPreview(classified: Map<RelPath, FileState>): void {
  const groups: Record<string, string[]> = {};
  for (const [path, state] of classified) {
    const action = stateToAction(state);
    if (action === 'skip') continue;
    (groups[action] ??= []).push(path);
  }

  console.log('\n=== Dry-Run Preview ===\n');
  const order: SyncAction[] = ['download', 'upload', 'conflict', 'move'];
  const labels: Record<string, string> = {
    download: '↓ DOWNLOAD',
    upload: '↑ UPLOAD',
    conflict: '⚡ CONFLICT',
    move: '→ MOVE',
  };
  for (const action of order) {
    const paths = groups[action];
    if (!paths?.length) continue;
    console.log(`${labels[action]} (${paths.length}):`);
    for (const p of paths) console.log(`  ${p}`);
    console.log();
  }
}

/** Print summary of dry-run results. */
export function printDryrunSummary(classified: Map<RelPath, FileState>): void {
  let dl = 0;
  let ul = 0;
  let conflict = 0;
  let move = 0;
  let skip = 0;
  for (const state of classified.values()) {
    switch (stateToAction(state)) {
      case 'download':
        dl++;
        break;
      case 'upload':
        ul++;
        break;
      case 'conflict':
        conflict++;
        break;
      case 'move':
        move++;
        break;
      case 'skip':
        skip++;
        break;
    }
  }
  const total = dl + ul + conflict + move;
  console.log('=== Dry-Run Summary ===');
  console.log(`  Total changes: ${total} (${skip} unchanged)`);
  if (dl) console.log(`  Downloads: ${dl}`);
  if (ul) console.log(`  Uploads:   ${ul}`);
  if (conflict) console.log(`  Conflicts: ${conflict}`);
  if (move) console.log(`  Moves:     ${move}`);
}

/** Diagnose suspicious UPLOADs and optionally write a markdown report. */
export function diagnoseDryrun(
  classified: Map<RelPath, FileState>,
  meta: MetadataStore,
  reportBaseDir?: string,
): void {
  printPreview(classified);
  printDryrunSummary(classified);

  const warnings = collectUploadWarnings(classified, meta);
  if (warnings.length > 0) printUploadWarnings(warnings);

  if (reportBaseDir) {
    const reportPath = writeDryrunReport(classified, warnings, reportBaseDir);
    console.log(`\n📄 Report saved to: ${reportPath}`);
  }
}

export function dryRunStats(classified: Map<RelPath, FileState>): SyncStats {
  const stats = emptyStats();
  for (const state of classified.values()) {
    switch (stateToAction(state)) {
      case 'skip':
        stats.skipped++;
        break;
      case 'download':
        stats.downloaded++;
        break;
      case 'upload':
        stats.uploaded++;
        break;
      case 'conflict':
        stats.conflicts++;
        break;
      case 'move':
        stats.moved++;
        break;
    }
  }
  return Object.freeze(stats);
}

export function buildDedupInputs(
  localSnap: Map<RelPath, LocalFile>,
  localHashes: Map<RelPath, ContentHash | null>,
): {
  localFileMap: Map<RelPath, { path: string; mtime: EpochSeconds; isDir: boolean }>;
  absPathHashes: Map<string, ContentHash>;
} {
  const localFileMap = new Map<RelPath, { path: string; mtime: EpochSeconds; isDir: boolean }>();
  const absPathHashes = new Map<string, ContentHash>();
  for (const [rel, info] of localSnap) {
    localFileMap.set(rel, { path: info.path, mtime: info.mtime, isDir: info.isDir });
    const h = localHashes.get(rel);
    if (h) absPathHashes.set(info.path, h);
  }
  return { localFileMap, absPathHashes };
}

/**
 * Pre-compute content hashes for files on both sides (warm the cache).
 * Only computes for hashable extensions that haven't been computed yet.
 * Uses bounded concurrency for parallel I/O.
 */
export async function warmupHashCache(
  cloudSnap: ReadonlyMap<RelPath, CloudFile>,
  localSnap: ReadonlyMap<RelPath, LocalFile>,
  localHashes: Map<RelPath, ContentHash | null>,
): Promise<void> {
  const toCompute: { relPath: RelPath; absPath: string }[] = [];
  for (const [relPath, local] of localSnap) {
    if (local.isDir || localHashes.has(relPath)) continue;
    if (!cloudSnap.has(relPath)) continue;
    const ext = extname(relPath).toLowerCase();
    if (!HASHABLE_EXTS.has(ext)) continue;
    toCompute.push({ relPath, absPath: local.path });
  }
  const CONCURRENCY = 8;
  const limit = pLimit(CONCURRENCY);
  await Promise.all(
    toCompute.map(({ relPath, absPath }) =>
      limit(async () => {
        const hash = await computeContentHashFromFileAsync(absPath);
        localHashes.set(relPath, hash);
      }),
    ),
  );
}

export function applyRefinementIfChanged(
  relPath: RelPath,
  refined: FileState,
  classified: Map<RelPath, FileState>,
): void {
  const current = classified.get(relPath);
  if (current && refined.kind !== current.kind) {
    classified.set(relPath, refined);
  }
}

/**
 * Clean up metadata for files that no longer exist in cloud.
 * Clears the file_id so they won't be treated as cloud-linked.
 */
export function cleanupStalePaths(
  meta: MetadataStore,
  cloudSnap: ReadonlyMap<RelPath, CloudFile>,
): void {
  const activeCloudPaths = new Set<RelPath>();
  for (const [path, cf] of cloudSnap) {
    if (!cf.isDir) activeCloudPaths.add(path);
  }
  const stalePaths = meta.getStaleCloudPaths(activeCloudPaths);
  if (stalePaths.length === 0) return;
  meta.batch(() => {
    for (const path of stalePaths) {
      meta.clearCloudId(path);
    }
  });
}
