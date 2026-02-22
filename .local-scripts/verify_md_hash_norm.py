"""验证 MD 归一化 hash：之前格式差异的文件对现在是否 hash 一致"""
import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.sync.utils import compute_content_hash

LOCAL_DIR = "E:/Projects/notes"

cases = [
    ("内在世界/日记/2025/关于Cindy的观察和感想.md",
     "存档记录/已完成项目/self-review/关于Cindy的观察和感想.md"),
    ("内在世界/日记/2025/安卓手机与录音设备购买推荐.md",
     "当前事项/新手机和录音/安卓手机与录音设备购买推荐.md"),
    ("内在世界/日记/2025/手机与录音设备需求提取.md",
     "当前事项/新手机和录音/手机与录音设备需求提取.md"),
    ("内在世界/日记/2025/硬件采购清单.md",
     "当前事项/新手机和录音/硬件采购清单.md"),
    ("内在世界/日记/2025/给Cindy的反馈-2025年度-v2.md",
     "存档记录/已完成项目/self-review/给Cindy的反馈-2025年度-v2.md"),
    ("内在世界/日记/2025/给Cindy的反馈-2025年度.md",
     "存档记录/已完成项目/self-review/给Cindy的反馈-2025年度.md"),
    ("内在世界/日记/2025/设备购买需求总结.md",
     "当前事项/新手机和录音/设备购买需求总结.md"),
    ("内在世界/日记/2025/语音日志系统设计文档.md",
     "当前事项/新手机和录音/语音日志系统设计文档.md"),
]

match_count = 0
diff_count = 0
for new_path, old_path in cases:
    new_abs = os.path.join(LOCAL_DIR, new_path)
    old_abs = os.path.join(LOCAL_DIR, old_path)
    basename = os.path.basename(new_path)

    if not os.path.exists(new_abs) or not os.path.exists(old_abs):
        print(f"  SKIP {basename} — file(s) not found")
        continue

    h1 = compute_content_hash(new_abs)
    h2 = compute_content_hash(old_abs)

    if h1 == h2:
        print(f"  MATCH {basename}")
        match_count += 1
    else:
        print(f"  DIFF  {basename}")
        print(f"        new: {h1}")
        print(f"        old: {h2}")
        diff_count += 1

print(f"\nResult: {match_count} matched, {diff_count} different")
