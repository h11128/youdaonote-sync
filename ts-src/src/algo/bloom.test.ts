import { describe, it, expect } from 'vitest';
import { BloomFilter } from './bloom.js';

describe('BloomFilter', () => {
  it('reports added items as possibly present', () => {
    const bf = new BloomFilter(100);
    bf.add('hello');
    bf.add('world');
    expect(bf.mightContain('hello')).toBe(true);
    expect(bf.mightContain('world')).toBe(true);
  });

  it('reports absent items as not present (with high probability)', () => {
    const bf = new BloomFilter(100, 0.001);
    bf.add('alpha');
    bf.add('beta');
    let falsePositives = 0;
    for (let i = 0; i < 1000; i++) {
      if (bf.mightContain(`nonexistent_${i}`)) falsePositives++;
    }
    expect(falsePositives).toBeLessThan(50);
  });

  it('serializes and deserializes correctly', () => {
    const bf = new BloomFilter(50);
    bf.add('test1');
    bf.add('test2');
    const data = bf.serialize();
    const restored = BloomFilter.deserialize(data);
    expect(restored.mightContain('test1')).toBe(true);
    expect(restored.mightContain('test2')).toBe(true);
  });

  it('rejects invalid deserialization data', () => {
    expect(() => BloomFilter.deserialize(Buffer.alloc(4))).toThrow();
  });

  it('rejects invalid fp_rate', () => {
    expect(() => new BloomFilter(10, 0)).toThrow();
    expect(() => new BloomFilter(10, 1)).toThrow();
  });
});
