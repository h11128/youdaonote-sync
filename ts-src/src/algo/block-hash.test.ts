import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeBlockHashes, diffBlocks, encodeDelta, applyDelta } from './block-hash.js';

const TMP = join(tmpdir(), 'block-hash-test-' + Date.now());

beforeEach(() => mkdirSync(TMP, { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe('computeBlockHashes', () => {
  it('returns blocks for a file', () => {
    const p = join(TMP, 'test.bin');
    writeFileSync(p, Buffer.alloc(8192, 0x41)); // 8KB of 'A'
    const blocks = computeBlockHashes(p);
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.offset).toBe(0);
    expect(blocks[0]!.length).toBe(4096);
    expect(blocks[1]!.offset).toBe(4096);
  });

  it('handles empty file', () => {
    const p = join(TMP, 'empty.bin');
    writeFileSync(p, '');
    expect(computeBlockHashes(p)).toHaveLength(0);
  });

  it('rejects invalid blockSize', () => {
    expect(() => computeBlockHashes('x', 0)).toThrow();
  });
});

describe('diffBlocks', () => {
  it('detects changed, added, and removed blocks', () => {
    const old = [
      { offset: 0, length: 4096, hash: 'aaa' },
      { offset: 4096, length: 4096, hash: 'bbb' },
    ];
    const cur = [
      { offset: 0, length: 4096, hash: 'aaa' },
      { offset: 4096, length: 4096, hash: 'ccc' },
      { offset: 8192, length: 2048, hash: 'ddd' },
    ];
    const result = diffBlocks(old, cur);
    expect(result).toHaveLength(2);
    expect(result[0]!.blockType).toBe('changed');
    expect(result[1]!.blockType).toBe('added');
  });
});

describe('encodeDelta + applyDelta', () => {
  it('round-trips through delta encoding', () => {
    const oldPath = join(TMP, 'old.bin');
    const newPath = join(TMP, 'new.bin');
    const oldContent = Buffer.from('A'.repeat(4096) + 'B'.repeat(4096));
    const newContent = Buffer.from('A'.repeat(4096) + 'C'.repeat(4096));
    writeFileSync(oldPath, oldContent);
    writeFileSync(newPath, newContent);

    const delta = encodeDelta(oldPath, newPath);
    const result = applyDelta(oldPath, delta);
    expect(Buffer.compare(result, newContent)).toBe(0);
  });
});
