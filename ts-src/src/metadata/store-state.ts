/**
 * Re-exports sync_state, sync_log, and file_base helpers.
 * Implementation split into store-state-kv, store-sync-log, store-file-base for single responsibility.
 */
export type { NormalizePath } from './store-sync-log.js';
export { getState, setState, getStateInt } from './store-state-kv.js';
export { getSyncLog, deleteSyncLogBefore, insertSyncLog } from './store-sync-log.js';
export {
  saveBaseContent,
  getBaseContent,
  removeBaseContent,
  getAllBaseContentPaths,
  getFileRefs,
  setFileRefs,
  getAllFileRefs,
} from './store-file-base.js';
