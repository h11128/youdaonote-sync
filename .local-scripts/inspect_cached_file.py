"""直接从 file/ 目录读一个文件看格式"""
import os
import sys
import sqlite3
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

APPDATA = os.environ["APPDATA"]
USER_DIR = os.path.join(APPDATA, "ynote-desktop", "h11128@163.com", "ynote-data")
USER_DB = os.path.join(USER_DIR, "h11128@163.com.db")
FILE_DIR = os.path.join(USER_DIR, "file")

# 直接列出 file/0/ 的前几个文件
bucket = os.path.join(FILE_DIR, "0")
files = os.listdir(bucket)[:3]
print(f"file/0/ 前 3 个: {files}")

conn = sqlite3.connect(f"file:{USER_DB}?mode=ro", uri=True)
cur = conn.cursor()

for fname in files:
    fpath = os.path.join(bucket, fname)
    sz = os.path.getsize(fpath)

    cur.execute("SELECT title, domain, entryType, dir FROM note WHERE fileId = ?", (fname,))
    row = cur.fetchone()
    if not row:
        cur.execute("SELECT title, domain, entryType, dir FROM note_book WHERE fileId = ?", (fname,))
        row = cur.fetchone()

    title = row[0] if row else "unknown"
    domain = row[1] if row else "?"
    is_dir = row[3] if row else 0

    print(f"\n  ID: {fname}")
    print(f"  Title: {title}")
    print(f"  Domain: {domain}, IsDir: {is_dir}")
    print(f"  Size: {sz} bytes")

    with open(fpath, "rb") as f:
        raw = f.read(1000)

    # 检测格式
    if raw[:5] == b'<?xml':
        print(f"  Format: XML")
    elif raw[:1] == b'#' or raw[:2] == b'\xef\xbb':
        print(f"  Format: Markdown/Text")
    elif raw[:4] == b'\x1f\x8b':
        print(f"  Format: Gzip compressed")
    elif raw[:2] == b'\x78\x9c' or raw[:2] == b'\x78\x01':
        print(f"  Format: Zlib compressed")
    elif b'<html' in raw[:200] or b'<!DOCTYPE' in raw[:200]:
        print(f"  Format: HTML")
    elif b'<note' in raw[:200]:
        print(f"  Format: Youdao .note XML")
    else:
        print(f"  Format: Unknown (first 20 bytes: {raw[:20]})")

    try:
        text = raw.decode("utf-8", errors="replace")
        print(f"  Text preview: {text[:400]}")
    except:
        print(f"  Binary: {raw[:100]}")

conn.close()

# 也查一下 .md 文件
print("\n\n=== 查找一个 .md 文件 ===")
cur2 = sqlite3.connect(f"file:{USER_DB}?mode=ro", uri=True).cursor()
cur2.execute("SELECT fileId, title FROM note WHERE del = 0 AND title LIKE '%.md' AND fileId NOT LIKE 'WEB%' LIMIT 3")
for fid, title in cur2.fetchall():
    bucket = fid[0].lower()
    path = os.path.join(FILE_DIR, bucket, fid)
    if os.path.exists(path):
        sz = os.path.getsize(path)
        with open(path, "rb") as f:
            raw = f.read(500)
        print(f"\n  {fid} '{title}' ({sz} bytes)")
        print(f"    {raw[:300]}")
    else:
        print(f"\n  {fid} '{title}' → NOT FOUND on disk")
