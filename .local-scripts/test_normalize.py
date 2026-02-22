"""验证归一化后这 8 个文件是否相同"""
import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.sync.moves import _normalize_md_text

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

for local_rel, cloud_rel in cases:
    local_abs = os.path.join(LOCAL_DIR, local_rel)
    cloud_abs = os.path.join(LOCAL_DIR, cloud_rel)

    lp_norm = _normalize_md_text(local_abs)
    bp_norm = _normalize_md_text(cloud_abs)

    if lp_norm is None or bp_norm is None:
        print(f"[ERROR] {os.path.basename(local_rel)}: 读取失败")
        continue

    if lp_norm == bp_norm:
        print(f"[MATCH] {os.path.basename(local_rel)}")
    else:
        # 找到第一个不同的行
        lp_lines = lp_norm.split("\n")
        bp_lines = bp_norm.split("\n")
        print(f"[DIFF]  {os.path.basename(local_rel)}: "
              f"本地{len(lp_lines)}行 vs 旧路径{len(bp_lines)}行")
        diff_count = 0
        for i, (a, b) in enumerate(zip(lp_lines, bp_lines)):
            if a != b:
                diff_count += 1
                if diff_count <= 3:
                    print(f"  行{i+1}:")
                    print(f"    本地: {a[:80]}")
                    print(f"    旧路: {b[:80]}")
        if len(lp_lines) != len(bp_lines):
            print(f"  行数不同: {len(lp_lines)} vs {len(bp_lines)}")
        if diff_count > 3:
            print(f"  ... 还有 {diff_count - 3} 行不同")
