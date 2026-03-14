import { describe, it, expect } from 'vitest';
import { analyzeProfileData, type HotFunction } from './analyzer.js';

function makeProfile(
  nodeCount: number,
  samplePattern: number[],
  delta = 100,
): {
  nodes: {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
    children: number[];
    hitCount: number;
  }[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  endTime: number;
} {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: i,
    callFrame: {
      functionName: i === 0 ? '(root)' : `fn${i}`,
      url: i === 0 ? '' : `src/mod${i}.ts`,
      lineNumber: i * 10,
      columnNumber: 0,
    },
    children: [] as number[],
    hitCount: 0,
  }));
  const timeDeltas = samplePattern.map(() => delta);
  return {
    nodes,
    samples: samplePattern,
    timeDeltas,
    startTime: 0,
    endTime: samplePattern.length * delta,
  };
}

describe('analyzeProfileData', () => {
  it('returns empty array for profile with no samples', () => {
    const result = analyzeProfileData(makeProfile(2, []), 10);
    expect(result).toEqual([]);
  });

  it('correctly attributes self-time to nodes', () => {
    // Node 1 appears 3 times, node 2 appears 1 time; delta = 100µs each
    const result = analyzeProfileData(makeProfile(3, [1, 1, 2, 1]), 10);

    const fn1 = result.find((h: HotFunction) => h.fn === 'fn1');
    const fn2 = result.find((h: HotFunction) => h.fn === 'fn2');
    expect(fn1).toBeDefined();
    expect(fn2).toBeDefined();
    expect(fn1!.selfTimeUs).toBe(300);
    expect(fn2!.selfTimeUs).toBe(100);
  });

  it('sorts by self-time descending', () => {
    const result = analyzeProfileData(makeProfile(3, [2, 2, 2, 1]), 10);
    expect(result[0]!.fn).toBe('fn2');
    expect(result[1]!.fn).toBe('fn1');
  });

  it('respects topN limit', () => {
    const result = analyzeProfileData(makeProfile(5, [1, 2, 3, 4]), 2);
    expect(result.length).toBe(2);
  });

  it('calculates percentage correctly', () => {
    // 4 samples × 100µs = 400µs total; node 1 has 3 samples = 75%
    const result = analyzeProfileData(makeProfile(3, [1, 1, 1, 2]), 10);
    const fn1 = result.find((h: HotFunction) => h.fn === 'fn1');
    expect(fn1!.pct).toBeCloseTo(75.0, 1);
  });

  it('handles missing node IDs gracefully', () => {
    // Sample references node 99 which doesn't exist
    const profile = makeProfile(2, [1, 99, 1]);
    const result = analyzeProfileData(profile, 10);
    // Node 99 should be skipped (no matching node), only fn1 appears
    const fn1 = result.find((h: HotFunction) => h.fn === 'fn1');
    expect(fn1).toBeDefined();
    expect(fn1!.selfTimeUs).toBe(200);
  });
});
