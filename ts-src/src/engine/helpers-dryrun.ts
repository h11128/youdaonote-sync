import { join } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import type { RelPath } from '../types/common.js';
import type { FileState } from '../types/state.js';
import { stateToAction, type SyncAction } from '../types/state.js';

const REPORT_ORDER: SyncAction[] = ['download', 'upload', 'conflict', 'move'];
const REPORT_LABELS: Record<string, string> = {
  download: '↓ Download',
  upload: '↑ Upload',
  conflict: '⚡ Conflict',
  move: '→ Move',
};

export function groupByAction(classified: Map<RelPath, FileState>): Map<SyncAction, RelPath[]> {
  const groups = new Map<SyncAction, RelPath[]>();
  for (const [path, state] of classified) {
    const action = stateToAction(state);
    let list = groups.get(action);
    if (!list) {
      list = [];
      groups.set(action, list);
    }
    list.push(path);
  }
  return groups;
}

export function writeDryrunReport(
  classified: Map<RelPath, FileState>,
  warnings: { path: RelPath; reasons: string[] }[],
  baseDir: string,
): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '');
  const reportDir = join(baseDir, '.local-reports');
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `dry-run-${dateStr}-${timeStr}.md`);

  const groups = groupByAction(classified);
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

  if (warnings.length > 0) {
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

  writeFileSync(reportPath, lines.join('\n'), 'utf-8');
  return reportPath;
}
