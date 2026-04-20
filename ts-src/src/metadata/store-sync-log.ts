import type Database from 'better-sqlite3';
import { asEpochSeconds, asRelPath, type EpochSeconds, type RelPath } from '../types/common.js';

export type NormalizePath = (localPath: RelPath) => string;

/**
 * sync_log table. Single responsibility: sync log read/write.
 */
export function getSyncLog(
  db: Database.Database,
  opts: { limit?: number; path?: RelPath } | undefined,
  normalizePath: NormalizePath,
): {
  id: number;
  timestamp: EpochSeconds;
  path: RelPath;
  action: string;
  direction: string | null;
  oldHash: string | null;
  newHash: string | null;
  cloudId: string | null;
  detail: string | null;
  decisionReason: string | null;
  policyVersion: string | null;
  guardrailChecks: string | null;
}[] {
  let sql =
    'SELECT id, timestamp, path, action, direction, old_hash, new_hash, cloud_id, detail, decision_reason, policy_version, guardrail_checks FROM sync_log';
  const params: unknown[] = [];
  if (opts?.path) {
    sql += ' WHERE path = ?';
    params.push(normalizePath(opts.path));
  }
  sql += ' ORDER BY id DESC';
  if (opts?.limit) {
    sql += ' LIMIT ?';
    params.push(opts.limit);
  }
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number,
    timestamp: asEpochSeconds(r.timestamp as number),
    path: asRelPath(r.path as string),
    action: r.action as string,
    direction: (r.direction as string) || null,
    oldHash: (r.old_hash as string) || null,
    newHash: (r.new_hash as string) || null,
    cloudId: (r.cloud_id as string) || null,
    detail: (r.detail as string) || null,
    decisionReason: (r.decision_reason as string) || null,
    policyVersion: (r.policy_version as string) || null,
    guardrailChecks: (r.guardrail_checks as string) || null,
  }));
}

export function deleteSyncLogBefore(db: Database.Database, cutoffTs: number): number {
  return db.prepare('DELETE FROM sync_log WHERE timestamp < ?').run(cutoffTs).changes;
}

export function insertSyncLog(
  db: Database.Database,
  row: {
    timestamp: number;
    path: string;
    action: string;
    direction: string | null;
    oldHash: string | null;
    newHash: string | null;
    cloudId: string | null;
    detail: string | null;
    decisionReason?: string | null;
    policyVersion?: string | null;
    guardrailChecks?: string | null;
  },
): void {
  db.prepare(
    'INSERT INTO sync_log (timestamp, path, action, direction, old_hash, new_hash, cloud_id, detail, decision_reason, policy_version, guardrail_checks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.timestamp,
    row.path,
    row.action,
    row.direction,
    row.oldHash,
    row.newHash,
    row.cloudId,
    row.detail,
    row.decisionReason ?? null,
    row.policyVersion ?? null,
    row.guardrailChecks ?? null,
  );
}
