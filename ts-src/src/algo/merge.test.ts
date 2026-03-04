import { describe, it, expect } from 'vitest';
import { threeWayMerge } from './merge.js';

describe('threeWayMerge', () => {
  it('returns base unchanged when neither side edits', () => {
    const result = threeWayMerge('line1\nline2\n', 'line1\nline2\n', 'line1\nline2\n');
    expect(result.hasConflicts).toBe(false);
    expect(result.mergedText).toBe('line1\nline2\n');
  });

  it('takes ours when only ours changes', () => {
    const base = 'line1\nline2\n';
    const ours = 'line1\nLINE2\n';
    const theirs = 'line1\nline2\n';
    const result = threeWayMerge(base, ours, theirs);
    expect(result.hasConflicts).toBe(false);
    expect(result.mergedText).toContain('LINE2');
  });

  it('takes theirs when only theirs changes', () => {
    const base = 'line1\nline2\n';
    const ours = 'line1\nline2\n';
    const theirs = 'line1\nLINE2\n';
    const result = threeWayMerge(base, ours, theirs);
    expect(result.hasConflicts).toBe(false);
    expect(result.mergedText).toContain('LINE2');
  });

  it('auto-merges non-overlapping changes', () => {
    const base = 'A\nB\nC\n';
    const ours = 'A-OURS\nB\nC\n';
    const theirs = 'A\nB\nC-THEIRS\n';
    const result = threeWayMerge(base, ours, theirs);
    expect(result.hasConflicts).toBe(false);
    expect(result.mergedText).toContain('A-OURS');
    expect(result.mergedText).toContain('C-THEIRS');
  });

  it('marks conflict when same line changed both sides', () => {
    const base = 'line1\nline2\nline3\n';
    const ours = 'line1\nOURS\nline3\n';
    const theirs = 'line1\nTHEIRS\nline3\n';
    const result = threeWayMerge(base, ours, theirs);
    expect(result.hasConflicts).toBe(true);
    expect(result.conflictCount).toBeGreaterThanOrEqual(1);
    expect(result.mergedText).toContain('<<<<<<< LOCAL');
    expect(result.mergedText).toContain('>>>>>>> CLOUD');
  });

  it('handles empty strings', () => {
    const result = threeWayMerge('', '', '');
    expect(result.hasConflicts).toBe(false);
    expect(result.mergedText).toBe('');
  });

  it('both sides make identical change → no conflict', () => {
    const base = 'old\n';
    const same = 'new\n';
    const result = threeWayMerge(base, same, same);
    expect(result.hasConflicts).toBe(false);
    expect(result.mergedText).toBe('new\n');
  });
});
