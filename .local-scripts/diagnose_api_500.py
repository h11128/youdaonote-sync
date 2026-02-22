"""诊断有道 API 500 错误的原因"""
import os
import sys
import time
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import httpx
from src.api import YoudaoNoteApi

config_path = os.path.join(os.path.dirname(__file__), '..', 'config')
api = YoudaoNoteApi(cookies_path=os.path.join(config_path, 'cookies.json'))

err = api.login_by_cookies()
if err:
    print(f"Cookie 登录失败: {err}")
    sys.exit(1)

print("Cookie 加载成功")
print(f"CSTK: {api.cstk[:8]}...")

# 1. 试一个简单的 API 调用，捕获完整响应
url = api.ROOT_ID_URL.format(cstk=api.cstk)
data = {"path": "/", "entire": "true", "purge": "false", "cstk": api.cstk}

print(f"\n--- 请求 1: get_root_dir_info_id ---")
print(f"URL: {url}")
try:
    resp = api.session.post(url, data=data)
    print(f"Status: {resp.status_code}")
    print(f"Headers:")
    for k, v in resp.headers.items():
        if k.lower() in ('content-type', 'set-cookie', 'x-ratelimit-remaining',
                         'x-ratelimit-limit', 'retry-after', 'www-authenticate',
                         'server', 'date'):
            print(f"  {k}: {v}")
    body = resp.text[:500]
    print(f"Body: {body}")
except Exception as e:
    print(f"Error: {e}")

# 2. 等 2 秒试一个轻量级 API
time.sleep(2)
print(f"\n--- 请求 2: 用户信息 (轻量) ---")
user_url = f"https://note.youdao.com/yws/api/personal/user?method=get&keyfrom=web&cstk={api.cstk}"
try:
    resp = api.session.post(user_url, data={"cstk": api.cstk})
    print(f"Status: {resp.status_code}")
    body = resp.text[:500]
    print(f"Body: {body}")
except Exception as e:
    print(f"Error: {e}")

# 3. 检查 cookies 有效性
print(f"\n--- Cookie 信息 ---")
for name, value in api.session.cookies.items():
    if name in ('YNOTE_CSTK', 'YNOTE_SESS', 'YNOTE_LOGIN'):
        print(f"  {name}: {value[:20]}... (len={len(value)})")
    else:
        print(f"  {name}: (present)")
