"""用桌面客户端的 cookies 测试 API 是否可用"""
import os
import sys
import json
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import httpx

APPDATA = os.environ["APPDATA"]
SETTING_JSON = os.path.join(APPDATA, "ynote-desktop", "setting.json")

with open(SETTING_JSON, "r", encoding="utf-8") as f:
    setting = json.load(f)

cookies_list = setting.get("cookies", [])
cstk = None
jar = httpx.Cookies()

for c in cookies_list:
    name = c.get("name", "")
    value = c.get("value", "")
    domain = c.get("domain", "")
    path = c.get("path", "/")
    if name and value and domain:
        jar.set(name, value, domain=domain, path=path)
    if name == "YNOTE_CSTK":
        cstk = value

print(f"CSTK from desktop: {cstk}")
print(f"Cookie count: {len(cookies_list)}")

client = httpx.Client(
    timeout=30.0,
    cookies=jar,
    follow_redirects=True,
)

url = f"https://note.youdao.com/yws/api/personal/file?method=getByPath&keyfrom=web&cstk={cstk}"
data = {"path": "/", "entire": "true", "purge": "false", "cstk": cstk}

print(f"\nTesting API with desktop cookies...")
resp = client.post(url, data=data)
print(f"Status: {resp.status_code}")

if resp.status_code == 200:
    body = resp.json()
    if "fileEntry" in body:
        root_id = body["fileEntry"]["id"]
        print(f"SUCCESS! Root ID: {root_id}")
    else:
        print(f"Body keys: {list(body.keys())[:10]}")
else:
    print(f"Body: {resp.text[:300]}")

client.close()
