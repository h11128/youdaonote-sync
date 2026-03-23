import type { YoudaoNoteApi } from '../api/client.js';
import type { MetadataStore } from '../metadata/store.js';
import type { ContentHash, DirId, FileId, NoteDomain, RelPath } from '../types/common.js';

export interface FailedFile {
  path: RelPath;
  action: string;
  error: string;
}

export interface SyncStats {
  downloaded: number;
  uploaded: number;
  skipped: number;
  conflicts: number;
  errors: number;
  moved: number;
  merged: number;
  deletedCloud: number;
  deletedLocal: number;
  readonly changedPaths: string[];
  readonly failedFiles: FailedFile[];
  readonly failedMoves: {
    oldPath: RelPath;
    newPath: RelPath;
    fileId: FileId;
    domain: NoteDomain;
  }[];
  readonly uploadedPaths: Set<RelPath>;
}

export function emptyStats(): SyncStats {
  return {
    downloaded: 0,
    uploaded: 0,
    skipped: 0,
    conflicts: 0,
    errors: 0,
    moved: 0,
    merged: 0,
    deletedCloud: 0,
    deletedLocal: 0,
    changedPaths: [],
    failedFiles: [],
    failedMoves: [],
    uploadedPaths: new Set<RelPath>(),
  };
}

export interface ExecuteContext {
  api: YoudaoNoteApi;
  meta: MetadataStore;
  rootDirId: DirId;
  localDir: string;
  hashFn?: (data: Uint8Array, path: string) => ContentHash | null;
  /** Per-session dedup map for concurrent directory creation. */
  dirCreateInflight?: Map<string, Promise<DirId>> | undefined;
  /** Local snapshot — used to detect directories when cloud entry is missing. */
  localSnap?: ReadonlyMap<RelPath, { isDir: boolean }> | undefined;
}
