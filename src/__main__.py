#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
有道云笔记命令行入口

只负责 argparse 定义和命令分发，业务逻辑在 cli.py / login.py 中。
"""

import argparse
import sys
import traceback

import requests

from src import log
from src.cli import (
    cmd_download,
    cmd_gui,
    cmd_list,
    cmd_pull,
    cmd_search,
    cmd_sync,
)
from src.login import cmd_login


def main():
    """主函数：解析参数并分发到对应命令。"""
    parser = argparse.ArgumentParser(
        prog='youdaonote-sync',
        description='有道云笔记同步工具',
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

    # login
    parser_login = subparsers.add_parser('login', help='登录有道云笔记（使用浏览器）')
    parser_login.set_defaults(func=cmd_login)

    # gui
    parser_gui = subparsers.add_parser('gui', help='启动图形界面')
    parser_gui.set_defaults(func=cmd_gui)

    # pull
    parser_pull = subparsers.add_parser('pull', help='全量导出所有笔记')
    parser_pull.add_argument('--dir', '-d', default=None,
                             help='导出目录（默认: ./youdaonote-sync）')
    parser_pull.add_argument('--ydnote-dir', '-y', default=None,
                             help='只导出有道云中的指定目录')
    parser_pull.set_defaults(func=cmd_pull)

    # list
    parser_list = subparsers.add_parser('list', help='列出目录内容')
    parser_list.add_argument('path', nargs='?', default=None, help='目录路径')
    parser_list.add_argument('--depth', '-n', type=int, default=2,
                             help='显示深度（默认: 2）')
    parser_list.set_defaults(func=cmd_list)

    # search
    parser_search = subparsers.add_parser('search', help='搜索文件或文件夹')
    parser_search.add_argument('keyword', help='搜索关键词')
    parser_search.add_argument('--type', '-t', choices=['all', 'folder', 'file'],
                               default='all', help='搜索类型')
    parser_search.add_argument('--exact', '-e', action='store_true', help='精确匹配')
    parser_search.set_defaults(func=cmd_search)

    # download
    parser_download = subparsers.add_parser('download', help='搜索并下载')
    parser_download.add_argument('keyword', help='搜索关键词')
    parser_download.add_argument('--type', '-t', choices=['all', 'folder', 'file'],
                                 default='all', help='搜索类型')
    parser_download.add_argument('--exact', '-e', action='store_true', help='精确匹配')
    parser_download.add_argument('--dir', '-d', default='./youdaonote-sync',
                                 help='下载目录')
    parser_download.set_defaults(func=cmd_download)

    # sync
    parser_sync = subparsers.add_parser('sync', help='双向同步笔记')
    parser_sync.add_argument('--dir', '-d', default=None,
                             help='本地同步目录（默认从配置读取）')
    parser_sync.add_argument('--push', action='store_true',
                             help='只上传（本地 → 云端）')
    parser_sync.add_argument('--pull', action='store_true',
                             help='只下载（云端 → 本地）')
    parser_sync.add_argument('--dry-run', action='store_true',
                             help='预览模式（不执行实际操作）')
    parser_sync.add_argument('--watch', '-w', action='store_true',
                             help='自动同步模式（监听文件变化 + 定时轮询）')
    parser_sync.add_argument('--interval', '-i', type=int, default=60,
                             help='云端轮询间隔秒数（默认 60）')
    parser_sync.add_argument('--no-git', action='store_true',
                             help='不自动 git commit')
    parser_sync.add_argument('--no-dedup', action='store_true',
                             help='不自动去重')
    parser_sync.set_defaults(func=cmd_sync)

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        return 1

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
