"""检查特定文件在 metadata 中的状态"""
import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.sync.metadata import SyncMetadata

meta = SyncMetadata()

targets = [
    "内在世界/计划和总结/年度计划.note",
    "内在世界/计划和总结/年度计划.md",
]

for t in targets:
    info = meta.get_file_info(t)
    print(f"\n{t}:")
    if info:
        for k, v in info.items():
            print(f"  {k}: {v}")
    else:
        print("  NOT FOUND")

    local = os.path.join("E:/Projects/notes", t)
    print(f"  local exists: {os.path.exists(local)}")

meta.close()
