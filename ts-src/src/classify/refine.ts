import type { ContentHash } from '../types/common.js';
import type { FileState } from '../types/state.js';
import type { MetadataRecord } from '../types/metadata.js';
import type { RefineConditions } from './rules.js';
import { REFINE_RULES } from './rules.js';
import { matchesRule } from './classify.js';

/**
 * Second-pass classification for files initially classified as 'cloudModifiedContent'.
 * After downloading the cloud file and computing its hash, we can distinguish:
 *   - cloudModifiedMtimeOnly: cloud mtime changed but content identical to local
 *   - bothModifiedConverged: both sides changed but arrived at the same content
 *   - localModified: cloud content same as last sync, only local changed
 *   - conflict: both sides changed to different content
 */
export function refineCloudModified(
  localHash: ContentHash,
  cloudHash: ContentHash,
  meta: MetadataRecord | null,
): FileState {
  const cond: RefineConditions = {
    cloudHashEqualLocal: cloudHash === localHash,
    localHashChanged: meta?.contentHash != null ? localHash !== meta.contentHash : false,
    cloudHashEqualMeta:
      meta?.cloudContentHash != null ? cloudHash === meta.cloudContentHash : false,
  };

  for (const rule of REFINE_RULES) {
    if (matchesRule(cond, rule.when)) {
      const matched = { kind: rule.then };
      return matched as FileState;
    }
  }
  throw new Error(`No refine rule matched: ${JSON.stringify(cond)}`);
}
