export { buildTree, diffTrees } from './merkle.js';
export type { TreeHash, HashFn } from './merkle.js';
export { BloomFilter } from './bloom.js';
export { threeWayMerge } from './merge.js';
export type { MergeResult } from './merge.js';
export { computeBlockHashes, diffBlocks, encodeDelta, applyDelta } from './block-hash.js';
export type { BlockHashEntry, ChangedBlock } from './block-hash.js';
export {
  initXxhash,
  xxh128,
  xxh64ToString,
  xxh64Raw,
  xxh32ToString,
  isXxhashReady,
} from './xxhash.js';
export {
  computeContentHashFromBytes,
  computeContentHashFromFile,
  computeContentHashFromFileAsync,
  computeHashesConcurrent,
} from './hash.js';
export type { HashFileEntry, HashCacheLookup, HashConcurrentResult } from './hash.js';
