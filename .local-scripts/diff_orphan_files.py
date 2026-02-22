"""逐个对比本地新路径与云端旧路径文件的差异"""
import os
import sys
import difflib
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

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

    basename = os.path.basename(local_rel)
    print("=" * 70)
    print(f"文件: {basename}")
    print(f"  本地新路径: {local_rel}")
    print(f"  云端旧路径: {cloud_rel}")

    if not os.path.exists(local_abs):
        print("  ⚠ 本地新路径不存在!")
        continue
    if not os.path.exists(cloud_abs):
        print("  ⚠ 云端旧路径不存在!")
        continue

    local_size = os.path.getsize(local_abs)
    cloud_size = os.path.getsize(cloud_abs)
    local_mtime = int(os.path.getmtime(local_abs))
    cloud_mtime = int(os.path.getmtime(cloud_abs))

    print(f"  大小: 本地={local_size}B, 旧路径={cloud_size}B, 差={local_size - cloud_size}B")
    print(f"  修改时间: 本地={local_mtime}, 旧路径={cloud_mtime}")

    try:
        with open(local_abs, "r", encoding="utf-8", errors="replace") as f:
            local_lines = f.readlines()
        with open(cloud_abs, "r", encoding="utf-8", errors="replace") as f:
            cloud_lines = f.readlines()
    except Exception as e:
        print(f"  读取失败: {e}")
        continue

    print(f"  行数: 本地={len(local_lines)}, 旧路径={len(cloud_lines)}")

    diff = list(difflib.unified_diff(
        cloud_lines, local_lines,
        fromfile=f"旧路径({cloud_rel})",
        tofile=f"本地({local_rel})",
        lineterm="",
        n=1,
    ))

    if not diff:
        print("  结论: 内容完全相同（可能只是换行符差异）")
    else:
        added = sum(1 for l in diff if l.startswith("+") and not l.startswith("+++"))
        removed = sum(1 for l in diff if l.startswith("-") and not l.startswith("---"))
        print(f"  差异: +{added} 行, -{removed} 行")
        print()
        shown = 0
        for line in diff:
            if shown > 30:
                print(f"  ... (剩余差异省略，共 {len(diff)} 行)")
                break
            print(f"  {line.rstrip()}")
            shown += 1

    print()
