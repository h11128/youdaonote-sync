"""进一步测试有道增量同步 API"""
import os
import sys
import json

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from src.api import YoudaoNoteApi

api = YoudaoNoteApi()
msg = api.login_by_cookies()
if msg:
    print(f"Login failed: {msg}")
    sys.exit(1)

cstk = api.cstk
base = "https://note.youdao.com"

# 先拿到 root dir id
root_url = f"{base}/yws/api/personal/file?method=getByPath&keyfrom=web&cstk={cstk}"
resp = api.http_post(root_url, data={"path": "/"})
root_data = resp.json()
root_id = root_data.get("fileEntry", {}).get("id", "unknown")
root_version = root_data.get("fileEntry", {}).get("version", 0)
print(f"Root ID: {root_id}")
print(f"Root version (cloud): {root_version}")

local_version = 52852
print(f"Local version: {local_version}")
print(f"Version diff: {root_version - local_version}")

# 试增量获取
print("\n" + "=" * 60)
print("  尝试各种增量 API")
print("=" * 60)

test_cases = [
    ("POST listByVersion", f"{base}/yws/api/personal/file?method=listByVersion&keyfrom=web&cstk={cstk}",
     {"version": local_version, "limit": 20}),
    ("POST listAfterVersion", f"{base}/yws/api/personal/file?method=listAfterVersion&keyfrom=web&cstk={cstk}",
     {"version": local_version, "limit": 20}),
    ("POST getChanges", f"{base}/yws/api/personal/file?method=getChanges&keyfrom=web&cstk={cstk}",
     {"version": local_version, "limit": 20}),
    ("POST delta", f"{base}/yws/api/personal/delta?keyfrom=web&cstk={cstk}",
     {"version": local_version}),
    ("POST sync/delta", f"{base}/yws/api/personal/sync/delta?keyfrom=web&cstk={cstk}",
     {"version": local_version}),
    ("POST listRecent big", f"{base}/yws/api/personal/file?method=listRecent&keyfrom=web&cstk={cstk}",
     {"offset": 0, "limit": 30}),
    ("POST listSince", f"{base}/yws/api/personal/file?method=listSince&keyfrom=web&cstk={cstk}",
     {"version": local_version, "limit": 20}),
    ("POST getModified", f"{base}/yws/api/personal/file?method=getModified&keyfrom=web&cstk={cstk}",
     {"version": local_version}),
]

for name, url, data in test_cases:
    print(f"\n  {name}:")
    try:
        resp = api.http_post(url, data=data)
        print(f"    status: {resp.status_code}")
        if resp.status_code == 200:
            try:
                rdata = resp.json()
                if isinstance(rdata, list):
                    print(f"    返回 {len(rdata)} 条")
                    for entry in rdata[:3]:
                        if isinstance(entry, dict) and 'fileEntry' in entry:
                            fe = entry['fileEntry']
                            print(f"      name={fe.get('name','?')}, ver={fe.get('version','?')}, domain={fe.get('domain','?')}")
                        else:
                            print(f"      {json.dumps(entry, ensure_ascii=False)[:120]}")
                elif isinstance(rdata, dict):
                    print(f"    keys: {list(rdata.keys())[:10]}")
                    if 'entries' in rdata:
                        entries = rdata['entries']
                        print(f"    entries: {len(entries)} 条")
                    else:
                        for k, v in list(rdata.items())[:3]:
                            sv = json.dumps(v, ensure_ascii=False)[:100] if not isinstance(v, str) else v[:100]
                            print(f"      {k}: {sv}")
            except Exception:
                print(f"    text: {resp.text[:200]}")
        else:
            print(f"    body: {resp.text[:150]}")
    except Exception as e:
        err_str = str(e)
        print(f"    error: {err_str[:150]}")

# 测试 version 查询
print("\n" + "=" * 60)
print("  使用 listRecent 模拟增量：获取 version > local 的条目")
print("=" * 60)
resp = api.http_post(
    f"{base}/yws/api/personal/file?method=listRecent&keyfrom=web&cstk={cstk}",
    data={"offset": 0, "limit": 100}
)
if resp.status_code == 200:
    entries = resp.json()
    newer = [e for e in entries if e.get("fileEntry", {}).get("version", 0) > local_version]
    print(f"  总共返回 {len(entries)} 条, 其中 version > {local_version} 的: {len(newer)} 条")
    for e in newer[:10]:
        fe = e["fileEntry"]
        print(f"    v={fe['version']} name={fe.get('name','?')} domain={fe.get('domain','?')} dir={fe.get('dir',False)}")
