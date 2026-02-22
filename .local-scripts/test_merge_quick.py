"""Quick verification of three_way_merge."""
import sys
sys.path.insert(0, ".")
from src.sync.merge import three_way_merge, MergeResult

def test_no_conflict():
    base = "a\nb\nc\n"
    ours = "a\nx\nc\n"
    theirs = "a\nb\ny\n"
    r = three_way_merge(base, ours, theirs)
    assert not r.has_conflicts
    assert r.conflict_count == 0
    assert "x" in r.merged_text and "y" in r.merged_text

def test_conflict():
    base = "a\nb\nc\n"
    ours = "a\nX\nc\n"
    theirs = "a\nY\nc\n"
    r = three_way_merge(base, ours, theirs)
    assert r.has_conflicts
    assert r.conflict_count == 1
    assert "<<<<<<< LOCAL" in r.merged_text
    assert "=======" in r.merged_text
    assert ">>>>>>> CLOUD" in r.merged_text
    assert "X" in r.merged_text and "Y" in r.merged_text

def test_both_same_change():
    base = "a\nb\nc\n"
    ours = "a\nZ\nc\n"
    theirs = "a\nZ\nc\n"
    r = three_way_merge(base, ours, theirs)
    assert not r.has_conflicts
    assert "Z" in r.merged_text

def test_empty_base():
    base = ""
    ours = "hello\n"
    theirs = "hello\n"
    r = three_way_merge(base, ours, theirs)
    assert not r.has_conflicts
    assert r.merged_text == "hello\n"

if __name__ == "__main__":
    test_no_conflict()
    test_conflict()
    test_both_same_change()
    test_empty_base()
    print("All tests passed")
