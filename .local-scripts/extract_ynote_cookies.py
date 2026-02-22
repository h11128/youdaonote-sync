"""从有道桌面客户端 setting.json 提取 cookies 信息"""
import os
import sys
import json

APPDATA = os.environ["APPDATA"]
SETTING_JSON = os.path.join(APPDATA, "ynote-desktop", "setting.json")

with open(SETTING_JSON, "r", encoding="utf-8") as f:
    setting = json.load(f)

print("=== cookies ===")
cookies = setting.get("cookies", [])
if isinstance(cookies, list):
    for c in cookies:
        name = c.get("name", "?")
        domain = c.get("domain", "?")
        path = c.get("path", "/")
        expires = c.get("expirationDate", "?")
        http_only = c.get("httpOnly", False)
        value_preview = str(c.get("value", ""))
        if len(value_preview) > 30:
            value_preview = value_preview[:30] + f"...(len={len(c.get('value', ''))})"
        print(f"  {name:30s} domain={domain:35s} expires={expires} httpOnly={http_only}")
        print(f"    value: {value_preview}")
elif isinstance(cookies, dict):
    for name, val in cookies.items():
        print(f"  {name}: {str(val)[:60]}")

print(f"\n=== userLogins ===")
logins = setting.get("userLogins", [])
for u in logins:
    print(f"  user: {u.get('userName')}")
    print(f"  pass hash: {u.get('password', '?')[:16]}...")

print(f"\n=== currentUser ===")
cu = setting.get("currentUser", {})
for k, v in cu.items():
    print(f"  {k}: {str(v)[:80]}")

print(f"\n=== 关键: rootData ===")
rd = setting.get("rootData")
if rd:
    print(f"  type: {type(rd)}")
    if isinstance(rd, dict):
        for k, v in rd.items():
            print(f"  {k}: {str(v)[:100]}")
    else:
        print(f"  value: {str(rd)[:200]}")
