"""检查 domain=1 (Markdown) 文件在桌面客户端本地数据中的存储情况"""
import os
import sqlite3

APPDATA = os.environ["APPDATA"]
USER_DIR = os.path.join(APPDATA, "ynote-desktop", "h11128@163.com", "ynote-data")
USER_DB = os.path.join(USER_DIR, "h11128@163.com.db")
CONTENT_DB = os.path.join(USER_DIR, "h11128@163.com-content.db")
FILE_DIR = os.path.join(USER_DIR, "file")

conn = sqlite3.connect(f"file:{USER_DB}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

print("=" * 70)
print("  1. note 表中 domain=1 的文件统计")
print("=" * 70)
cur.execute("SELECT COUNT(*) FROM note WHERE del = 0 AND domain = 1 AND dir = 0")
md_count = cur.fetchone()[0]
cur.execute("SELECT COUNT(*) FROM note WHERE del = 0 AND domain = 0 AND dir = 0")
note_count = cur.fetchone()[0]
cur.execute("SELECT COUNT(*) FROM note WHERE del = 0 AND dir = 0")
total = cur.fetchone()[0]
print(f"  domain=0 (XML/NOTE): {note_count}")
print(f"  domain=1 (Markdown):  {md_count}")
print(f"  总文件数:              {total}")
print(f"  domain=1 占比:         {md_count / total * 100:.1f}%")

print("\n" + "=" * 70)
print("  2. domain=1 文件的元数据样本")
print("=" * 70)
cur.execute("""
    SELECT fileId, title, parentId, modifyTime, size, version, md5
    FROM note WHERE del = 0 AND domain = 1 AND dir = 0
    ORDER BY modifyTime DESC LIMIT 10
""")
for row in cur.fetchall():
    from datetime import datetime
    mtime = row['modifyTime']
    if mtime and mtime > 1e12:
        mtime = mtime / 1000
    ts = datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M") if mtime else "?"
    print(f"  {row['title'][:40]:<40} size={row['size']:>8}  mtime={ts}  ver={row['version']}")
    print(f"    fileId: {row['fileId'][:30]}...  md5: {row['md5'] or 'NULL'}")

print("\n" + "=" * 70)
print("  3. domain=1 文件在 file/ 目录中是否有缓存")
print("=" * 70)
cur.execute("SELECT fileId, title FROM note WHERE del = 0 AND domain = 1 AND dir = 0")
md_files = cur.fetchall()
cached = 0
not_cached = 0
sample_cached = []
for row in md_files:
    fid = row['fileId']
    bucket = fid[0].lower() if fid else "?"
    path = os.path.join(FILE_DIR, bucket, fid)
    if os.path.exists(path):
        cached += 1
        if len(sample_cached) < 3:
            sz = os.path.getsize(path)
            with open(path, "rb") as f:
                head = f.read(200)
            sample_cached.append((row['title'], sz, head))
    else:
        not_cached += 1

print(f"  有本地缓存:   {cached}/{len(md_files)}")
print(f"  无本地缓存:   {not_cached}/{len(md_files)}")
if sample_cached:
    print(f"\n  有缓存的 domain=1 文件样本:")
    for title, sz, head in sample_cached:
        print(f"    '{title}' ({sz} bytes)")
        print(f"      head: {head[:150]}")
        print()

print("\n" + "=" * 70)
print("  4. domain=1 文件在 content.db 中的内容")
print("=" * 70)
conn2 = sqlite3.connect(f"file:{CONTENT_DB}?mode=ro", uri=True)
conn2.row_factory = sqlite3.Row
cur2 = conn2.cursor()

md_file_ids = [r['fileId'] for r in md_files]
has_content = 0
no_content = 0
sample_contents = []
for fid in md_file_ids[:200]:
    cur2.execute("SELECT fileId, title, content, LENGTH(content) as clen FROM contenttable WHERE fileId = ?", (fid,))
    row = cur2.fetchone()
    if row and row['clen'] and row['clen'] > 0:
        has_content += 1
        if len(sample_contents) < 3:
            sample_contents.append((row['title'], row['clen'], row['content'][:500]))
    else:
        no_content += 1

print(f"  在 content.db 中有内容: {has_content}/{len(md_file_ids[:200])}")
print(f"  在 content.db 中无内容: {no_content}/{len(md_file_ids[:200])}")
if sample_contents:
    print(f"\n  content.db 中 domain=1 内容样本:")
    for title, clen, preview in sample_contents:
        print(f"  --- '{title}' ({clen} chars) ---")
        print(f"  {preview[:400]}")
        print()

print("\n" + "=" * 70)
print("  5. domain=1 在 backupNote/ 中是否有备份")
print("=" * 70)
backup_dir = os.path.join(USER_DIR, "backupNote")
backed_up = 0
not_backed = 0
for fid in md_file_ids:
    bp = os.path.join(backup_dir, fid)
    if os.path.isdir(bp) or os.path.isfile(bp):
        backed_up += 1
    else:
        not_backed += 1
print(f"  有备份:   {backed_up}/{len(md_file_ids)}")
print(f"  无备份:   {not_backed}/{len(md_file_ids)}")

conn.close()
conn2.close()
