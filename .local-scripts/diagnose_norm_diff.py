"""诊断归一化后仍然不同的行"""
import os
import sys
import difflib
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.sync.utils import normalize_md_formatting

LOCAL_DIR = "E:/Projects/notes"

cases = [
    ("内在世界/日记/2025/硬件采购清单.md",
     "当前事项/新手机和录音/硬件采购清单.md"),
]

for new_path, old_path in cases:
    new_abs = os.path.join(LOCAL_DIR, new_path)
    old_abs = os.path.join(LOCAL_DIR, old_path)
    basename = os.path.basename(new_path)

    with open(new_abs, "r", encoding="utf-8", errors="replace") as f:
        new_text = f.read()
    with open(old_abs, "r", encoding="utf-8", errors="replace") as f:
        old_text = f.read()

    new_norm = normalize_md_formatting(new_text)
    old_norm = normalize_md_formatting(old_text)

    if new_norm == old_norm:
        print(f"MATCH after normalization: {basename}")
        continue

    print(f"STILL DIFFERENT: {basename}")
    new_lines = new_norm.splitlines(keepends=True)
    old_lines = old_norm.splitlines(keepends=True)

    diff = list(difflib.unified_diff(old_lines, new_lines,
                                     fromfile="old", tofile="new", n=1))
    for line in diff[:200]:
        print(line, end="")
    if len(diff) > 200:
        print(f"\n... ({len(diff) - 200} more lines)")
