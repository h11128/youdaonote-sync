"""对比 domain=1 文件：content.db 内容 vs API 下载内容"""
import os
import sys
import sqlite3

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

APPDATA = os.environ["APPDATA"]
USER_DIR = os.path.join(APPDATA, "ynote-desktop", "h11128@163.com", "ynote-data")
USER_DB = os.path.join(USER_DIR, "h11128@163.com.db")
CONTENT_DB = os.path.join(USER_DIR, "h11128@163.com-content.db")

from src.api import YoudaoNoteApi

api = YoudaoNoteApi()
msg = api.login_by_cookies()
if msg:
    print(f"Login failed: {msg}")
    sys.exit(1)
print("Login OK")

conn = sqlite3.connect(f"file:{USER_DB}?mode=ro", uri=True)
cur = conn.cursor()
conn2 = sqlite3.connect(f"file:{CONTENT_DB}?mode=ro", uri=True)
cur2 = conn2.cursor()

cur.execute("""
    SELECT fileId, title, size FROM note
    WHERE del = 0 AND domain = 1 AND dir = 0
    ORDER BY modifyTime DESC LIMIT 5
""")
files = cur.fetchall()

for fid, title, db_size in files:
    print(f"\n{'=' * 60}")
    print(f"  {title} (fileId: {fid[:30]}...)")
    print(f"  note表 size: {db_size}")

    # content.db 内容
    cur2.execute("SELECT content, LENGTH(content) as clen FROM contenttable WHERE fileId = ?", (fid,))
    row = cur2.fetchone()
    if row and row[0]:
        local_content = row[0]
        print(f"  content.db 长度: {row[1]} chars")
    else:
        local_content = None
        print(f"  content.db: 无内容")

    # API 下载
    try:
        resp = api.get_file_by_id(fid)
        api_content = resp.content.decode("utf-8", errors="replace")
        print(f"  API 下载长度: {len(api_content)} chars")
    except Exception as e:
        api_content = None
        print(f"  API 下载失败: {e}")

    if local_content and api_content:
        if local_content == api_content:
            print(f"  ✅ 完全一致")
        else:
            # 找出差异
            local_lines = local_content.splitlines()
            api_lines = api_content.splitlines()
            print(f"  ❌ 不一致 (content.db: {len(local_lines)} 行, API: {len(api_lines)} 行)")
            diffs = 0
            for i, (ll, al) in enumerate(zip(local_lines, api_lines)):
                if ll != al:
                    diffs += 1
                    if diffs <= 5:
                        print(f"    行 {i+1} 差异:")
                        print(f"      content.db: {ll[:100]}")
                        print(f"      API:        {al[:100]}")
            if len(local_lines) != len(api_lines):
                print(f"    行数差: content.db={len(local_lines)}, API={len(api_lines)}")
            print(f"    总差异行数: {diffs}")
    print()

conn.close()
conn2.close()
