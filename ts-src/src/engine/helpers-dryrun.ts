import { join } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import type { MetadataStore } from '../metadata/store.js';
import type { ContentHash, RelPath } from '../types/common.js';
import type { FileState, SyncAction } from '../types/state.js';
import { stateToAction } from '../types/state.js';
import { requireNonEmpty } from '../util/preconditions.js';
import { emptyStats, type SyncStats } from '../execute/executor.js';
import { logger } from '../util/logger.js';

const REPORT_ORDER: SyncAction[] = [
  'download',
  'upload',
  'conflict',
  'move',
  'deleteCloud',
  'deleteLocal',
];
const REPORT_LABELS: Record<string, string> = {
  download: '↓ Download',
  upload: '↑ Upload',
  conflict: '⚡ Conflict',
  move: '→ Move',
  deleteCloud: '🗑 Delete Cloud',
  deleteLocal: '🗑 Delete Local',
};

/** Resolve the effective action for a path, considering deleteOverrides. */
export function effectiveAction(
  state: FileState,
  relPath: RelPath,
  deleteOverrides?: ReadonlyMap<RelPath, 'deleteCloud' | 'deleteLocal'>,
): SyncAction {
  const override = deleteOverrides?.get(relPath);
  return override ?? stateToAction(state);
}

export function groupByAction(
  classified: Map<RelPath, FileState>,
  deleteOverrides?: ReadonlyMap<RelPath, 'deleteCloud' | 'deleteLocal'>,
): Map<SyncAction, RelPath[]> {
  const groups = new Map<SyncAction, RelPath[]>();
  for (const [path, state] of classified) {
    const action = deleteOverrides?.get(path) ?? stateToAction(state);
    let list = groups.get(action);
    if (!list) {
      list = [];
      groups.set(action, list);
    }
    list.push(path);
  }
  return groups;
}

/** Print per-item preview of sync actions. */
export function printPreview(
  classified: Map<RelPath, FileState>,
  deleteOverrides?: ReadonlyMap<RelPath, 'deleteCloud' | 'deleteLocal'>,
): void {
  const groups: Record<string, string[]> = {};
  for (const [path, state] of classified) {
    const action = effectiveAction(state, path, deleteOverrides);
    if (action === 'skip') continue;
    (groups[action] ??= []).push(path);
  }

  logger.info('\n=== Dry-Run Preview ===\n');
  const order: SyncAction[] = [
    'download',
    'upload',
    'conflict',
    'move',
    'deleteCloud',
    'deleteLocal',
  ];
  const labels: Record<string, string> = {
    download: '↓ DOWNLOAD',
    upload: '↑ UPLOAD',
    conflict: '⚡ CONFLICT',
    move: '→ MOVE',
    deleteCloud: '🗑 DELETE CLOUD',
    deleteLocal: '🗑 DELETE LOCAL',
  };
  for (const action of order) {
    const paths = groups[action];
    if (!paths?.length) continue;
    logger.info(`${labels[action]} (${paths.length}):`);
    for (const p of paths) logger.info(`  ${p}`);
    logger.info('');
  }
}

/** Print summary of dry-run results. */
export function printDryrunSummary(
  classified: Map<RelPath, FileState>,
  deleteOverrides?: ReadonlyMap<RelPath, 'deleteCloud' | 'deleteLocal'>,
): void {
  let dl = 0,
    ul = 0,
    conflict = 0,
    move = 0,
    skip = 0,
    delCloud = 0,
    delLocal = 0;
  for (const [path, state] of classified) {
    switch (effectiveAction(state, path, deleteOverrides)) {
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
      case 'deleteCloud':
        delCloud++;
        break;
      case 'deleteLocal':
        delLocal++;
        break;
      case 'skip':
        skip++;
        break;
    }
  }
  const total = dl + ul + conflict + move + delCloud + delLocal;
  logger.info('=== Dry-Run Summary ===');
  logger.info(`Total changes: ${total} (${skip} unchanged)`);
  if (dl) logger.info(`Downloads:     ${dl}`);
  if (ul) logger.info(`Uploads:       ${ul}`);
  if (conflict) logger.info(`Conflicts:     ${conflict}`);
  if (move) logger.info(`Moves:         ${move}`);
  if (delCloud) logger.info(`Delete cloud:  ${delCloud}`);
  if (delLocal) logger.info(`Delete local:  ${delLocal}`);
}

function collectUploadWarnings(
  classified: Map<RelPath, FileState>,
  meta: MetadataStore,
  localHashes?: ReadonlyMap<RelPath, ContentHash | null>,
): { path: RelPath; reasons: string[] }[] {
  const warnings: { path: RelPath; reasons: string[] }[] = [];
  for (const [path, state] of classified) {
    if (stateToAction(state) !== 'upload') continue;
    const info = meta.getFileInfo(path);
    if (!info) continue;

    const reasons: string[] = [];
    reasons.push(`分类: ${state.kind}`);
    if (!info.fileId && info.cloudMtime > 0) {
      reasons.push('metadata 有记录但 file_id 为空');
    }
    if (info.lastSyncAt > 0) {
      const d = new Date(info.lastSyncAt * 1000);
      reasons.push(`曾在 ${d.toISOString().slice(0, 16).replace('T', ' ')} 同步过`);
    }
    const oldHash = info.contentHash ?? '(none)';
    const newHash = localHashes?.get(path) ?? '(not computed)';
    if (oldHash !== newHash) {
      reasons.push(`hash: ${oldHash} → ${String(newHash)}`);
    }
    if (reasons.length > 0) warnings.push({ path, reasons });
  }
  return warnings;
}

function printUploadWarnings(warnings: { path: RelPath; reasons: string[] }[]): void {
  logger.warn('');
  logger.warn('='.repeat(60));
  logger.warn(`⚠ 可疑 UPLOAD 诊断（${warnings.length} 个文件）`);
  logger.warn('='.repeat(60));
  logger.warn('以下文件标记为上传，但 metadata 显示它们曾与云端关联。');
  logger.warn('');
  for (const { path, reasons } of warnings) {
    logger.warn(`  ${path}`);
    for (const r of reasons) logger.warn(`    → ${r}`);
  }
  logger.warn('');
}

/** Diagnose suspicious UPLOADs and optionally write a markdown report. */
export function diagnoseDryrun(
  classified: Map<RelPath, FileState>,
  meta: MetadataStore,
  opts?: {
    reportBaseDir?: string | undefined;
    localHashes?: ReadonlyMap<RelPath, ContentHash | null> | undefined;
    deleteOverrides?: ReadonlyMap<RelPath, 'deleteCloud' | 'deleteLocal'> | undefined;
  },
): void {
  printPreview(classified, opts?.deleteOverrides);
  printDryrunSummary(classified, opts?.deleteOverrides);

  const warnings = collectUploadWarnings(classified, meta, opts?.localHashes);
  if (warnings.length > 0) printUploadWarnings(warnings);

  if (opts?.reportBaseDir) {
    const reportPath = writeDryrunReport(
      classified,
      warnings,
      opts.reportBaseDir,
      opts.deleteOverrides,
    );
    logger.info(`\n📄 Report saved to: ${reportPath}`);
  }
}

export function dryRunStats(
  classified: Map<RelPath, FileState>,
  deleteOverrides?: ReadonlyMap<RelPath, 'deleteCloud' | 'deleteLocal'>,
): SyncStats {
  const stats = emptyStats();
  for (const [path, state] of classified) {
    switch (effectiveAction(state, path, deleteOverrides)) {
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
      case 'deleteCloud':
        stats.deletedCloud++;
        break;
      case 'deleteLocal':
        stats.deletedLocal++;
        break;
    }
  }
  return Object.freeze(stats);
}

export function writeDryrunReport(
  classified: Map<RelPath, FileState>,
  warnings: { path: RelPath; reasons: string[] }[],
  baseDir: string,
  deleteOverrides?: ReadonlyMap<RelPath, 'deleteCloud' | 'deleteLocal'>,
): string {
  requireNonEmpty('baseDir', baseDir);
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '');
  const reportDir = join(baseDir, '.local-reports');
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `dry-run-${dateStr}-${timeStr}.md`);

  const groups = groupByAction(classified, deleteOverrides);
  const skipCount = groups.get('skip')?.length ?? 0;
  const totalChanges = classified.size - skipCount;

  const lines: string[] = [];
  lines.push(`# Dry-Run Report — ${dateStr} ${now.toISOString().slice(11, 16)}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Type | Count |');
  lines.push('|------|-------|');
  lines.push(`| Total changes | ${totalChanges} |`);
  for (const action of REPORT_ORDER) {
    const items = groups.get(action);
    if (items?.length) lines.push(`| ${REPORT_LABELS[action]} | ${items.length} |`);
  }
  lines.push(`| Unchanged (skipped) | ${skipCount} |`);
  lines.push('');

  for (const action of REPORT_ORDER) {
    const items = groups.get(action);
    if (!items?.length) continue;
    lines.push(`## ${REPORT_LABELS[action]} (${items.length})`);
    lines.push('');
    for (const p of items) lines.push(`- ${p}`);
    lines.push('');
  }

  appendWarnings(lines, warnings);
  writeFileSync(reportPath, lines.join('\n'), 'utf-8');
  return reportPath;
}

function appendWarnings(lines: string[], warnings: { path: RelPath; reasons: string[] }[]): void {
  if (warnings.length === 0) return;
  lines.push(`## ⚠ Suspicious Uploads (${warnings.length})`);
  lines.push('');
  lines.push('Files marked for upload but previously synced per metadata:');
  lines.push('');
  for (const { path, reasons } of warnings) {
    lines.push(`- **${path}**`);
    for (const r of reasons) lines.push(`  - ${r}`);
  }
  lines.push('');
}
