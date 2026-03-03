import { xxh64Raw } from './xxhash.js';

const MAX_BITS = 2 ** 31 - 1;
const encoder = new TextEncoder();

function optimalM(n: number, p: number): number {
  return Math.min(MAX_BITS, Math.max(1, Math.floor(-n * Math.log(p) / (Math.log(2) ** 2))));
}

function optimalK(m: number, n: number): number {
  return Math.max(1, Math.floor(m * Math.log(2) / n));
}

function hash64(data: string, seed: bigint): bigint {
  return xxh64Raw(encoder.encode(data), seed);
}

/**
 * Space-efficient probabilistic set for membership testing.
 *
 * Uses Kirsch–Mitzenmacher double-hash technique.
 * False positives possible; false negatives are not.
 */
export class BloomFilter {
  private m: number;
  private k: number;
  private bits: Uint8Array;

  constructor(expectedItems: number, fpRate = 0.01) {
    if (expectedItems < 1) throw new Error(`expectedItems must be >= 1, got ${expectedItems}`);
    if (fpRate <= 0 || fpRate >= 1) throw new Error(`fpRate must be in (0, 1), got ${fpRate}`);
    const n = expectedItems;
    this.m = optimalM(n, fpRate);
    this.k = Math.min(optimalK(this.m, n), this.m);
    this.bits = new Uint8Array(Math.ceil(this.m / 8));
  }

  private hashes(item: string): number[] {
    const h1 = hash64(item, 0n);
    const h2 = hash64(item, 0x9e3779b97f4a7c15n);
    const result: number[] = [];
    const bigM = BigInt(this.m);
    for (let i = 0; i < this.k; i++) {
      result.push(Number((h1 + BigInt(i) * h2) % bigM));
    }
    return result;
  }

  add(item: string): void {
    for (const pos of this.hashes(item)) {
      this.bits[Math.floor(pos / 8)]! |= 1 << (pos % 8);
    }
  }

  mightContain(item: string): boolean {
    for (const pos of this.hashes(item)) {
      if (!(this.bits[Math.floor(pos / 8)]! & (1 << (pos % 8)))) return false;
    }
    return true;
  }

  serialize(): Buffer {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(this.m, 0);
    header.writeUInt32LE(this.k, 4);
    return Buffer.concat([header, Buffer.from(this.bits)]);
  }

  /** @internal Construct with pre-computed params (used by deserialize). */
  private static fromRaw(m: number, k: number, bits: Uint8Array): BloomFilter {
    const bf = new BloomFilter(1);
    bf.m = m;
    bf.k = k;
    bf.bits = bits;
    return bf;
  }

  static deserialize(data: Buffer): BloomFilter {
    if (data.length < 8) throw new Error(`Bloom filter data too short: ${data.length} bytes`);
    const m = data.readUInt32LE(0);
    const k = data.readUInt32LE(4);
    if (m < 1 || k < 1) throw new Error(`Invalid Bloom filter params: m=${m}, k=${k}`);
    const expectedBytes = Math.ceil(m / 8);
    if (data.length - 8 !== expectedBytes) {
      throw new Error(`Bloom filter size mismatch: got ${data.length - 8}, expected ${expectedBytes}`);
    }
    return BloomFilter.fromRaw(m, k, new Uint8Array(data.subarray(8)));
  }
}
