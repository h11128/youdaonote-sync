"""检查 backupNote 和 file/ 缓存的覆盖范围"""
import os
import sys
import sqlite3
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

APPDATA = os.environ["APPDATA"]
USER_DIR = os.path.join(APPDATA, "ynote-desktop", "h11128@163.com", "ynote-data")
USER_DB = os.path.join(USER_DIR, "h11128@163.com.db")
FILE_DIR = os.path.join(USER_DIR, "file")
BACKUP_DIR = os.path.join(USER_DIR, "backupNote")

# 收集 file/ 目录中所有文件名
disk_files = set()
for root, dirs, files in os.walk(FILE_DIR):
    for f in files:
        disk_files.add(f)

# 收集 backupNote/ 中所有目录名 (每个笔记一个目录)
backup_ids = set()
if os.path.isdir(BACKUP_DIR):
    for d in os.listdir(BACKUP_DIR):
        if os.path.isdir(os.path.join(BACKUP_DIR, d)):
            backup_ids.add(d)

print(f"file/ 缓存文件: {len(disk_files)} 个")
print(f"backupNote/ 笔记: {len(backup_ids)} 个")

# 看 backupNote 内容格式
conn = sqlite3.connect(f"file:{USER_DB}?mode=ro", uri=True)
cur = conn.cursor()

cur.execute("SELECT fileId FROM note WHERE del = 0 AND dir = 0")
all_note_ids = set(r[0] for r in cur.fetchall())
print(f"活跃笔记 (note 表): {len(all_note_ids)} 个")

# 覆盖率
cached = all_note_ids & disk_files
backed_up = all_note_ids & backup_ids
print(f"\nfile/ 缓存命中: {len(cached)} / {len(all_note_ids)} ({len(cached)*100//len(all_note_ids)}%)")
print(f"backupNote 命中: {len(backed_up)} / {len(all_note_ids)} ({len(backed_up)*100//len(all_note_ids)}%)")
print(f"两者合计命中: {len(cached | backed_up)} / {len(all_note_ids)} ({len(cached | backed_up)*100//len(all_note_ids)}%)")

# 检查 backupNote 的内容格式
print("\nbackupNote 样本:")
sample_ids = list(backed_up)[:3]
for fid in sample_ids:
    bdir = os.path.join(BACKUP_DIR, fid)
    files = os.listdir(bdir)
    print(f"  {fid[:20]}...")
    print(f"    files: {files}")
    for bf in sorted(files):
        bp = os.path.join(bdir, bf)
        sz = os.path.getsize(bp)
        print(f"    {bf}: {sz} bytes")
        if sz > 0 and not bf.endswith('.index'):
            with open(bp, "rb") as f:
                raw = f.read(500)
            try:
                text = raw.decode("utf-8", errors="replace")
                print(f"      preview: {text[:200]}")
            except:
                print(f"      (binary: {raw[:50]})")

# file/ 缓存的内容格式
print("\nfile/ 缓存样本:")
sample_cached = list(cached)[:2]
for fid in sample_cached:
    cur.execute("SELECT title FROM note WHERE fileId = ?", (fid,))
    row = cur.fetchone()
    title = row[0] if row else "?"
    bucket = fid[0].lower()
    path = os.path.join(FILE_DIR, bucket, fid)
    sz = os.path.getsize(path)
    print(f"  {fid[:20]}... '{title}' ({sz} bytes)")
    with open(path, "rb") as f:
        raw = f.read(500)
    try:
        text = raw.decode("utf-8", errors="replace")
        print(f"    preview: {text[:300]}")
    except:
        print(f"    (binary: {raw[:50]})")

conn.close()
