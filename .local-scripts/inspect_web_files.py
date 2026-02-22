"""检查 WEB* 前缀文件的存储情况"""
import os
import sys
import sqlite3
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

APPDATA = os.environ["APPDATA"]
USER_DIR = os.path.join(APPDATA, "ynote-desktop", "h11128@163.com", "ynote-data")
USER_DB = os.path.join(USER_DIR, "h11128@163.com.db")
CONTENT_DB = os.path.join(USER_DIR, "h11128@163.com-content.db")
FILE_DIR = os.path.join(USER_DIR, "file")

conn = sqlite3.connect(f"file:{USER_DB}?mode=ro", uri=True)
cur = conn.cursor()

# WEB vs non-WEB 统计
cur.execute("SELECT COUNT(*) FROM note WHERE del = 0 AND fileId LIKE 'WEB%'")
web_count = cur.fetchone()[0]
cur.execute("SELECT COUNT(*) FROM note WHERE del = 0 AND fileId NOT LIKE 'WEB%'")
nonweb_count = cur.fetchone()[0]
print(f"WEB前缀笔记: {web_count}")
print(f"非WEB前缀笔记: {nonweb_count}")

# 检查一个非 WEB 文件是否在磁盘上
cur.execute("SELECT fileId, title FROM note WHERE del = 0 AND fileId NOT LIKE 'WEB%' LIMIT 3")
print("\n非WEB文件磁盘检查:")
for fid, title in cur.fetchall():
    bucket = fid[0].lower()
    path = os.path.join(FILE_DIR, bucket, fid)
    exists = os.path.exists(path)
    print(f"  {fid[:20]}... '{title}' → exists={exists}")
    if exists:
        with open(path, "rb") as f:
            raw = f.read(300)
        print(f"    size: {os.path.getsize(path)}, preview: {raw[:200]}")

# content.db 是否有 WEB 文件的内容？
conn2 = sqlite3.connect(f"file:{CONTENT_DB}?mode=ro", uri=True)
cur2 = conn2.cursor()
cur2.execute("SELECT COUNT(*) FROM contenttable WHERE fileId LIKE 'WEB%'")
web_content = cur2.fetchone()[0]
cur2.execute("SELECT COUNT(*) FROM contenttable WHERE fileId NOT LIKE 'WEB%'")
nonweb_content = cur2.fetchone()[0]
print(f"\ncontent.db: WEB={web_content}, 非WEB={nonweb_content}")

# 看一个有内容的样本
cur2.execute("SELECT fileId, title, LENGTH(content) as len, SUBSTR(content, 1, 300) as preview FROM contenttable WHERE fileId NOT LIKE 'WEB%' AND LENGTH(content) > 100 LIMIT 1")
row = cur2.fetchone()
if row:
    print(f"\n非WEB内容样本:")
    print(f"  fileId: {row[0]}, title: {row[1]}, len: {row[2]}")
    print(f"  preview: {row[3][:300]}")

# WEB 文件 domain 分布
cur.execute("SELECT domain, COUNT(*) FROM note WHERE del = 0 AND fileId LIKE 'WEB%' GROUP BY domain")
print(f"\nWEB文件 domain 分布:")
for dom, cnt in cur.fetchall():
    print(f"  domain={dom}: {cnt}")

# 非 WEB 文件的格式 (entryType)
cur.execute("SELECT title FROM note WHERE del = 0 AND fileId NOT LIKE 'WEB%' ORDER BY modifyTime DESC LIMIT 10")
print(f"\n非WEB最近的文件名:")
for row in cur.fetchall():
    print(f"  {row[0]}")

conn.close()
conn2.close()
