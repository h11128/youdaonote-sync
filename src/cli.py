#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CLI 命令处理

包含 YoudaoNoteCLI 业务类和各子命令的处理函数。
"""

import logging
import os
import time

from src.api import YoudaoNoteApi
from src.common import format_file_size, load_config, DirId
from src.cookies import CookieManager
from src.transfer.download import YoudaoNoteDownload
from src.transfer.search import YoudaoNoteSearch, SearchType


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

            from src.auth import refresh_cookies_if_needed
            if auto_refresh and refresh_cookies_if_needed(headless=True):
                self.youdaonote_api = YoudaoNoteApi(cookies_path=self.cookies_path)
                error_msg = self.youdaonote_api.login_by_cookies()
                if not error_msg:
                    logging.info("登录成功（自动刷新后）!")
                    self.search_engine = YoudaoNoteSearch(self.youdaonote_api)
                    self.download_engine = YoudaoNoteDownload(self.youdaonote_api)
                    return True

            print("❌ Cookie 已过期，请运行以下命令重新登录：")
            print("   python -m src login")
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

    def _print_directory(self, dir_id: DirId, current_path: str,
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
        results = self.search_engine.search_by_name(name, SearchType(search_type), exact_match)

        if not results:
            print("❌ 未找到匹配的项目")
            return []

        print(f"✅ 找到 {len(results)} 个匹配项:")
        for i, item in enumerate(results, 1):
            icon = "📁" if item['is_dir'] else "📄"
            print(f"  {i}. {icon} {item['path']}")

        return results

    def download(self, name: str, search_type: str = "all",
                 exact_match: bool = False, local_dir: str = "./youdaonote-sync"):
        """搜索并下载"""
        if not self.search_engine and not self.init_api():
            return False

        results = self.search_engine.search_by_name(name, SearchType(search_type), exact_match)

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
        from src.transfer.pull import PullEngine

        config, error = load_config()
        if error:
            print(f"⚠️ {error}")

        if not local_dir:
            local_dir = config.get("local_dir") or "./youdaonote-sync"
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
        pull_engine = PullEngine(self.youdaonote_api, self.download_engine)
        success = pull_engine.pull_all(local_dir, ydnote_dir)
        elapsed = time.time() - start_time

        if success:
            print(f"🎉 导出完成! 耗时 {elapsed:.1f} 秒")
        else:
            print("❌ 导出失败")

        return success


# ---- 命令处理函数 ----

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


def cmd_gui(args):
    """执行 gui 命令 - 启动图形界面"""
    print("🚀 正在启动有道云笔记 GUI...")

    cookies_path = CookieManager.get_default_path()
    if not os.path.exists(cookies_path):
        print(f"❌ 未找到 cookies 文件: {cookies_path}")
        print("请先运行: python -m src login")
        return 1

    try:
        from src.gui.app import run_gui
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
    from src.sync.engine import SyncManager
    from src.sync.utils import SyncDirection
    from src.watcher import SyncWatcher

    config, error = load_config()
    if error:
        print(f"⚠️ {error}")

    local_dir = args.dir or config.get("local_dir") or "./youdaonote-sync"

    cli = YoudaoNoteCLI()
    if not cli.init_api():
        return 1

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
