"""详细对比 content.db vs API 的字节级差异"""
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

conn = sqlite3.connect(f"file:{USER_DB}?mode=ro", uri=True)
cur = conn.cursor()
conn2 = sqlite3.connect(f"file:{CONTENT_DB}?mode=ro", uri=True)
cur2 = conn2.cursor()

fid = "WEB591ffb63a72a608e146e83c41fd"
cur.execute("SELECT fileId FROM note WHERE del = 0 AND domain = 1 AND fileId LIKE ?", (f"{fid}%",))
full_fid = cur.fetchone()[0]
print(f"Full fileId: {full_fid}")

cur2.execute("SELECT content FROM contenttable WHERE fileId = ?", (full_fid,))
local = cur2.fetchone()[0]

resp = api.get_file_by_id(full_fid)
remote = resp.content.decode("utf-8", errors="replace")

print(f"Local  len: {len(local)}")
print(f"Remote len: {len(remote)}")

local_b = local.encode("utf-8")
remote_b = remote.encode("utf-8")

for i in range(min(len(local_b), len(remote_b))):
    if local_b[i] != remote_b[i]:
        ctx_start = max(0, i - 20)
        ctx_end = min(len(local_b), i + 20)
        print(f"\n  第一个差异在字节 {i}:")
        print(f"    local[{i}]  = 0x{local_b[i]:02x} '{chr(local_b[i]) if 32 <= local_b[i] < 127 else '?'}'")
        print(f"    remote[{i}] = 0x{remote_b[i]:02x} '{chr(remote_b[i]) if 32 <= remote_b[i] < 127 else '?'}'")
        print(f"    local  context: {local_b[ctx_start:ctx_end]}")
        print(f"    remote context: {remote_b[ctx_start:ctx_end]}")
        break

if len(local_b) != len(remote_b):
    print(f"\n  尾部差异:")
    print(f"    local  末尾 20 字节: {local_b[-20:]}")
    print(f"    remote 末尾 20 字节: {remote_b[-20:]}")

# 用 normalize 后比较
from src.sync.utils import normalize_md_formatting
local_norm = normalize_md_formatting(local)
remote_norm = normalize_md_formatting(remote)
print(f"\n  归一化后一致？ {local_norm == remote_norm}")

# 统计所有 domain=1 文件归一化后的一致率
cur.execute("SELECT fileId, title FROM note WHERE del = 0 AND domain = 1 AND dir = 0 ORDER BY modifyTime DESC LIMIT 20")
files = cur.fetchall()
match_count = 0
mismatch_count = 0
no_content = 0
api_fail = 0
for fid, title in files:
    cur2.execute("SELECT content FROM contenttable WHERE fileId = ?", (fid,))
    row = cur2.fetchone()
    if not row or not row[0]:
        no_content += 1
        continue
    try:
        resp = api.get_file_by_id(fid)
        api_text = resp.content.decode("utf-8", errors="replace")
    except Exception:
        api_fail += 1
        continue
    ln = normalize_md_formatting(row[0])
    rn = normalize_md_formatting(api_text)
    if ln == rn:
        match_count += 1
    else:
        mismatch_count += 1
        print(f"  归一化后仍不一致: {title}")

print(f"\n归一化对比 (前 20 个 domain=1 文件):")
print(f"  一致:     {match_count}")
print(f"  不一致:   {mismatch_count}")
print(f"  无内容:   {no_content}")
print(f"  API失败:  {api_fail}")

conn.close()
conn2.close()
