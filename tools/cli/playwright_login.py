#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
使用 Playwright 自动化登录有道云笔记并提取 Cookies

此脚本已整合到主程序，推荐使用：
    python -m src login
"""

import os
import sys

# 添加父目录到路径
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))


def main():
    """主函数 - 调用统一的登录命令"""
    print("=" * 60)
    print("  提示: 此脚本已整合到主程序")
    print("  推荐使用: python -m src login")
    print("=" * 60 + "\n")
    
    # 直接调用主程序的登录命令
    from src.__main__ import cmd_login
    
    class Args:
        pass
    
    return cmd_login(Args())


if __name__ == "__main__":
    sys.exit(main())
