import { readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';

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
export function computeBlockHashes(filePath: string, blockSize = DEFAULT_BLOCK_SIZE): BlockHashEntry[] {
  if (blockSize < 1) throw new Error(`blockSize must be positive, got ${blockSize}`);
  const result: BlockHashEntry[] = [];
  const fd = openSync(filePath, 'r');
  const chunk = Buffer.alloc(blockSize);
  let offset = 0;

  try {
    let bytesRead: number;
    while ((bytesRead = readSync(fd, chunk, 0, blockSize, null)) > 0) {
      const hash = createHash('md5').update(chunk.subarray(0, bytesRead)).digest('hex');
      result.push({ offset, length: bytesRead, hash });
      offset += bytesRead;
    }
  } finally {
    closeSync(fd);
  }

  return result;
}

/**
 * Compare two block hash lists and return changed blocks.
 */
export function diffBlocks(oldHashes: BlockHashEntry[], newHashes: BlockHashEntry[]): ChangedBlock[] {
  const result: ChangedBlock[] = [];
  const maxLen = Math.max(oldHashes.length, newHashes.length);

  for (let i = 0; i < maxLen; i++) {
    if (i >= oldHashes.length) {
      const nb = newHashes[i]!;
      result.push({ offset: nb.offset, length: nb.length, blockType: 'added' });
    } else if (i >= newHashes.length) {
      const ob = oldHashes[i]!;
      result.push({ offset: ob.offset, length: ob.length, blockType: 'removed' });
    } else if (oldHashes[i]!.hash !== newHashes[i]!.hash) {
      const nb = newHashes[i]!;
      result.push({ offset: nb.offset, length: nb.length, blockType: 'changed' });
    }
  }

  return result;
}

/**
 * Encode a delta between two files using block-level comparison.
 * Delta format: sequence of COPY (op=0, offset, length) and INSERT (op=1, length, data) ops.
 */
export function encodeDelta(oldPath: string, newPath: string, blockSize = DEFAULT_BLOCK_SIZE): Buffer {
  const oldHashes = computeBlockHashes(oldPath, blockSize);
  const newHashes = computeBlockHashes(newPath, blockSize);
  const newData = readFileSync(newPath);
  const parts: Buffer[] = [];

  for (let i = 0; i < newHashes.length; i++) {
    const nb = newHashes[i]!;
    const newBlock = newData.subarray(nb.offset, nb.offset + nb.length);

    if (i < oldHashes.length && oldHashes[i]!.hash === nb.hash) {
      const header = Buffer.alloc(9);
      header.writeUInt8(0, 0);
      header.writeUInt32LE(oldHashes[i]!.offset, 1);
      header.writeUInt32LE(nb.length, 5);
      parts.push(header);
    } else {
      const header = Buffer.alloc(5);
      header.writeUInt8(1, 0);
      header.writeUInt32LE(nb.length, 1);
      parts.push(header, Buffer.from(newBlock));
    }
  }

  return Buffer.concat(parts);
}

/**
 * Apply a delta to an old file's content to produce the new content.
 */
export function applyDelta(oldPath: string, delta: Buffer): Buffer {
  const oldData = readFileSync(oldPath);
  const parts: Buffer[] = [];
  let pos = 0;

  while (pos < delta.length) {
    const op = delta[pos]!;
    pos++;

    if (op === 0) {
      if (pos + 8 > delta.length) throw new Error(`Delta truncated at COPY op (pos=${pos})`);
      const offset = delta.readUInt32LE(pos);
      const length = delta.readUInt32LE(pos + 4);
      pos += 8;
      if (offset + length > oldData.length) {
        throw new Error(`COPY out of range: offset=${offset} length=${length} old_size=${oldData.length}`);
      }
      parts.push(oldData.subarray(offset, offset + length));
    } else if (op === 1) {
      if (pos + 4 > delta.length) throw new Error(`Delta truncated at INSERT op (pos=${pos})`);
      const length = delta.readUInt32LE(pos);
      pos += 4;
      if (pos + length > delta.length) {
        throw new Error(`INSERT out of range: pos=${pos} length=${length} delta_size=${delta.length}`);
      }
      parts.push(delta.subarray(pos, pos + length));
      pos += length;
    } else {
      throw new Error(`Unknown delta op: ${op} at pos=${pos - 1}`);
    }
  }

  return Buffer.concat(parts);
}
