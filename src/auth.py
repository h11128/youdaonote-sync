"""
浏览器认证模块

负责：
- Playwright 浏览器登录
- 自动刷新 cookies（headless 模式）
- 从浏览器提取 cookies（browser_cookie3）

从 __main__.py 和 CookieManager 提取而来，保持 SRP。
"""

import logging
import os
from typing import Dict, Optional, Tuple

from src.common import get_config_directory
from src.cookies import CookieManager


def get_browser_data_dir() -> str:
    """获取浏览器数据目录（用于持久化登录状态）"""
    return os.path.join(get_config_directory(), "browser_data")


def refresh_cookies_if_needed(headless: bool = True) -> bool:
    """
    使用 persistent context 尝试刷新 cookies。

    :param headless: 是否使用无头模式（后台刷新）
    :return: 是否成功刷新
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return False

    browser_data_dir = get_browser_data_dir()
    if not os.path.exists(browser_data_dir):
        return False

    print("🔄 正在尝试自动刷新 Cookies...")

    try:
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                browser_data_dir,
                headless=headless,
                viewport={'width': 1280, 'height': 800},
                locale='zh-CN'
            )

            page = context.pages[0] if context.pages else context.new_page()
            page.goto("https://note.youdao.com/web/",
                       wait_until="networkidle", timeout=30000)
            page.wait_for_timeout(3000)

            cookies = context.cookies()
            cookie_names = [c['name'] for c in cookies]

            if CookieManager.has_required_cookies(cookie_names):
                cookies_data, error = CookieManager.convert_playwright_cookies(cookies)
                if not error:
                    success, _ = CookieManager.save(cookies_data)
                    if success:
                        print("✅ Cookies 已自动刷新")
                        context.close()
                        return True

            context.close()
            return False

    except Exception as e:
        logging.debug(f"自动刷新 cookies 失败: {e}")
        return False


def try_cookie_login(context) -> bool:
    """检查已有浏览器状态中是否有有效 cookies，有则保存并返回 True。"""
    cookies = context.cookies()
    cookie_names = [c['name'] for c in cookies]
    if not CookieManager.has_required_cookies(cookie_names):
        return False

    print("✅ 检测到已有登录状态，正在验证...")
    cookies_data, error = CookieManager.convert_playwright_cookies(cookies)
    if error:
        return False
    success, _ = CookieManager.save(cookies_data)
    if success:
        print(f"✅ Cookies 已更新: {CookieManager.get_default_path()}")
        print("\n🎉 登录状态有效！可以直接使用：")
        print("  python -m src pull")
        return True
    return False


def wait_for_browser_login(context, page) -> int:
    """打开登录页面并等待用户完成登录。返回 0 表示成功，1 表示失败。"""
    print("🚀 正在启动浏览器...")
    print("📌 请在弹出的浏览器窗口中完成登录")
    print("📌 支持：扫码登录 / 账号密码登录")
    print("📌 登录成功后，程序会自动检测并保存 Cookies")
    print("📌 下次运行 login 时将自动复用登录状态\n")

    print("🌐 正在打开有道云笔记...")
    page.goto("https://note.youdao.com/web/")

    print("\n⏳ 等待登录完成...")
    print("   （登录成功后会自动继续，最长等待 5 分钟）\n")

    max_wait, interval, waited = 300, 2, 0
    while waited < max_wait:
        cookies = context.cookies()
        if CookieManager.has_required_cookies([c['name'] for c in cookies]):
            print("🎉 检测到登录成功！")
            break
        page.wait_for_timeout(interval * 1000)
        waited += interval
        if waited % 10 == 0:
            print(f"   已等待 {waited} 秒...")

    if waited >= max_wait:
        print("❌ 等待超时，请重试")
        return 1

    page.wait_for_timeout(2000)
    print("\n🔍 正在提取 Cookies...")
    cookies = context.cookies()

    cookies_data, error = CookieManager.convert_playwright_cookies(cookies)
    if error:
        print(f"\n❌ 转换 cookies 失败: {error}")
        return 1

    success, error = CookieManager.save(cookies_data)
    if not success:
        print(f"\n❌ 保存失败: {error}")
        return 1

    print(f"\n✅ Cookies 已保存到: {CookieManager.get_default_path()}")
    print("\n" + "=" * 60)
    print("🎉 登录成功！现在可以使用以下命令：")
    print("=" * 60)
    print("\n  python -m src pull      # 全量导出")
    print("  python -m src gui       # 图形界面")
    print("  python -m src search XX # 搜索笔记")
    print("\n📌 提示：下次运行 login 时将自动复用登录状态\n")
    return 0


def browser_login() -> int:
    """执行浏览器登录流程，返回 0 表示成功。"""
    print("\n" + "=" * 60)
    print("  有道云笔记登录")
    print("=" * 60 + "\n")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("❌ 未安装 Playwright，请执行以下命令安装：")
        print("\n  pip install playwright")
        print("  playwright install chromium\n")
        return 1

    browser_data_dir = get_browser_data_dir()
    os.makedirs(browser_data_dir, exist_ok=True)

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            browser_data_dir, headless=False,
            viewport={'width': 1280, 'height': 800},
            locale='zh-CN', args=['--start-maximized'])
        try:
            if try_cookie_login(context):
                return 0
            page = context.pages[0] if context.pages else context.new_page()
            return wait_for_browser_login(context, page)
        except Exception as e:
            print(f"\n❌ 发生错误: {e}")
            return 1
        finally:
            context.close()


def extract_cookies_from_browser() -> Tuple[Optional[Dict], str]:
    """
    从本地浏览器（Chrome/Edge/Firefox 等）自动提取 cookies。
    需要安装 browser_cookie3 库。

    :return: (cookies_data dict 或 None, 错误信息)
    """
    try:
        import browser_cookie3
    except ImportError:
        return None, "请先安装 browser-cookie3: pip install browser-cookie3"

    found_cookies = {}
    browsers = [
        ('Chrome', browser_cookie3.chrome),
        ('Edge', browser_cookie3.edge),
        ('Firefox', browser_cookie3.firefox),
        ('Chromium', browser_cookie3.chromium),
    ]

    for browser_name, browser_func in browsers:
        try:
            cj = browser_func(domain_name='.note.youdao.com')
            for cookie in cj:
                if cookie.name in CookieManager.REQUIRED_COOKIES:
                    found_cookies[cookie.name] = cookie.value
            if len(found_cookies) == len(CookieManager.REQUIRED_COOKIES):
                break
        except Exception:
            continue

    if len(found_cookies) != len(CookieManager.REQUIRED_COOKIES):
        missing = CookieManager._find_missing_cookies(found_cookies.keys())
        return None, f"未能提取到所有必需的 cookies，缺少: {', '.join(missing)}"

    cookies_data = CookieManager.create_from_dict(found_cookies)
    return cookies_data, ""
