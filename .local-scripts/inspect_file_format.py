"""检查桌面客户端 file/ 目录的文件格式和可用性"""
import os
import sys
import sqlite3
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

APPDATA = os.environ["APPDATA"]
USER_DIR = os.path.join(APPDATA, "ynote-desktop", "h11128@163.com", "ynote-data")
USER_DB = os.path.join(USER_DIR, "h11128@163.com.db")
FILE_DIR = os.path.join(USER_DIR, "file")

conn = sqlite3.connect(f"file:{USER_DB}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

# 1. 查一个最近的 .md 文件看 file/ 内容格式
print("=" * 60)
print("1. .md 文件在 file/ 目录中的格式")
print("=" * 60)
cur.execute("""SELECT fileId, title, parentId, modifyTime, size, domain
               FROM note WHERE del = 0 AND title LIKE '%.md'
               ORDER BY modifyTime DESC LIMIT 3""")
for row in cur.fetchall():
    fid = row['fileId']
    # 找磁盘文件 — file/ 下按首字符分桶
    bucket = fid[0].lower()
    disk_path = os.path.join(FILE_DIR, bucket, fid)
    exists = os.path.exists(disk_path)
    print(f"\n  fileId: {fid}")
    print(f"  title:  {row['title']}")
    print(f"  size:   {row['size']}")
    print(f"  domain: {row['domain']}")
    print(f"  disk:   {disk_path}")
    print(f"  exists: {exists}")
    if exists:
        with open(disk_path, "rb") as f:
            raw = f.read(2000)
        print(f"  disk_size: {os.path.getsize(disk_path)}")
        print(f"  starts_with: {raw[:100]}")
        try:
            text = raw.decode("utf-8", errors="replace")
            print(f"  text_preview: {text[:500]}")
        except:
            print(f"  (binary content)")

# 2. 查一个 .note 文件
print("\n" + "=" * 60)
print("2. .note 文件在 file/ 目录中的格式")
print("=" * 60)
cur.execute("""SELECT fileId, title, parentId, modifyTime, size, domain
               FROM note WHERE del = 0 AND title LIKE '%.note'
               ORDER BY modifyTime DESC LIMIT 2""")
for row in cur.fetchall():
    fid = row['fileId']
    bucket = fid[0].lower()
    disk_path = os.path.join(FILE_DIR, bucket, fid)
    exists = os.path.exists(disk_path)
    print(f"\n  fileId: {fid}")
    print(f"  title:  {row['title']}")
    print(f"  size:   {row['size']}")
    print(f"  disk:   exists={exists}")
    if exists:
        with open(disk_path, "rb") as f:
            raw = f.read(2000)
        print(f"  disk_size: {os.path.getsize(disk_path)}")
        text = raw.decode("utf-8", errors="replace")
        print(f"  text_preview:\n{text[:800]}")

# 3. 看看 fileId 和我们 sync engine 用的 file_id 对应关系
print("\n" + "=" * 60)
print("3. fileId 映射 — 桌面客户端 vs 云端 API")
print("=" * 60)
# 我们的 sync engine 通过 API 拿到的 file_id 是什么格式？
# 看看 note 表的 fileId 前缀分布
cur.execute("SELECT SUBSTR(fileId, 1, 3) as prefix, COUNT(*) as cnt FROM note GROUP BY prefix ORDER BY cnt DESC LIMIT 10")
print("  fileId 前缀分布:")
for row in cur.fetchall():
    print(f"    {row['prefix']}: {row['cnt']} 条")

# 4. 文件夹层级 — parentId 链
print("\n" + "=" * 60)
print("4. 文件夹层级重建")
print("=" * 60)
cur.execute("""SELECT fileId, title, parentId FROM note_book
               WHERE del = 0 ORDER BY title LIMIT 20""")
folders = {}
for row in cur.fetchall():
    folders[row['fileId']] = {'title': row['title'], 'parentId': row['parentId']}
    print(f"  {row['fileId'][:20]}... → {row['title']} (parent={row['parentId'][:20]}...)")

# 5. 对比: 桌面客户端 note 数量 vs 我们本地同步的文件数量
print("\n" + "=" * 60)
print("5. 数据量对比")
print("=" * 60)
cur.execute("SELECT COUNT(*) FROM note WHERE del = 0 AND dir = 0")
notes_count = cur.fetchone()[0]
cur.execute("SELECT COUNT(*) FROM note_book WHERE del = 0")
folders_count = cur.fetchone()[0]
print(f"  桌面客户端: {notes_count} 笔记, {folders_count} 文件夹")
print(f"  file/ 磁盘文件: {sum(len(f) for _, _, f in os.walk(FILE_DIR))} 个")

local_notes = os.path.join("E:", "Projects", "notes")
if os.path.isdir(local_notes):
    local_count = sum(1 for _, _, files in os.walk(local_notes) for f in files)
    print(f"  我们同步目录: {local_count} 文件")

conn.close()
