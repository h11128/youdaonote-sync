import type { MetadataStore } from './metadata/store.js';
import type { FileState } from './types/state.js';
import { stateToAction } from './types/state.js';
import { emptyStats, type SyncStats } from './execute/executor.js';

function collectUploadWarnings(
  classified: Map<string, FileState>,
  meta: MetadataStore,
): { path: string; reasons: string[] }[] {
  const warnings: { path: string; reasons: string[] }[] = [];
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

function printUploadWarnings(warnings: { path: string; reasons: string[] }[]): void {
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

/**
 * Diagnose suspicious UPLOADs in dry-run results (matches Python diagnose_dryrun).
 * Warns when a file marked for upload has metadata suggesting it was previously synced.
 */
export function diagnoseDryrun(classified: Map<string, FileState>, meta: MetadataStore): void {
  const warnings = collectUploadWarnings(classified, meta);
  if (warnings.length === 0) return;
  printUploadWarnings(warnings);
}

export function dryRunStats(classified: Map<string, FileState>): SyncStats {
  const stats = emptyStats();
  for (const state of classified.values()) {
    const action = stateToAction(state);
    switch (action) {
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
