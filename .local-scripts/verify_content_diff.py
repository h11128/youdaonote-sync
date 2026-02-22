"""验证：剩余上传候选的内容是否和云端旧路径版本一致"""
import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.sync.utils import compute_content_hash
from src.sync.moves import normalize_filename

LOCAL_DIR = "E:/Projects/notes"

cases = [
    ("内在世界/日记/2025/关于Cindy的观察和感想.md",
     "存档记录/已完成项目/self-review/关于Cindy的观察和感想.md"),
    ("内在世界/日记/2025/安卓手机与录音设备购买推荐.md",
     "当前事项/新手机和录音/安卓手机与录音设备购买推荐.md"),
    ("内在世界/日记/2025/给Cindy的反馈-2025年度.md",
     "存档记录/已完成项目/self-review/给Cindy的反馈-2025年度.md"),
    ("内在世界/日记/2025/设备购买需求总结.md",
     "当前事项/新手机和录音/设备购买需求总结.md"),
]

for new_path, old_path in cases:
    new_abs = os.path.join(LOCAL_DIR, new_path)
    old_abs = os.path.join(LOCAL_DIR, old_path)

    new_hash = compute_content_hash(new_abs)
    old_hash = compute_content_hash(old_abs)

    new_size = os.path.getsize(new_abs) if os.path.exists(new_abs) else "N/A"
    old_size = os.path.getsize(old_abs) if os.path.exists(old_abs) else "N/A"

    match = "相同" if new_hash == old_hash else "不同"
    print(f"{os.path.basename(new_path)}")
    print(f"  新路径: {new_size} bytes, hash={new_hash[:16]}...")
    print(f"  旧路径: {old_size} bytes, hash={old_hash[:16]}...")
    print(f"  内容: {match}")
    print()
