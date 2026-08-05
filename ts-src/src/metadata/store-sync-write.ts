/**
 * Sync write helpers for MetadataStore (recordSync / appendSyncLog).
 */
import type Database from 'better-sqlite3';
import {
  asEpochSeconds,
  type ContentHash,
  type DirId,
  type EpochSeconds,
  type FileId,
  type NoteDomain,
  type RelPath,
} from '../types/common.js';
import * as storeFiles from './store-files.js';
import * as storeState from './store-state.js';

export interface RecordSyncOpts {
  fileId: FileId;
  cloudMtime: EpochSeconds;
  localMtime: EpochSeconds;
  parentId?: DirId | null;
  domain?: NoteDomain | null;
  contentHash?: ContentHash | null;
  cloudContentHash?: ContentHash | null;
  originalDomain?: NoteDomain | null;
  createTime?: EpochSeconds | null;
  action?: string;
  direction?: string;
  oldHash?: ContentHash | null;
  detail?: string;
  decisionReason?: string | null;
  policyVersion?: string | null;
  guardrailChecks?: string | null;
}

export interface AppendSyncLogOpts {
  action: string;
  direction?: string;
  cloudId?: string | null;
  detail?: string;
  decisionReason?: string | null;
  policyVersion?: string | null;
  guardrailChecks?: string | null;
}

export function recordSync(db: Database.Database, path: RelPath, opts: RecordSyncOpts): void {
  const now = asEpochSeconds(Math.floor(Date.now() / 1000));
  const txn = db.transaction(() => {
    storeFiles.upsertFile(db, path, { ...opts, lastSyncAt: now });
    if (opts.originalDomain != null) {
      storeFiles.updateOriginalDomain(db, path, opts.originalDomain);
    }
    if (opts.action) {
      storeState.insertSyncLog(db, {
        timestamp: now,
        path,
        action: opts.action,
        direction: opts.direction ?? null,
        oldHash: opts.oldHash ?? null,
        newHash: opts.contentHash ?? null,
        cloudId: opts.fileId,
        detail: opts.detail ?? null,
        decisionReason: opts.decisionReason ?? null,
        policyVersion: opts.policyVersion ?? null,
        guardrailChecks: opts.guardrailChecks ?? null,
      });
    }
  });
  txn();
}

/** Sync log only — must not upsert `files` (dirs live in `dirs`). */
export function appendSyncLog(db: Database.Database, path: RelPath, opts: AppendSyncLogOpts): void {
  const now = asEpochSeconds(Math.floor(Date.now() / 1000));
  storeState.insertSyncLog(db, {
    timestamp: now,
    path,
    action: opts.action,
    direction: opts.direction ?? null,
    oldHash: null,
    newHash: null,
    cloudId: opts.cloudId ?? null,
    detail: opts.detail ?? null,
    decisionReason: opts.decisionReason ?? null,
    policyVersion: opts.policyVersion ?? null,
    guardrailChecks: opts.guardrailChecks ?? null,
  });
}
