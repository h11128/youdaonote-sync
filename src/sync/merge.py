"""
Three-way merge for text files using diff3 algorithm.
"""

import difflib
from dataclasses import dataclass
from typing import List, Optional, Tuple


@dataclass
class MergeResult:
    merged_text: str
    has_conflicts: bool
    conflict_count: int


def _blocks_to_edits(
    base_len: int,
    other_len: int,
    matching_blocks: List[Tuple[int, int, int]],
) -> List[Tuple[int, int, int, int, bool]]:
    edits = []
    prev_i, prev_j = 0, 0
    for i, j, n in matching_blocks:
        if prev_i < i or prev_j < j:
            edits.append((prev_i, i, prev_j, j, False))
        if n > 0:
            edits.append((i, i + n, j, j + n, True))
        prev_i, prev_j = i + n, j + n
    if prev_i < base_len or prev_j < other_len:
        edits.append((prev_i, base_len, prev_j, other_len, False))
    return edits


def _find_edit(
    edits: List[Tuple[int, int, int, int, bool]], lo: int, hi: int,
) -> Optional[Tuple[int, int, bool]]:
    if lo == hi:
        for base_lo, base_hi, other_lo, other_hi, is_same in edits:
            if base_lo == lo and base_hi == lo and not is_same:
                return (other_lo, other_hi, False)
        for base_lo, base_hi, other_lo, other_hi, is_same in edits:
            if base_lo <= lo and lo <= base_hi and is_same:
                mapped = other_lo + (lo - base_lo)
                return (mapped, mapped, True)
        return None

    for base_lo, base_hi, other_lo, other_hi, is_same in edits:
        if base_lo <= lo and hi <= base_hi:
            if is_same:
                return (other_lo + (lo - base_lo), other_lo + (hi - base_lo), True)
            return (other_lo, other_hi, False)
    return None


def three_way_merge(base: str, ours: str, theirs: str) -> MergeResult:
    if base is None or ours is None or theirs is None:
        raise TypeError("base, ours, and theirs must be strings, not None")
    base_lines = base.splitlines(keepends=True) if base else []
    ours_lines = ours.splitlines(keepends=True) if ours else []
    theirs_lines = theirs.splitlines(keepends=True) if theirs else []

    sm_ours = difflib.SequenceMatcher(None, base_lines, ours_lines)
    sm_theirs = difflib.SequenceMatcher(None, base_lines, theirs_lines)
    edits_ours = _blocks_to_edits(len(base_lines), len(ours_lines), sm_ours.get_matching_blocks())
    edits_theirs = _blocks_to_edits(
        len(base_lines), len(theirs_lines), sm_theirs.get_matching_blocks()
    )

    break_points = {0, len(base_lines)}
    for e in edits_ours:
        break_points.add(e[0])
        break_points.add(e[1])
    for e in edits_theirs:
        break_points.add(e[0])
        break_points.add(e[1])
    pts = sorted(break_points)

    segments: List[Tuple[int, int]] = []
    for i in range(len(pts)):
        if i + 1 < len(pts):
            segments.append((pts[i], pts[i]))      # zero-length (insertion point)
            segments.append((pts[i], pts[i + 1]))   # normal range
        else:
            segments.append((pts[i], pts[i]))        # trailing insertion point
    if not segments:
        segments = [(0, 0)]

    output: List[str] = []
    conflict_count = 0

    for lo, hi in segments:
        if lo > hi:
            continue
        ours_info = _find_edit(edits_ours, lo, hi)
        theirs_info = _find_edit(edits_theirs, lo, hi)
        if ours_info is None or theirs_info is None:
            output.extend(base_lines[lo:hi])
            continue

        ours_lo, ours_hi, ours_same = ours_info
        theirs_lo, theirs_hi, theirs_same = theirs_info
        ours_content = ours_lines[ours_lo:ours_hi]
        theirs_content = theirs_lines[theirs_lo:theirs_hi]

        if ours_same and theirs_same:
            output.extend(base_lines[lo:hi])
        elif ours_same and not theirs_same:
            output.extend(theirs_content)
        elif not ours_same and theirs_same:
            output.extend(ours_content)
        else:
            if ours_content == theirs_content:
                output.extend(ours_content)
            else:
                conflict_count += 1
                output.append("<<<<<<< LOCAL\n")
                output.extend(ours_content)
                output.append("=======\n")
                output.extend(theirs_content)
                output.append(">>>>>>> CLOUD\n")

    merged = "".join(output)
    return MergeResult(
        merged_text=merged,
        has_conflicts=conflict_count > 0,
        conflict_count=conflict_count,
    )
