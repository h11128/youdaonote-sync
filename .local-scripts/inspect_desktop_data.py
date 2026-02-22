"""深度检查有道云笔记桌面客户端的本地同步数据"""
import os
import sys
import sqlite3
import json

APPDATA = os.environ["APPDATA"]
YNOTE_DIR = os.path.join(APPDATA, "ynote-desktop")
USER_DIR = os.path.join(YNOTE_DIR, "h11128@163.com", "ynote-data")
USER_DB = os.path.join(USER_DIR, "h11128@163.com.db")
CONTENT_DB = os.path.join(USER_DIR, "h11128@163.com-content.db")
SEARCH_DB = os.path.join(USER_DIR, "h11128@163.com-search.db")

def section(title):
    print(f"\n{'=' * 70}")
    print(f"  {title}")
    print('=' * 70)

# ===== 1. note 表结构和样本 =====
section("1. note 表 — 笔记元数据")
conn = sqlite3.connect(f"file:{USER_DB}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

cur.execute("SELECT COUNT(*) FROM note")
total = cur.fetchone()[0]
print(f"  总计: {total} 条")

cur.execute("SELECT COUNT(*) FROM note WHERE del = 0 AND deleted IS NULL OR deleted = 0")
active = cur.fetchone()[0]
print(f"  活跃(未删除): {active} 条")

cur.execute("""SELECT fileId, title, namePath, dir, domain, createTime, modifyTime, 
               md5, size, parentId, version, entryType
               FROM note WHERE del = 0 ORDER BY modifyTime DESC LIMIT 5""")
print(f"\n  最近修改的 5 条:")
for row in cur.fetchall():
    print(f"    fileId: {row['fileId']}")
    print(f"    title:  {row['title']}")
    print(f"    path:   {row['namePath']}")
    print(f"    dir:    {row['dir']}, domain: {row['domain']}, entryType: {row['entryType']}")
    print(f"    md5:    {row['md5']}")
    print(f"    size:   {row['size']}, version: {row['version']}")
    mtime = row['modifyTime']
    if mtime and mtime > 1000000000000:
        mtime = mtime / 1000
    from datetime import datetime
    print(f"    mtime:  {datetime.fromtimestamp(mtime) if mtime else '?'}")
    print(f"    parent: {row['parentId']}")
    print()

# ===== 2. note_book 表 =====
section("2. note_book 表 — 笔记本/文件夹")
cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='note_book'")
if cur.fetchone():
    cur.execute("SELECT COUNT(*) FROM note_book")
    print(f"  总计: {cur.fetchone()[0]} 条")
    cur.execute("PRAGMA table_info(note_book)")
    cols = [r[1] for r in cur.fetchall()]
    print(f"  Columns: {cols}")
    cur.execute("SELECT * FROM note_book LIMIT 3")
    for row in cur.fetchall():
        print(f"    {dict(row)}")
else:
    print("  表不存在")

# ===== 3. root 表 =====
section("3. root 表")
cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='root'")
if cur.fetchone():
    cur.execute("PRAGMA table_info(root)")
    cols = [r[1] for r in cur.fetchall()]
    print(f"  Columns: {cols}")
    cur.execute("SELECT * FROM root LIMIT 3")
    for row in cur.fetchall():
        d = dict(row)
        for k, v in d.items():
            if isinstance(v, str) and len(v) > 100:
                d[k] = v[:100] + "..."
        print(f"    {d}")

conn.close()

# ===== 4. content 数据库 =====
section("4. content 数据库 — 笔记内容")
conn = sqlite3.connect(f"file:{CONTENT_DB}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

cur.execute("SELECT COUNT(*) FROM contenttable")
print(f"  总计: {cur.fetchone()[0]} 条")

cur.execute("PRAGMA table_info(contenttable)")
cols = [r[1] for r in cur.fetchall()]
print(f"  Columns: {cols}")

cur.execute("SELECT fileId, title, LENGTH(content) as content_len, erased, isUpdateContent FROM contenttable ORDER BY ROWID DESC LIMIT 5")
print(f"\n  最近 5 条:")
for row in cur.fetchall():
    print(f"    fileId: {row['fileId']}, title: {row['title']}, content_len: {row['content_len']}, erased: {row['erased']}")

# 看一条内容的前 500 字符
cur.execute("SELECT fileId, title, content FROM contenttable WHERE LENGTH(content) > 100 ORDER BY ROWID DESC LIMIT 1")
row = cur.fetchone()
if row:
    print(f"\n  内容样本 ({row['title']}):")
    content = row['content']
    print(f"    前 500 字符: {content[:500]}")
conn.close()

# ===== 5. 磁盘文件 =====
section("5. 磁盘文件结构")
for subdir in ['file', 'resource', 'resourceFile', 'backupNote', 'backupDb']:
    d = os.path.join(USER_DIR, subdir)
    if os.path.isdir(d):
        total_files = 0
        total_size = 0
        sample_files = []
        for root, dirs, files in os.walk(d):
            for f in files:
                fp = os.path.join(root, f)
                sz = os.path.getsize(fp)
                total_files += 1
                total_size += sz
                if len(sample_files) < 3:
                    sample_files.append((fp.replace(USER_DIR, "..."), sz))
        print(f"  {subdir}/: {total_files} files, {total_size/1024:.0f} KB")
        for sf, sz in sample_files:
            print(f"    sample: {sf} ({sz} bytes)")
    else:
        print(f"  {subdir}/: not found")

# ===== 6. 检查 file/ 目录的文件和 note 表的对应关系 =====
section("6. file/ 目录文件与 note 表的映射")
file_dir = os.path.join(USER_DIR, "file")
if os.path.isdir(file_dir):
    disk_files = []
    for root, dirs, files in os.walk(file_dir):
        for f in files:
            disk_files.append(f)
    print(f"  磁盘文件: {len(disk_files)} 个")
    print(f"  文件名样本: {disk_files[:5]}")

    conn = sqlite3.connect(f"file:{USER_DB}?mode=ro", uri=True)
    cur = conn.cursor()
    if disk_files:
        sample_id = disk_files[0].replace('.note', '').replace('.md', '')
        cur.execute("SELECT fileId, title, namePath FROM note WHERE fileId LIKE ?", (f"%{sample_id[:20]}%",))
        matches = cur.fetchall()
        print(f"\n  文件名 '{disk_files[0]}' 匹配 note 表:")
        for m in matches:
            print(f"    {m}")
    conn.close()
