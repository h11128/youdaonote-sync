/**
 * Guardrail helpers for SyncEngine (delete overrides + sync-log stamps).
 */
import type { ContentHash, RelPath } from '../types/common.js';
import type { FileState, SyncLogMetadata } from '../types/state.js';
import { stateToAction } from '../types/state.js';
import type { MetadataStore } from '../metadata/store.js';
import { diagnoseDryrun } from './helpers-dryrun.js';
import { logger } from '../util/logger.js';
import { emptyStats } from '../execute/executor.js';
import type { SyncStats } from '../execute/executor.js';

/** Stamp guardrail check JSON onto every path's sync-log metadata before execute. */
export function stampGuardrailChecks(
  metadata: Map<RelPath, SyncLogMetadata>,
  checks: Record<string, unknown>,
): void {
  const json = JSON.stringify(checks);
  for (const [path, meta] of metadata) {
    metadata.set(path, { ...meta, guardrailChecks: json });
  }
}

/**
 * Build a set of paths that should be treated as delete actions.
 * Used when propagateDeletes is enabled.
 */
export function collectDeleteOverrides(
  classified: ReadonlyMap<RelPath, FileState>,
): Map<RelPath, 'deleteCloud' | 'deleteLocal'> {
  const overrides = new Map<RelPath, 'deleteCloud' | 'deleteLocal'>();
  for (const [path, state] of classified) {
    if (state.kind === 'localDeleted') overrides.set(path, 'deleteCloud');
    else if (state.kind === 'cloudDeleted') overrides.set(path, 'deleteLocal');
  }
  return overrides;
}

export function countCloudLinkedFiles(meta: MetadataStore): number {
  let linked = 0;
  for (const rec of meta.getAllFiles().values()) {
    if (rec.fileId) linked++;
  }
  return linked;
}

export function collectPendingDeletes(
  classified: ReadonlyMap<RelPath, FileState>,
  deleteOverrides?: ReadonlyMap<RelPath, 'deleteCloud' | 'deleteLocal'>,
): RelPath[] {
  const pending: RelPath[] = [];
  for (const [path, state] of classified) {
    const action = deleteOverrides?.get(path) ?? stateToAction(state);
    if (action === 'deleteCloud' || action === 'deleteLocal') pending.push(path);
  }
  return pending;
}

export function suspendForDeleteThreshold(opts: {
  classified: Map<RelPath, FileState>;
  meta: MetadataStore;
  localDir: string;
  localHashes: Map<RelPath, ContentHash | null>;
  deleteOverrides?: ReadonlyMap<RelPath, 'deleteCloud' | 'deleteLocal'> | undefined;
  pendingDeletes: RelPath[];
  maxDeletes: number;
}): {
  stats: SyncStats;
  classified: Map<RelPath, FileState>;
  status: 'suspended';
  reason: string;
  reportPath?: string;
} {
  const reason = 'delete_threshold';
  logger.warn(
    `Threshold exceeded: ${opts.pendingDeletes.length} deletes, limit ${opts.maxDeletes}. ` +
      `Sync suspended to prevent accidental mass deletion.`,
  );
  logger.warn(`=== SYNC SUSPENDED (${reason}) ===`);
  logger.warn(
    `Pending deletes: ${opts.pendingDeletes.length} (limit ${opts.maxDeletes}). Review the preview below.`,
  );
  const reportPath = diagnoseDryrun(opts.classified, opts.meta, {
    reportBaseDir: opts.localDir,
    localHashes: opts.localHashes,
    deleteOverrides: opts.deleteOverrides,
    suspendReason: reason,
    suspendDetail: `${opts.pendingDeletes.length} deletes exceed maxDeletesPerSync=${opts.maxDeletes}`,
  });
  logger.info(
    `If these deletes are intentional, increase 'maxDeletesPerSync' in config.json ` +
      `or re-run with --dry-run after reviewing the report.`,
  );
  return {
    stats: Object.freeze(emptyStats()),
    classified: opts.classified,
    status: 'suspended',
    reason,
    ...(reportPath !== undefined ? { reportPath } : {}),
  };
}
