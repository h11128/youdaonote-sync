"""
Session / Cookie 测试工具。

子命令:
  extract    从桌面客户端 setting.json 提取 cookies 信息
  test       用桌面客户端 cookies 直接调用 API
  refresh    用 cookies.json 登录并测试 session 刷新

用法:
  python tools/debug/test_session.py extract
  python tools/debug/test_session.py test
  python tools/debug/test_session.py refresh
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

APPDATA = os.environ.get("APPDATA", "")
SETTING_JSON = os.path.join(APPDATA, "ynote-desktop", "setting.json")


def cmd_extract(_args):
    if not os.path.exists(SETTING_JSON):
        print(f"  {SETTING_JSON} 不存在"); return

    with open(SETTING_JSON, "r", encoding="utf-8") as f:
        setting = json.load(f)

    print("=== cookies ===")
    cookies = setting.get("cookies", [])
    if isinstance(cookies, list):
        for c in cookies:
            name = c.get("name", "?")
            domain = c.get("domain", "?")
            expires = c.get("expirationDate", "?")
            val = str(c.get("value", ""))
            preview = val[:30] + f"...(len={len(val)})" if len(val) > 30 else val
            print(f"  {name:30s} domain={domain:35s} expires={expires}")
            print(f"    value: {preview}")

    print(f"\n=== userLogins ===")
    for u in setting.get("userLogins", []):
        print(f"  user: {u.get('userName')}")

    print(f"\n=== currentUser ===")
    for k, v in setting.get("currentUser", {}).items():
        print(f"  {k}: {str(v)[:80]}")


def cmd_test(_args):
    import httpx

    if not os.path.exists(SETTING_JSON):
        print(f"  {SETTING_JSON} 不存在"); return

    with open(SETTING_JSON, "r", encoding="utf-8") as f:
        setting = json.load(f)

    jar = httpx.Cookies()
    cstk = None
    for c in setting.get("cookies", []):
        name, value, domain = c.get("name", ""), c.get("value", ""), c.get("domain", "")
        if name and value and domain:
            jar.set(name, value, domain=domain, path=c.get("path", "/"))
        if name == "YNOTE_CSTK":
            cstk = value

    print(f"CSTK: {cstk}")
    client = httpx.Client(timeout=30.0, cookies=jar, follow_redirects=True)
    url = f"https://note.youdao.com/yws/api/personal/file?method=getByPath&keyfrom=web&cstk={cstk}"
    resp = client.post(url, data={"path": "/", "entire": "true", "purge": "false", "cstk": cstk})
    print(f"Status: {resp.status_code}")
    if resp.status_code == 200:
        body = resp.json()
        if "fileEntry" in body:
            print(f"SUCCESS! Root ID: {body['fileEntry']['id']}")
        else:
            print(f"Body keys: {list(body.keys())[:10]}")
    else:
        print(f"Body: {resp.text[:300]}")
    client.close()


def cmd_refresh(_args):
    from src.api import YoudaoNoteApi
    from src.cookies import CookieManager

    api = YoudaoNoteApi(cookies_path=CookieManager.get_default_path())
    err = api.login_by_cookies()
    if err:
        print(f"登录失败: {err}"); return
    print(f"登录成功, CSTK: {api.cstk}")
    try:
        root_id = api.get_root_id()
        print(f"获取根目录成功: {root_id}")
    except Exception as e:
        print(f"获取根目录失败: {e}")


def main():
    parser = argparse.ArgumentParser(description="Session/Cookie 测试")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("extract", help="从 setting.json 提取 cookies")
    sub.add_parser("test", help="用桌面 cookies 直接调 API")
    sub.add_parser("refresh", help="用 cookies.json 登录测试")

    args = parser.parse_args()
    dispatch = {"extract": cmd_extract, "test": cmd_test, "refresh": cmd_refresh}
    if args.command is None:
        parser.print_help(); return 1
    return dispatch[args.command](args) or 0


if __name__ == "__main__":
    sys.exit(main())
