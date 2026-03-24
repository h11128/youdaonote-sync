/**
 * diagnose fix-hashes: recompute content hashes from local files and
 * update metadata records that are out of sync.
 *
 * Only touches the `content_hash` column — does NOT update `last_sync_at`,
 * `local_mtime`, or any other field, so subsequent syncs can still detect
 * genuine local modifications.
 */

import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { asRelPath } from '../types/common.js';
import { MetadataStore } from '../metadata/store.js';
import { initXxhash, computeContentHashFromBytes } from '../algo/hash.js';

export interface FixHashesResult {
  scanned: number;
  mismatched: number;
  fixed: number;
  missing: number;
}

export async function cmdFixHashes(
  metadataPath: string,
  localDir: string,
  opts?: { dryRun?: boolean; filter?: string },
): Promise<FixHashesResult> {
  await initXxhash();

  const dryRun = opts?.dryRun ?? false;
  const filterPrefix = opts?.filter ?? null;

  const meta = new MetadataStore(metadataPath);
  const allFiles = meta.getAllFiles();

  const result: FixHashesResult = { scanned: 0, mismatched: 0, fixed: 0, missing: 0 };

  console.log('='.repeat(60));
  console.log(`  Fix content hashes${dryRun ? ' (dry-run)' : ''}`);
  console.log('='.repeat(60));

  for (const [relPath, record] of allFiles) {
    if (filterPrefix && !relPath.startsWith(filterPrefix)) continue;

    result.scanned++;
    const localPath = join(localDir, relPath);

    if (!existsSync(localPath)) {
      result.missing++;
      continue;
    }

    const content = readFileSync(localPath);
    const newHash = computeContentHashFromBytes(new Uint8Array(content), localPath);
    if (!newHash) continue;

    if (newHash === record.contentHash) continue;

    result.mismatched++;
    console.log(
      `  ${dryRun ? 'WOULD FIX' : 'FIX'}  ${relPath}: ${record.contentHash ?? '(null)'} → ${newHash}`,
    );

    if (!dryRun) {
      meta.updateContentHash(asRelPath(relPath), newHash);
      result.fixed++;
    }
  }

  meta.close();

  console.log('');
  console.log(`  Scanned:    ${result.scanned}`);
  console.log(`  Missing:    ${result.missing} (local file not found)`);
  console.log(`  Mismatched: ${result.mismatched}`);
  console.log(`  Fixed:      ${result.fixed}`);

  return result;
}
