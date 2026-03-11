import type { ContentHash, FileId, RelPath } from './types/common.js';
import type { CloudFile } from './types/scan.js';
import type { FileState } from './types/state.js';
import type { MetadataStore } from './metadata/store.js';
import { refineCloudModified } from './classify/refine.js';
import { retryWithBackoff } from './api/retry.js';
import { collectConflictCandidates, applyRefinementIfChanged } from './engine-helpers.js';

export interface RefineAllDeps {
  classified: Map<RelPath, FileState>;
  cloudSnap: ReadonlyMap<RelPath, CloudFile>;
  localHashes: ReadonlyMap<RelPath, ContentHash | null>;
  hashFn: (data: Uint8Array, path: string) => ContentHash | null;
  meta: MetadataStore;
  api: { getFileById(fileId: FileId): Promise<ArrayBuffer> };
}

async function getCloudHash(
  deps: RefineAllDeps,
  relPath: RelPath,
  cloudFile: CloudFile,
): Promise<ContentHash | null> {
  const cached = deps.meta.getFileInfo(relPath);
  if (cached?.cloudContentHash && cached.cloudMtime === cloudFile.mtime) {
    return cached.cloudContentHash;
  }
  const raw = await retryWithBackoff(() => deps.api.getFileById(cloudFile.id as FileId));
  return deps.hashFn(new Uint8Array(raw), relPath);
}

/**
 * For cloudModifiedContent and conflict entries, download cloud content,
 * compute hash, and use refineCloudModified to potentially downgrade.
 */
export async function refineAllConflicts(deps: RefineAllDeps): Promise<void> {
  const candidates = collectConflictCandidates(deps.classified, deps.cloudSnap);
  if (candidates.length === 0) return;

  for (const { relPath, cloudFile } of candidates) {
    try {
      const cloudHash = await getCloudHash(deps, relPath, cloudFile);
      if (!cloudHash) continue;
      const localHash = deps.localHashes.get(relPath);
      if (!localHash) continue;

      const metaRecord = deps.meta.getFileInfo(relPath);
      const refined = refineCloudModified(localHash, cloudHash, metaRecord);
      applyRefinementIfChanged(relPath, refined, deps.classified);
      deps.meta.setCloudContentHash(relPath, cloudHash);
    } catch {
      // keep original classification on failure
    }
  }
}
