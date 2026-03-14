export { SyncEngine } from './engine.js';
export type { SyncEngineConfig, SyncResult } from './engine.js';
export { SyncWatcher } from './watcher.js';
export { createCli } from './cli.js';
export { gitAutoCommit, gitInit } from './git.js';
export { findDuplicates, removeDuplicateMetadata } from './dedup/index.js';
export {
  computeContentHashFromBytes,
  computeContentHashFromFile,
  computeContentHashFromFileAsync,
  computeHashesConcurrent,
} from './hash.js';

// Algorithm modules
export * from './algo/index.js';

// Re-export core modules
export * from './types/index.js';
export * from './classify/index.js';
export * from './metadata/index.js';
export * from './scan/index.js';
export * from './api/index.js';
export * from './execute/index.js';
export * from './convert/index.js';
