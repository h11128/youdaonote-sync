#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
有道云笔记命令行工具
统一的 CLI 入口
"""

import argparse
import logging
import os
import sys
import time
import traceback
from typing import List, Dict

import requests

from youdaonote import log
from youdaonote.api import YoudaoNoteApi
from youdaonote.common import format_file_size, load_config
from youdaonote.transfer.search import YoudaoNoteSearch
from youdaonote.transfer.download import YoudaoNoteDownload
from youdaonote.cookies import CookieManager


class YoudaoNoteCLI:
    """有道云笔记命令行工具"""

    def __init__(self, cookies_path=None):
        self.youdaonote_api = None
        self.search_engine = None
        self.download_engine = None
        self.cookies_path = cookies_path or CookieManager.get_default_path()

    def init_api(self, auto_refresh: bool = True):
        """
        初始化 API
        
        :param auto_refresh: 如果 cookie 失效，是否自动尝试刷新
        """
        self.youdaonote_api = YoudaoNoteApi(cookies_path=self.cookies_path)
        error_msg = self.youdaonote_api.login_by_cookies()
        
        if error_msg:
            logging.warning(f"Cookie 登录失败: {error_msg}")
            
            # 尝试自动刷新 cookies
            if auto_refresh and _refresh_cookies_if_needed(headless=True):
                # 刷新成功，重新尝试登录
                self.youdaonote_api = YoudaoNoteApi(cookies_path=self.cookies_path)
                error_msg = self.youdaonote_api.login_by_cookies()
                if not error_msg:
                    logging.info("登录成功（自动刷新后）!")
                    self.search_engine = YoudaoNoteSearch(self.youdaonote_api)
                    self.download_engine = YoudaoNoteDownload(self.youdaonote_api)
                    return True
            
            # 自动刷新失败，提示用户手动登录
            print("❌ Cookie 已过期，请运行以下命令重新登录：")
            print("   python -m youdaonote login")
            return False
        
        logging.info("登录成功!")
        self.search_engine = YoudaoNoteSearch(self.youdaonote_api)
        self.download_engine = YoudaoNoteDownload(self.youdaonote_api)
        return True

    def list_directory(self, path: str = None, max_depth: int = 2):
        """列出目录内容"""
        if not self.search_engine and not self.init_api():
            return
        
        if path:
            folder_id = self.search_engine.find_folder_by_path(path)
            if not folder_id:
                print(f"❌ 未找到路径: {path}")
                return
            print(f"📁 目录内容 ({path}):")
        else:
            folder_id = None
            print("📁 根目录内容:")
        
        self._print_directory(folder_id, "", max_depth, 0)
    
    def _print_directory(self, dir_id: str, current_path: str, 
                         max_depth: int, current_depth: int):
        """递归打印目录"""
        if current_depth >= max_depth:
            return
        
        try:
            entries = self.search_engine.get_directory_entries(dir_id)
            folders = [e for e in entries if e['is_dir']]
            files = [e for e in entries if not e['is_dir']]
            
            indent = "  " * current_depth
            
            for folder in folders:
                print(f"{indent}📁 {folder['name']}")
                if current_depth < max_depth - 1:
                    self._print_directory(
                        folder['id'], 
                        f"{current_path}/{folder['name']}", 
                        max_depth, 
                        current_depth + 1
                    )
            
            for file in files:
                size = file.get('size', 0)
                size_str = format_file_size(size)
                print(f"{indent}📄 {file['name']} ({size_str})")
                
        except Exception as e:
            logging.error(f"列出目录时出错: {e}")

    def search(self, name: str, search_type: str = "all", exact_match: bool = False):
        """搜索文件或文件夹"""
        if not self.search_engine and not self.init_api():
            return []

        print(f"🔍 搜索 '{name}' ...")
        results = self.search_engine.search_by_name(name, search_type, exact_match)

        if not results:
            print("❌ 未找到匹配的项目")
            return []

        print(f"✅ 找到 {len(results)} 个匹配项:")
        for i, item in enumerate(results, 1):
            icon = "📁" if item['is_dir'] else "📄"
            print(f"  {i}. {icon} {item['path']}")
        
        return results

    def download(self, name: str, search_type: str = "all", 
                 exact_match: bool = False, local_dir: str = "./youdaonote"):
        """搜索并下载"""
        if not self.search_engine and not self.init_api():
            return False
        
        results = self.search_engine.search_by_name(name, search_type, exact_match)
        
        if not results:
            print("❌ 未找到匹配的项目")
            return False
        
        print(f"✅ 找到 {len(results)} 个匹配项:")
        for i, item in enumerate(results, 1):
            icon = "📁" if item['is_dir'] else "📄"
            print(f"  {i}. {icon} {item['path']}")
        
        if len(results) > 1:
            print(f"\n请选择要下载的项目 (1-{len(results)}, 0=全部):")
            try:
                choice = input("> ").strip()
                if choice == "0":
                    selected = results
                else:
                    idx = int(choice) - 1
                    if 0 <= idx < len(results):
                        selected = [results[idx]]
                    else:
                        print("❌ 无效选择")
                        return False
            except (ValueError, KeyboardInterrupt):
                print("\n❌ 取消下载")
                return False
        else:
            selected = results
        
        os.makedirs(local_dir, exist_ok=True)
        
        success = 0
        for item in selected:
            if self.download_engine.download_by_search_result(item, local_dir):
                success += 1
        
        print(f"🎉 下载完成! 成功: {success}/{len(selected)}")
        return success > 0

    def pull(self, local_dir: str = None, ydnote_dir: str = None):
        """全量导出所有笔记"""
        config, error = load_config()
        if error:
            print(f"⚠️ {error}")
        
        if not local_dir:
            local_dir = config.get("local_dir") or "./youdaonote"
        if not ydnote_dir:
            ydnote_dir = config.get("ydnote_dir") or ""
        
        smms_token = config.get("smms_secret_token", "")
        is_relative = config.get("is_relative_path", True)
        
        if not self.init_api():
            return False
        
        self.download_engine = YoudaoNoteDownload(
            self.youdaonote_api, smms_token, is_relative
        )
        
        print(f"📥 开始全量导出...")
        print(f"   本地目录: {local_dir}")
        if ydnote_dir:
            print(f"   指定目录: {ydnote_dir}")
        
        start_time = time.time()
        success = self.download_engine.pull_all(local_dir, ydnote_dir)
        elapsed = time.time() - start_time
        
        if success:
            print(f"🎉 导出完成! 耗时 {elapsed:.1f} 秒")
        else:
            print("❌ 导出失败")
        
        return success


def cmd_pull(args):
    """执行 pull 命令"""
    cli = YoudaoNoteCLI()
    cli.pull(args.dir, args.ydnote_dir)


def cmd_list(args):
    """执行 list 命令"""
    cli = YoudaoNoteCLI()
    cli.list_directory(args.path, args.depth)


def cmd_search(args):
    """执行 search 命令"""
    cli = YoudaoNoteCLI()
    cli.search(args.keyword, args.type, args.exact)


def cmd_download(args):
    """执行 download 命令"""
    cli = YoudaoNoteCLI()
    cli.download(args.keyword, args.type, args.exact, args.dir)


def _get_browser_data_dir() -> str:
    """获取浏览器数据目录（用于持久化登录状态）"""
    from youdaonote.common import get_config_directory
    return os.path.join(get_config_directory(), "browser_data")


def _refresh_cookies_if_needed(headless: bool = True) -> bool:
    """
    使用 persistent context 尝试刷新 cookies
    
    :param headless: 是否使用无头模式（后台刷新）
    :return: 是否成功刷新
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return False
    
    browser_data_dir = _get_browser_data_dir()
    if not os.path.exists(browser_data_dir):
        # 没有保存的浏览器状态，无法自动刷新
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
            
            # 打开有道云笔记，触发可能的自动登录/session 刷新
            page = context.pages[0] if context.pages else context.new_page()
            page.goto("https://note.youdao.com/web/", wait_until="networkidle", timeout=30000)
            
            # 等待几秒让页面完成登录检查
            page.wait_for_timeout(3000)
            
            # 检查是否有有效的 cookies
            cookies = context.cookies()
            cookie_names = [c['name'] for c in cookies]
            
            if all(name in cookie_names for name in CookieManager.REQUIRED_COOKIES):
                # 保存刷新后的 cookies
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


def _try_cookie_login(context) -> bool:
    """检查已有浏览器状态中是否有有效 cookies，有则保存并返回 True。"""
    cookies = context.cookies()
    cookie_names = [c['name'] for c in cookies]
    if not all(name in cookie_names for name in CookieManager.REQUIRED_COOKIES):
        return False

    print("✅ 检测到已有登录状态，正在验证...")
    cookies_data, error = CookieManager.convert_playwright_cookies(cookies)
    if error:
        return False
    success, _ = CookieManager.save(cookies_data)
    if success:
        print(f"✅ Cookies 已更新: {CookieManager.get_default_path()}")
        print("\n🎉 登录状态有效！可以直接使用：")
        print("  python -m youdaonote pull")
        return True
    return False


def _wait_for_browser_login(context, page) -> int:
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
        if all(n in [c['name'] for c in cookies] for n in CookieManager.REQUIRED_COOKIES):
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
    print("\n  python -m youdaonote pull      # 全量导出")
    print("  python -m youdaonote gui       # 图形界面")
    print("  python -m youdaonote search XX # 搜索笔记")
    print("\n📌 提示：下次运行 login 时将自动复用登录状态\n")
    return 0


def cmd_login(args):
    """执行 login 命令 - 使用 Playwright 持久化上下文登录"""
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

    browser_data_dir = _get_browser_data_dir()
    os.makedirs(browser_data_dir, exist_ok=True)

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            browser_data_dir, headless=False,
            viewport={'width': 1280, 'height': 800},
            locale='zh-CN', args=['--start-maximized'])
        try:
            if _try_cookie_login(context):
                return 0
            page = context.pages[0] if context.pages else context.new_page()
            return _wait_for_browser_login(context, page)
        except Exception as e:
            print(f"\n❌ 发生错误: {e}")
            return 1
        finally:
            context.close()


def cmd_gui(args):
    """执行 gui 命令 - 启动图形界面"""
    print("🚀 正在启动有道云笔记 GUI...")
    
    # 检查 cookies 文件
    cookies_path = CookieManager.get_default_path()
    if not os.path.exists(cookies_path):
        print(f"❌ 未找到 cookies 文件: {cookies_path}")
        print("请先运行: python -m youdaonote login")
        return 1
    
    try:
        from youdaonote.gui.app import run_gui
        run_gui()
        return 0
    except ImportError as e:
        print(f"❌ 导入 GUI 模块失败: {e}")
        print("请确保已安装 tkinter")
        return 1
    except Exception as e:
        print(f"❌ 启动 GUI 失败: {e}")
        return 1


def cmd_sync(args):
    """执行 sync 命令 - 双向同步"""
    from youdaonote.sync.engine import SyncManager
    from youdaonote.sync.utils import SyncDirection
    from youdaonote.watcher import SyncWatcher
    
    # 加载配置
    config, error = load_config()
    if error:
        print(f"⚠️ {error}")
    
    local_dir = args.dir or config.get("local_dir") or "./youdaonote"
    
    # 初始化 API
    cli = YoudaoNoteCLI()
    if not cli.init_api():
        return 1
    
    # --watch 模式：自动同步守护进程
    if args.watch:
        print("\n" + "=" * 60)
        print("  有道云笔记自动同步")
        print("=" * 60 + "\n")
        
        interval = args.interval or 60
        watcher = SyncWatcher(
            cli.youdaonote_api, local_dir,
            poll_interval=interval,
        )
        watcher.start()
        return 0
    
    # 一次性同步模式
    # 确定同步方向
    if args.push and args.pull:
        print("❌ 不能同时指定 --push 和 --pull")
        return 1
    elif args.push:
        direction = SyncDirection.PUSH
    elif args.pull:
        direction = SyncDirection.PULL
    else:
        direction = SyncDirection.BOTH
    
    print("\n" + "=" * 60)
    print("  有道云笔记双向同步")
    print("=" * 60)
    print(f"\n📁 本地目录: {os.path.abspath(local_dir)}")
    print(f"🔄 同步方向: {direction.value}")
    if args.dry_run:
        print("👀 预览模式（不执行实际操作）")
    print()
    
    # 执行同步
    sync_manager = SyncManager(cli.youdaonote_api, local_dir)
    
    start_time = time.time()
    stats = sync_manager.sync(
        direction=direction,
        dry_run=args.dry_run,
        auto_git=not args.no_git,
        auto_dedup=not args.no_dedup,
    )
    elapsed = time.time() - start_time
    
    print("\n" + "=" * 60)
    print("  同步完成")
    print("=" * 60)
    print(f"\n⬇️  下载: {stats['downloaded']}")
    print(f"⬆️  上传: {stats['uploaded']}")
    print(f"⏭️  跳过: {stats['skipped']}")
    if stats['conflicts'] > 0:
        print(f"⚠️  冲突: {stats['conflicts']}")
    if stats['errors'] > 0:
        print(f"❌ 错误: {stats['errors']}")
    if stats.get('dedup_deleted', 0) > 0:
        print(f"🔍 去重: {stats['dedup_deleted']}")
    print(f"\n⏱️  耗时: {elapsed:.1f} 秒")
    print()
    
    return 0 if stats['errors'] == 0 else 1


def main():
    """主函数"""
    parser = argparse.ArgumentParser(
        prog='youdaonote',
        description='有道云笔记导出工具',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
示例:
  %(prog)s login                        # 登录（推荐首次使用）
  %(prog)s pull                         # 全量导出
  %(prog)s pull --dir ./backup          # 导出到指定目录
  %(prog)s sync                         # 双向同步（一次）
  %(prog)s sync --watch                 # 自动同步（持续监听）
  %(prog)s sync --push                  # 只上传
  %(prog)s sync --pull                  # 只下载
  %(prog)s sync --dry-run               # 预览同步（不执行）
  %(prog)s gui                          # 启动图形界面
  %(prog)s list                         # 列出目录
  %(prog)s search 笔记                   # 搜索
  %(prog)s download 关键词               # 搜索并下载
'''
    )
    
    subparsers = parser.add_subparsers(dest='command', help='可用命令')
    
    # login 命令
    parser_login = subparsers.add_parser('login', help='登录有道云笔记（使用浏览器）')
    parser_login.set_defaults(func=cmd_login)
    
    # gui 命令
    parser_gui = subparsers.add_parser('gui', help='启动图形界面')
    parser_gui.set_defaults(func=cmd_gui)
    
    # pull 命令
    parser_pull = subparsers.add_parser('pull', help='全量导出所有笔记')
    parser_pull.add_argument('--dir', '-d', default=None, help='导出目录（默认: ./youdaonote）')
    parser_pull.add_argument('--ydnote-dir', '-y', default=None, help='只导出有道云中的指定目录')
    parser_pull.set_defaults(func=cmd_pull)
    
    # list 命令
    parser_list = subparsers.add_parser('list', help='列出目录内容')
    parser_list.add_argument('path', nargs='?', default=None, help='目录路径')
    parser_list.add_argument('--depth', '-n', type=int, default=2, help='显示深度（默认: 2）')
    parser_list.set_defaults(func=cmd_list)
    
    # search 命令
    parser_search = subparsers.add_parser('search', help='搜索文件或文件夹')
    parser_search.add_argument('keyword', help='搜索关键词')
    parser_search.add_argument('--type', '-t', choices=['all', 'folder', 'file'], 
                               default='all', help='搜索类型')
    parser_search.add_argument('--exact', '-e', action='store_true', help='精确匹配')
    parser_search.set_defaults(func=cmd_search)
    
    # download 命令
    parser_download = subparsers.add_parser('download', help='搜索并下载')
    parser_download.add_argument('keyword', help='搜索关键词')
    parser_download.add_argument('--type', '-t', choices=['all', 'folder', 'file'], 
                                  default='all', help='搜索类型')
    parser_download.add_argument('--exact', '-e', action='store_true', help='精确匹配')
    parser_download.add_argument('--dir', '-d', default='./youdaonote', help='下载目录')
    parser_download.set_defaults(func=cmd_download)
    
    # sync 命令
    parser_sync = subparsers.add_parser('sync', help='双向同步笔记')
    parser_sync.add_argument('--dir', '-d', default=None, help='本地同步目录（默认从配置读取）')
    parser_sync.add_argument('--push', action='store_true', help='只上传（本地 → 云端）')
    parser_sync.add_argument('--pull', action='store_true', help='只下载（云端 → 本地）')
    parser_sync.add_argument('--dry-run', action='store_true', help='预览模式（不执行实际操作）')
    parser_sync.add_argument('--watch', '-w', action='store_true', help='自动同步模式（监听文件变化 + 定时轮询）')
    parser_sync.add_argument('--interval', '-i', type=int, default=60, help='云端轮询间隔秒数（默认 60）')
    parser_sync.add_argument('--no-git', action='store_true', help='不自动 git commit')
    parser_sync.add_argument('--no-dedup', action='store_true', help='不自动去重')
    parser_sync.set_defaults(func=cmd_sync)
    
    args = parser.parse_args()
    
    if args.command is None:
        parser.print_help()
        return 1
    
    # 初始化日志
    log.init_logging()
    
    try:
        return args.func(args) or 0
    except requests.exceptions.ProxyError:
        print("❌ 网络代理错误，请检查代理设置")
        traceback.print_exc()
        return 1
    except requests.exceptions.ConnectionError:
        print("❌ 网络连接错误，请检查网络")
        traceback.print_exc()
        return 1
    except KeyboardInterrupt:
        print("\n⚠️ 用户取消操作")
        return 0
    except Exception as e:
        print(f"❌ 发生错误: {e}")
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
