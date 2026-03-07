#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
登录命令处理

将 Playwright 浏览器登录逻辑与 CLI 入口分离。
"""


def cmd_login(args):
    """执行 login 命令 - 使用 Playwright 持久化上下文登录"""
    from src.auth import browser_login
    return browser_login()
