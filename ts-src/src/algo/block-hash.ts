import { readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { xxh64Raw } from './xxhash.js';

export interface BlockHashEntry {
  readonly offset: number;
  readonly length: number;
  readonly hash: string;
}

export interface ChangedBlock {
  readonly offset: number;
  readonly length: number;
  readonly blockType: 'added' | 'removed' | 'changed';
}

const DEFAULT_BLOCK_SIZE = 4096;

/**
 * Compute fixed-size block hashes for a file.
 */
export function computeBlockHashes(
  filePath: string,
  blockSize = DEFAULT_BLOCK_SIZE,
): BlockHashEntry[] {
  if (blockSize < 1) throw new Error(`blockSize must be positive, got ${blockSize}`);
  const result: BlockHashEntry[] = [];
  const fd = openSync(filePath, 'r');
  const chunk = Buffer.alloc(blockSize);
  let offset = 0;

  try {
    let bytesRead: number;
    while ((bytesRead = readSync(fd, chunk, 0, blockSize, null)) > 0) {
      const hash = xxh64Raw(chunk.subarray(0, bytesRead)).toString(16).padStart(16, '0');
      result.push({ offset, length: bytesRead, hash });
      offset += bytesRead;
    }
  } finally {
    closeSync(fd);
  }

  return result;
}

function classifyBlockAt(
  i: number,
  oldHashes: BlockHashEntry[],
  newHashes: BlockHashEntry[],
): ChangedBlock | null {
  if (i >= oldHashes.length) {
    const nb = newHashes[i];
    if (nb === undefined) throw new Error(`unreachable: newHashes[${i}]`);
    return { offset: nb.offset, length: nb.length, blockType: 'added' };
  }
  if (i >= newHashes.length) {
    const ob = oldHashes[i];
    if (ob === undefined) throw new Error(`unreachable: oldHashes[${i}]`);
    return { offset: ob.offset, length: ob.length, blockType: 'removed' };
  }
  const ob = oldHashes[i];
  const nb = newHashes[i];
  if (ob === undefined || nb === undefined) throw new Error(`unreachable: index ${i}`);
  if (ob.hash !== nb.hash) {
    return { offset: nb.offset, length: nb.length, blockType: 'changed' };
  }
  return null;
}

/**
 * Compare two block hash lists and return changed blocks.
 */
export function diffBlocks(
  oldHashes: BlockHashEntry[],
  newHashes: BlockHashEntry[],
): ChangedBlock[] {
  const result: ChangedBlock[] = [];
  const maxLen = Math.max(oldHashes.length, newHashes.length);
  for (let i = 0; i < maxLen; i++) {
    const block = classifyBlockAt(i, oldHashes, newHashes);
    if (block) result.push(block);
  }
  return result;
}

/**
 * Encode a delta between two files using block-level comparison.
 * Delta format: sequence of COPY (op=0, offset, length) and INSERT (op=1, length, data) ops.
 */
export function encodeDelta(
  oldPath: string,
  newPath: string,
  blockSize = DEFAULT_BLOCK_SIZE,
): Buffer {
  const oldHashes = computeBlockHashes(oldPath, blockSize);
  const newHashes = computeBlockHashes(newPath, blockSize);
  const newData = readFileSync(newPath);
  const parts: Buffer[] = [];

  for (let i = 0; i < newHashes.length; i++) {
    const nb = newHashes[i];
    if (nb === undefined) throw new Error(`unreachable: newHashes[${i}]`);
    const newBlock = newData.subarray(nb.offset, nb.offset + nb.length);

    const ob = oldHashes[i];
    if (i < oldHashes.length && ob?.hash === nb.hash) {
      const header = Buffer.alloc(9);
      header.writeUInt8(0, 0);
      header.writeUInt32LE(ob.offset, 1);
      header.writeUInt32LE(nb.length, 5);
      parts.push(header);
    } else {
      const header = Buffer.alloc(5);
      header.writeUInt8(1, 0);
      header.writeUInt32LE(nb.length, 1);
      parts.push(header, newBlock);
    }
  }

  return Buffer.concat(parts);
}

function applyCopyOp(
  oldData: Buffer,
  delta: Buffer,
  pos: number,
): { parts: Buffer; newPos: number } {
  if (pos + 8 > delta.length) throw new Error(`Delta truncated at COPY op (pos=${pos})`);
  const offset = delta.readUInt32LE(pos);
  const length = delta.readUInt32LE(pos + 4);
  if (offset + length > oldData.length) {
    throw new Error(
      `COPY out of range: offset=${offset} length=${length} old_size=${oldData.length}`,
    );
  }
  return { parts: oldData.subarray(offset, offset + length), newPos: pos + 8 };
}

function applyInsertOp(delta: Buffer, pos: number): { parts: Buffer; newPos: number } {
  if (pos + 4 > delta.length) throw new Error(`Delta truncated at INSERT op (pos=${pos})`);
  const length = delta.readUInt32LE(pos);
  if (pos + 4 + length > delta.length) {
    throw new Error(`INSERT out of range: pos=${pos} length=${length} delta_size=${delta.length}`);
  }
  return { parts: delta.subarray(pos + 4, pos + 4 + length), newPos: pos + 4 + length };
}

/**
 * Apply a delta to an old file's content to produce the new content.
 */
export function applyDelta(oldPath: string, delta: Buffer): Buffer {
  const oldData = readFileSync(oldPath);
  const parts: Buffer[] = [];
  let pos = 0;

  while (pos < delta.length) {
    const opByte = delta[pos];
    if (opByte === undefined) throw new Error(`Delta truncated at pos=${pos}`);
    pos++;

    if (opByte === 0) {
      const { parts: copyParts, newPos } = applyCopyOp(oldData, delta, pos);
      parts.push(copyParts);
      pos = newPos;
    } else if (opByte === 1) {
      const { parts: insertParts, newPos } = applyInsertOp(delta, pos);
      parts.push(insertParts);
      pos = newPos;
    } else {
      throw new Error(`Unknown delta op: ${opByte} at pos=${pos - 1}`);
    }
  }

  return Buffer.concat(parts);
}
