import type { ContentHash, SyncDirection } from './common.js';
import type { YoudaoNoteApi } from '../api/client.js';
import type { MetadataStore } from '../metadata/store.js';
import type { SyncProfiler } from '../perf/profiler.js';

export interface SyncEngineConfig {
  cookiesPath: string;
  metadataPath: string;
  localDir: string;
  syncInclude?: string[] | undefined;
  syncExclude?: string[] | undefined;
  dryRun?: boolean | undefined;
  direction?: SyncDirection | undefined;
  autoGit?: boolean | undefined;
  autoDedup?: boolean | undefined;
  propagateDeletes?: boolean | undefined;
  /** Max deletes allowed per sync session. Defaults to 5. */
  maxDeletesPerSync?: number | undefined;
  hashFn?: ((data: Uint8Array, path: string) => ContentHash | null) | undefined;
  /** Optional: inject for testing; otherwise created from cookiesPath/metadataPath. */
  api?: YoudaoNoteApi;
  /** Optional: inject for testing; otherwise created from metadataPath. */
  meta?: MetadataStore;
  /** Optional: attach a profiler to record per-phase timing. */
  profiler?: SyncProfiler | undefined;
}
