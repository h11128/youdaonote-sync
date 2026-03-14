/**
 * CPU profile analyzer — parse .cpuprofile (V8 format) and extract hot functions.
 *
 * The .cpuprofile file can also be loaded in Chrome DevTools for flame graph inspection.
 * This module provides a quick terminal summary without needing a browser.
 */

import { readFileSync } from 'node:fs';

interface CpuProfileNode {
  id: number;
  callFrame: {
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  children?: number[];
  hitCount?: number;
}

interface CpuProfile {
  nodes: CpuProfileNode[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  endTime: number;
}

export interface HotFunction {
  fn: string;
  location: string;
  selfTimeUs: number;
  pct: number;
}

/**
 * Parse a .cpuprofile file and return the top-N functions by self-time.
 * Self-time = total microseconds a function was at the top of the call stack.
 */
export function analyzeCpuProfile(profilePath: string, topN = 20): HotFunction[] {
  const data = JSON.parse(readFileSync(profilePath, 'utf-8')) as CpuProfile;
  return analyzeProfileData(data, topN);
}

export function analyzeProfileData(data: CpuProfile, topN = 20): HotFunction[] {
  const nodeById = new Map<number, CpuProfileNode>();
  for (const node of data.nodes) {
    nodeById.set(node.id, node);
  }

  const selfTime = new Map<number, number>();
  for (let i = 0; i < data.samples.length; i++) {
    const nodeId = data.samples[i] ?? -1;
    const dt = data.timeDeltas[i] ?? 0;
    if (nodeId < 0) continue;
    selfTime.set(nodeId, (selfTime.get(nodeId) ?? 0) + dt);
  }

  const totalUs = data.timeDeltas.reduce((a, b) => a + b, 0);
  const results: HotFunction[] = [];

  for (const [nodeId, time] of selfTime) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const cf = node.callFrame;
    const fn = cf.functionName || '(anonymous)';
    const location = cf.url ? shortLocation(cf.url, cf.lineNumber) : '';
    results.push({ fn, location, selfTimeUs: time, pct: totalUs > 0 ? (time / totalUs) * 100 : 0 });
  }

  results.sort((a, b) => b.selfTimeUs - a.selfTimeUs);
  return results.slice(0, topN);
}

/**
 * Print the CPU hot-function report to stdout.
 */
export function printCpuReport(hotFns: readonly HotFunction[]): void {
  if (hotFns.length === 0) {
    console.log('\n  (no CPU samples collected)');
    return;
  }

  const fnWidth = Math.max(...hotFns.map((h) => h.fn.length), 10);

  console.log();
  console.log(`  CPU Hot Functions (top ${hotFns.length})`);
  console.log(`  ${'─'.repeat(fnWidth + 40)}`);
  for (const h of hotFns) {
    const timeStr = fmtUs(h.selfTimeUs);
    const pctStr = `${h.pct.toFixed(1)}%`;
    console.log(
      `  ${timeStr.padStart(10)}  ${pctStr.padStart(5)}  ${h.fn.padEnd(fnWidth)}  ${h.location}`,
    );
  }
}

function fmtUs(us: number): string {
  if (us < 1000) return `${us}µs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(1)}ms`;
  return `${(us / 1_000_000).toFixed(2)}s`;
}

function shortLocation(url: string, line: number): string {
  const parts = url.replace(/\\/g, '/').split('/');
  const tail = parts.slice(-2).join('/');
  return `${tail}:${line}`;
}
