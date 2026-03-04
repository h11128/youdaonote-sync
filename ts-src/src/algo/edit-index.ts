export type Edit = [
  baseLo: number,
  baseHi: number,
  otherLo: number,
  otherHi: number,
  isSame: boolean,
];

function bsRight(arr: number[], val: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midVal = arr[mid];
    if (midVal === undefined) throw new Error(`unreachable: arr[${mid}]`);
    if (midVal <= val) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class EditIndex {
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

  private findInsertionPoint(
    lo: number,
  ): { otherLo: number; otherHi: number; isSame: boolean } | null {
    const idx = bsRight(this.starts, lo) - 1;
    const from = Math.max(0, idx - 1);
    const to = Math.min(this.edits.length, idx + 3);

    for (let i = from; i < to; i++) {
      const edit = this.edits[i];
      if (edit === undefined) continue;
      const [bLo, bHi, oLo, oHi, same] = edit;
      if (bLo === lo && bHi === lo && !same) {
        return { otherLo: oLo, otherHi: oHi, isSame: false };
      }
    }
    for (let i = from; i < to; i++) {
      const edit = this.edits[i];
      if (edit === undefined) continue;
      const [bLo, bHi, oLo, , same] = edit;
      if (bLo <= lo && lo <= bHi && same) {
        const mapped = oLo + (lo - bLo);
        return { otherLo: mapped, otherHi: mapped, isSame: true };
      }
    }
    return null;
  }

  private findRange(
    lo: number,
    hi: number,
  ): { otherLo: number; otherHi: number; isSame: boolean } | null {
    const idx = bsRight(this.starts, lo) - 1;
    for (let i = Math.max(0, idx - 1); i < Math.min(this.edits.length, idx + 3); i++) {
      const edit = this.edits[i];
      if (edit === undefined) continue;
      const [bLo, bHi, oLo, oHi, same] = edit;
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
