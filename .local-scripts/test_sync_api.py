"""测试有道增量同步 API — 桌面客户端用这个 API 更新本地数据"""
import os
import sys
import sqlite3
import json

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.api import YoudaoNoteApi

api = YoudaoNoteApi()
msg = api.login_by_cookies()
if msg:
    print(f"Login failed: {msg}")
    sys.exit(1)
print("Login OK\n")

APPDATA = os.environ["APPDATA"]
USER_DB = os.path.join(APPDATA, "ynote-desktop", "h11128@163.com", "ynote-data", "h11128@163.com.db")

conn = sqlite3.connect(f"file:{USER_DB}?mode=ro", uri=True)
cur = conn.cursor()
cur.execute("SELECT version FROM root LIMIT 1")
local_version = cur.fetchone()[0]
conn.close()
print(f"本地 root.version: {local_version}")

cstk = api.cstk
base = "https://note.youdao.com"

# 1. 试 getSyncProgress — 获取云端最新 version
print("\n" + "=" * 60)
print("  1. 获取云端最新 version")
print("=" * 60)

urls_to_try = [
    f"{base}/yws/api/personal/user?method=get&keyfrom=web&cstk={cstk}",
]
for url in urls_to_try:
    print(f"\n  GET {url[:80]}...")
    try:
        resp = api.http_get(url)
        print(f"  status: {resp.status_code}")
        data = resp.json() if resp.status_code == 200 else resp.text[:300]
        if isinstance(data, dict):
            for k in ['lastModifyTime', 'version', 'rootVersion', 'totalSize', 'usedSize']:
                if k in data:
                    print(f"    {k}: {data[k]}")
            if 'version' not in data and 'rootVersion' not in data:
                print(f"    keys: {list(data.keys())[:20]}")
        else:
            print(f"    response: {data}")
    except Exception as e:
        print(f"  error: {e}")

# 2. 增量同步 API
print("\n" + "=" * 60)
print("  2. 增量同步 API (从 local_version 开始)")
print("=" * 60)

sync_urls = [
    f"{base}/yws/api/personal/sync?version={local_version}&keyfrom=web&cstk={cstk}",
    f"{base}/yws/api/personal/sync/list?version={local_version}&keyfrom=web&cstk={cstk}",
    f"{base}/yws/api/personal/file?method=getByVersion&version={local_version}&keyfrom=web&cstk={cstk}",
    f"{base}/yws/api/personal/sync/meta?version={local_version}&keyfrom=web&cstk={cstk}",
]
for url in sync_urls:
    short_url = url.split("?")[0]
    print(f"\n  GET {short_url}...")
    try:
        resp = api.http_get(url)
        print(f"  status: {resp.status_code}")
        if resp.status_code == 200:
            try:
                data = resp.json()
                if isinstance(data, list):
                    print(f"    返回列表: {len(data)} 条")
                    if data:
                        print(f"    第一条: {json.dumps(data[0], ensure_ascii=False)[:200]}")
                elif isinstance(data, dict):
                    print(f"    keys: {list(data.keys())[:15]}")
                    for k, v in list(data.items())[:5]:
                        sv = json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v
                        print(f"    {k}: {sv[:150]}")
            except Exception:
                print(f"    text: {resp.text[:300]}")
        else:
            print(f"    text: {resp.text[:300]}")
    except Exception as e:
        print(f"  error: {e}")

# 3. POST 方式
print("\n" + "=" * 60)
print("  3. POST 增量同步")
print("=" * 60)
post_urls = [
    (f"{base}/yws/api/personal/sync?keyfrom=web&cstk={cstk}",
     {"version": local_version}),
    (f"{base}/yws/api/personal/file?method=listRecent&keyfrom=web&cstk={cstk}",
     {"offset": 0, "limit": 10}),
]
for url, data in post_urls:
    short_url = url.split("?")[0]
    print(f"\n  POST {short_url}...")
    try:
        resp = api.http_post(url, data=data)
        print(f"  status: {resp.status_code}")
        if resp.status_code == 200:
            try:
                rdata = resp.json()
                if isinstance(rdata, list):
                    print(f"    返回列表: {len(rdata)} 条")
                    if rdata:
                        entry = rdata[0]
                        if isinstance(entry, dict) and 'fileEntry' in entry:
                            fe = entry['fileEntry']
                            print(f"    第一条: id={fe.get('id','?')[:20]}, name={fe.get('name','?')}, version={fe.get('version','?')}")
                        else:
                            print(f"    第一条: {json.dumps(entry, ensure_ascii=False)[:200]}")
                elif isinstance(rdata, dict):
                    print(f"    keys: {list(rdata.keys())[:15]}")
                    for k, v in list(rdata.items())[:3]:
                        sv = json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else v
                        print(f"    {k}: {sv[:200]}")
            except Exception:
                print(f"    text: {resp.text[:300]}")
        else:
            print(f"    text: {resp.text[:300]}")
    except Exception as e:
        print(f"  error: {e}")
