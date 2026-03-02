export interface MergeResult {
  readonly mergedText: string;
  readonly hasConflicts: boolean;
  readonly conflictCount: number;
}

type Edit = [baseLo: number, baseHi: number, otherLo: number, otherHi: number, isSame: boolean];

function blocksToEdits(
  baseLen: number,
  otherLen: number,
  matchingBlocks: Array<[number, number, number]>,
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
function getMatchingBlocks(base: string[], other: string[]): Array<[number, number, number]> {
  const n = base.length;
  const m = other.length;

  // Build index: line → positions in other
  const otherIndex = new Map<string, number[]>();
  for (let j = 0; j < m; j++) {
    const line = other[j]!;
    let list = otherIndex.get(line);
    if (!list) { list = []; otherIndex.set(line, list); }
    list.push(j);
  }

  const blocks: Array<[number, number, number]> = [];
  findBlocks(base, other, otherIndex, 0, n, 0, m, blocks);
  blocks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  blocks.push([n, m, 0]);
  return blocks;
}

function findBlocks(
  base: string[], other: string[],
  otherIndex: Map<string, number[]>,
  baseLo: number, baseHi: number,
  otherLo: number, otherHi: number,
  result: Array<[number, number, number]>,
): void {
  let bestI = baseLo;
  let bestJ = otherLo;
  let bestLen = 0;

  // Find longest matching block in the given range
  const runLens = new Map<number, number>();
  for (let i = baseLo; i < baseHi; i++) {
    const newRuns = new Map<number, number>();
    for (const j of otherIndex.get(base[i]!) ?? []) {
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

  if (bestLen === 0) return;

  // Recurse on left and right sides
  if (baseLo < bestI && otherLo < bestJ) {
    findBlocks(base, other, otherIndex, baseLo, bestI, otherLo, bestJ, result);
  }
  result.push([bestI, bestJ, bestLen]);
  if (bestI + bestLen < baseHi && bestJ + bestLen < otherHi) {
    findBlocks(base, other, otherIndex, bestI + bestLen, baseHi, bestJ + bestLen, otherHi, result);
  }
}

class EditIndex {
  private edits: Edit[];
  private starts: number[];

  constructor(edits: Edit[]) {
    this.edits = edits;
    this.starts = edits.map((e) => e[0]);
  }

  find(lo: number, hi: number): { otherLo: number; otherHi: number; isSame: boolean } | null {
    if (lo === hi) return this.findInsertionPoint(lo);
    return this.findRange(lo, hi);
  }

  private findInsertionPoint(lo: number): { otherLo: number; otherHi: number; isSame: boolean } | null {
    const idx = bsRight(this.starts, lo) - 1;
    const from = Math.max(0, idx - 1);
    const to = Math.min(this.edits.length, idx + 3);

    for (let i = from; i < to; i++) {
      const [bLo, bHi, oLo, oHi, same] = this.edits[i]!;
      if (bLo === lo && bHi === lo && !same) {
        return { otherLo: oLo, otherHi: oHi, isSame: false };
      }
    }
    for (let i = from; i < to; i++) {
      const [bLo, bHi, oLo, , same] = this.edits[i]!;
      if (bLo <= lo && lo <= bHi && same) {
        const mapped = oLo + (lo - bLo);
        return { otherLo: mapped, otherHi: mapped, isSame: true };
      }
    }
    return null;
  }

  private findRange(lo: number, hi: number): { otherLo: number; otherHi: number; isSame: boolean } | null {
    const idx = bsRight(this.starts, lo) - 1;
    for (let i = Math.max(0, idx - 1); i < Math.min(this.edits.length, idx + 3); i++) {
      const [bLo, bHi, oLo, oHi, same] = this.edits[i]!;
      if (bLo <= lo && hi <= bHi) {
        if (same) {
          return { otherLo: oLo + (lo - bLo), otherHi: oLo + (hi - bLo), isSame: true };
        }
        return { otherLo: oLo, otherHi: oHi, isSame: false };
      }
    }
    return null;
  }
}

function bsRight(arr: number[], val: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! <= val) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.split(/\n/).map((l, i, a) => i < a.length - 1 ? l + '\n' : l);
}

/**
 * Three-way merge for text content.
 *
 * Uses diff3 algorithm: computes edits from base→ours and base→theirs,
 * auto-merges non-overlapping changes, marks conflicts with markers.
 */
export function threeWayMerge(base: string, ours: string, theirs: string): MergeResult {
  if (base == null || ours == null || theirs == null) {
    throw new TypeError('base, ours, and theirs must be strings, not null/undefined');
  }
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
  for (const e of editsOurs) { breakPoints.add(e[0]); breakPoints.add(e[1]); }
  for (const e of editsTheirs) { breakPoints.add(e[0]); breakPoints.add(e[1]); }
  const pts = [...breakPoints].sort((a, b) => a - b);

  const segments: Array<[number, number]> = [];
  for (let i = 0; i < pts.length; i++) {
    if (i + 1 < pts.length) {
      segments.push([pts[i]!, pts[i]!]);
      segments.push([pts[i]!, pts[i + 1]!]);
    } else {
      segments.push([pts[i]!, pts[i]!]);
    }
  }
  if (segments.length === 0) segments.push([0, 0]);

  const output: string[] = [];
  let conflictCount = 0;

  for (const [lo, hi] of segments) {
    if (lo > hi) continue;
    const oursInfo = idxOurs.find(lo, hi);
    const theirsInfo = idxTheirs.find(lo, hi);

    if (!oursInfo || !theirsInfo) {
      output.push(...baseLines.slice(lo, hi));
      continue;
    }

    const oursContent = oursLines.slice(oursInfo.otherLo, oursInfo.otherHi);
    const theirsContent = theirsLines.slice(theirsInfo.otherLo, theirsInfo.otherHi);

    if (oursInfo.isSame && theirsInfo.isSame) {
      output.push(...baseLines.slice(lo, hi));
    } else if (oursInfo.isSame && !theirsInfo.isSame) {
      output.push(...theirsContent);
    } else if (!oursInfo.isSame && theirsInfo.isSame) {
      output.push(...oursContent);
    } else {
      if (oursContent.join('') === theirsContent.join('')) {
        output.push(...oursContent);
      } else {
        conflictCount++;
        output.push('<<<<<<< LOCAL\n');
        output.push(...oursContent);
        output.push('=======\n');
        output.push(...theirsContent);
        output.push('>>>>>>> CLOUD\n');
      }
    }
  }

  return {
    mergedText: output.join(''),
    hasConflicts: conflictCount > 0,
    conflictCount,
  };
}
