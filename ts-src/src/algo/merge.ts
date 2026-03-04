import type { Edit } from './edit-index.js';
import { EditIndex } from './edit-index.js';

export interface MergeResult {
  readonly mergedText: string;
  readonly hasConflicts: boolean;
  readonly conflictCount: number;
}

function blocksToEdits(
  baseLen: number,
  otherLen: number,
  matchingBlocks: [number, number, number][],
): Edit[] {
  const edits: Edit[] = [];
  let prevI = 0;
  let prevJ = 0;
  for (const [i, j, n] of matchingBlocks) {
    if (prevI < i || prevJ < j) {
      edits.push([prevI, i, prevJ, j, false]);
    }
    if (n > 0) {
      edits.push([i, i + n, j, j + n, true]);
    }
    prevI = i + n;
    prevJ = j + n;
  }
  if (prevI < baseLen || prevJ < otherLen) {
    edits.push([prevI, baseLen, prevJ, otherLen, false]);
  }
  return edits;
}

/**
 * Simple longest-common-subsequence matching blocks (line-level).
 * Returns array of [baseIdx, otherIdx, length] tuples + terminal [baseLen, otherLen, 0].
 */
function getMatchingBlocks(base: string[], other: string[]): [number, number, number][] {
  const n = base.length;
  const m = other.length;

  // Build index: line → positions in other
  const otherIndex = new Map<string, number[]>();
  for (let j = 0; j < m; j++) {
    const line = other[j];
    if (line === undefined) throw new Error(`unreachable: other[${j}]`);
    let list = otherIndex.get(line);
    if (!list) {
      list = [];
      otherIndex.set(line, list);
    }
    list.push(j);
  }

  const blocks: [number, number, number][] = [];
  findBlocks({ base, otherIndex, baseLo: 0, baseHi: n, otherLo: 0, otherHi: m, result: blocks });
  blocks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  blocks.push([n, m, 0]);
  return blocks;
}

interface FindBlocksParams {
  base: string[];
  otherIndex: Map<string, number[]>;
  baseLo: number;
  baseHi: number;
  otherLo: number;
  otherHi: number;
  result: [number, number, number][];
}

interface FindLongestBlockParams {
  base: string[];
  otherIndex: Map<string, number[]>;
  baseLo: number;
  baseHi: number;
  otherLo: number;
  otherHi: number;
}

function findLongestBlock(params: FindLongestBlockParams): {
  bestI: number;
  bestJ: number;
  bestLen: number;
} {
  const { base, otherIndex, baseLo, baseHi, otherLo, otherHi } = params;
  let bestI = baseLo;
  let bestJ = otherLo;
  let bestLen = 0;
  const runLens = new Map<number, number>();
  for (let i = baseLo; i < baseHi; i++) {
    const baseLine = base[i];
    if (baseLine === undefined) throw new Error(`unreachable: base[${i}]`);
    const newRuns = new Map<number, number>();
    for (const j of otherIndex.get(baseLine) ?? []) {
      if (j < otherLo || j >= otherHi) continue;
      const k = (runLens.get(j - 1) ?? 0) + 1;
      newRuns.set(j, k);
      if (k > bestLen) {
        bestI = i - k + 1;
        bestJ = j - k + 1;
        bestLen = k;
      }
    }
    runLens.clear();
    for (const [k, v] of newRuns) runLens.set(k, v);
  }
  return { bestI, bestJ, bestLen };
}

function findBlocks(params: FindBlocksParams): void {
  const { base, otherIndex, baseLo, baseHi, otherLo, otherHi, result } = params;
  const { bestI, bestJ, bestLen } = findLongestBlock({
    base,
    otherIndex,
    baseLo,
    baseHi,
    otherLo,
    otherHi,
  });

  if (bestLen === 0) return;

  if (baseLo < bestI && otherLo < bestJ) {
    findBlocks({ ...params, baseLo, baseHi: bestI, otherLo, otherHi: bestJ });
  }
  result.push([bestI, bestJ, bestLen]);
  if (bestI + bestLen < baseHi && bestJ + bestLen < otherHi) {
    findBlocks({
      ...params,
      baseLo: bestI + bestLen,
      baseHi,
      otherLo: bestJ + bestLen,
      otherHi,
    });
  }
}

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.split(/\r\n|\r|\n/).map((l, i, a) => (i < a.length - 1 ? l + '\n' : l));
}

/**
 * Three-way merge for text content.
 *
 * Uses diff3 algorithm: computes edits from base→ours and base→theirs,
 * auto-merges non-overlapping changes, marks conflicts with markers.
 */
export function threeWayMerge(base: string, ours: string, theirs: string): MergeResult {
  const baseLines = splitLines(base);
  const oursLines = splitLines(ours);
  const theirsLines = splitLines(theirs);

  const mbOurs = getMatchingBlocks(baseLines, oursLines);
  const mbTheirs = getMatchingBlocks(baseLines, theirsLines);

  const editsOurs = blocksToEdits(baseLines.length, oursLines.length, mbOurs);
  const editsTheirs = blocksToEdits(baseLines.length, theirsLines.length, mbTheirs);

  const idxOurs = new EditIndex(editsOurs);
  const idxTheirs = new EditIndex(editsTheirs);

  const breakPoints = new Set<number>([0, baseLines.length]);
  for (const e of editsOurs) {
    breakPoints.add(e[0]);
    breakPoints.add(e[1]);
  }
  for (const e of editsTheirs) {
    breakPoints.add(e[0]);
    breakPoints.add(e[1]);
  }
  const pts = [...breakPoints].sort((a, b) => a - b);

  const segments = buildSegments(pts);
  const mergeCtx = {
    baseLines,
    oursLines,
    theirsLines,
    idxOurs,
    idxTheirs,
  };
  const { output, conflictCount } = mergeSegments(segments, mergeCtx);

  return {
    mergedText: output.join(''),
    hasConflicts: conflictCount > 0,
    conflictCount,
  };
}

function buildSegments(pts: number[]): [number, number][] {
  const segments: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i];
    if (p0 === undefined) throw new Error(`unreachable: pts[${i}]`);
    if (i + 1 < pts.length) {
      const p1 = pts[i + 1];
      if (p1 === undefined) throw new Error(`unreachable: pts[${i + 1}]`);
      segments.push([p0, p0]);
      segments.push([p0, p1]);
    } else {
      segments.push([p0, p0]);
    }
  }
  if (segments.length === 0) segments.push([0, 0]);
  return segments;
}

interface MergeSegmentContext {
  baseLines: string[];
  oursLines: string[];
  theirsLines: string[];
  idxOurs: EditIndex;
  idxTheirs: EditIndex;
}

function mergeSegments(
  segments: [number, number][],
  ctx: MergeSegmentContext,
): { output: string[]; conflictCount: number } {
  const output: string[] = [];
  let conflictCount = 0;

  for (const [lo, hi] of segments) {
    if (lo > hi) continue;
    const oursInfo = ctx.idxOurs.find(lo, hi);
    const theirsInfo = ctx.idxTheirs.find(lo, hi);

    if (!oursInfo || !theirsInfo) {
      output.push(...ctx.baseLines.slice(lo, hi));
      continue;
    }

    const oursContent = ctx.oursLines.slice(oursInfo.otherLo, oursInfo.otherHi);
    const theirsContent = ctx.theirsLines.slice(theirsInfo.otherLo, theirsInfo.otherHi);
    const merged = mergeSegmentContent({
      lo,
      hi,
      oursInfo,
      theirsInfo,
      oursContent,
      theirsContent,
      baseLines: ctx.baseLines,
    });
    if (merged.conflict) conflictCount++;
    output.push(...merged.lines);
  }

  return { output, conflictCount };
}

interface MergeSegmentContentParams {
  lo: number;
  hi: number;
  oursInfo: { otherLo: number; otherHi: number; isSame: boolean };
  theirsInfo: { otherLo: number; otherHi: number; isSame: boolean };
  oursContent: string[];
  theirsContent: string[];
  baseLines: string[];
}

function mergeSegmentContent(params: MergeSegmentContentParams): {
  lines: string[];
  conflict: boolean;
} {
  const { lo, hi, oursInfo, theirsInfo, oursContent, theirsContent, baseLines } = params;
  if (oursInfo.isSame && theirsInfo.isSame) {
    return { lines: baseLines.slice(lo, hi), conflict: false };
  }
  if (oursInfo.isSame && !theirsInfo.isSame) {
    return { lines: theirsContent, conflict: false };
  }
  if (!oursInfo.isSame && theirsInfo.isSame) {
    return { lines: oursContent, conflict: false };
  }
  if (oursContent.join('') === theirsContent.join('')) {
    return { lines: oursContent, conflict: false };
  }
  return {
    lines: ['<<<<<<< LOCAL\n', ...oursContent, '=======\n', ...theirsContent, '>>>>>>> CLOUD\n'],
    conflict: true,
  };
}
