export type { DedupStats, FileDeleter, DedupAction } from './types.js';
export { emptyDedupStats, isAsset, ASSET_EXTS } from './types.js';
export { buildRefIndex } from './refs.js';
export { buildHashIndex, type BuildIndexOpts } from './hash-index.js';
export { classifyDuplicates, resolveGroup, type ResolveGroupOpts } from './resolve.js';
export { autoDedup, type DedupResult } from './execute.js';
export { discardOrphanDuplicates } from './orphan.js';
export { findDuplicates, removeDuplicateMetadata } from './compat.js';
