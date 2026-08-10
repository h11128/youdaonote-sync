/**
 * diagnose purge-inactive — remove files-table rows outside active sync snaps.
 *
 * Always resets the cloud scan cache so cleanup uses a full cloudSnap (cached
 * snaps echo existing file_id rows and would hide orphans).
 * Dry-run copies metadata to a temp DB so collectItems cannot write production.
 */
import { copyFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SyncEngine } from '../engine/engine.js';
import { MetadataStore } from '../metadata/store.js';
import { cleanupStalePaths, listInactiveFilePaths } from '../engine/helpers.js';
import { initXxhash } from '../algo/hash.js';
import type { DiagnoseConfig } from './diagnose.js';

function createEngine(cfg: DiagnoseConfig, metadataPath: string): SyncEngine {
  return new SyncEngine({
    cookiesPath: cfg.cookiesPath,
    metadataPath,
    localDir: cfg.localDir,
    dryRun: true,
    ...(cfg.syncExclude !== undefined ? { syncExclude: cfg.syncExclude } : {}),
    ...(cfg.syncInclude !== undefined ? { syncInclude: cfg.syncInclude } : {}),
  });
}

function countEmptyFileId(meta: MetadataStore): number {
  let n = 0;
  for (const [, rec] of meta.getAllFiles()) {
    if (!rec.fileId) n++;
  }
  return n;
}

/** Force next cloud obtainSnapshots path to full-scan (no file_id echo cache). */
function resetScanCache(metadataPath: string): void {
  const meta = new MetadataStore(metadataPath);
  meta.setState('last_cloud_version', '0');
  meta.setState('last_scan_time', '0');
  meta.close();
}

export async function cmdPurgeInactive(cfg: DiagnoseConfig, dryRun: boolean): Promise<void> {
  await initXxhash();

  let metadataPath = cfg.metadataPath;
  let tmpPath: string | undefined;
  if (dryRun) {
    tmpPath = join(tmpdir(), `youdao-purge-dry-${Date.now()}.db`);
    copyFileSync(cfg.metadataPath, tmpPath);
    metadataPath = tmpPath;
  }

  resetScanCache(metadataPath);

  try {
    const engine = createEngine(cfg, metadataPath);
    const { cloudSnap, localSnap } = await engine.collectItems();
    engine.close();

    const meta = new MetadataStore(metadataPath);
    const before = meta.getAllFiles().size;
    const emptyBefore = countEmptyFileId(meta);
    const inactive = listInactiveFilePaths(meta, cloudSnap, localSnap);
    let removed = inactive.length;
    if (!dryRun) {
      removed = cleanupStalePaths(meta, cloudSnap, localSnap);
      meta.save();
    }

    console.log('='.repeat(60));
    console.log('  Purge inactive files-table rows' + (dryRun ? ' (dry-run)' : ''));
    console.log('='.repeat(60));
    console.log(`  Files before:            ${before}`);
    console.log(`  Empty file_id before:    ${emptyBefore}`);
    console.log(`  Would remove / removed:  ${removed}`);
    if (!dryRun) {
      console.log(`  Files after:             ${meta.getAllFiles().size}`);
      console.log(`  Empty file_id after:     ${countEmptyFileId(meta)}`);
    }
    meta.close();
  } finally {
    if (tmpPath) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
  }
}
