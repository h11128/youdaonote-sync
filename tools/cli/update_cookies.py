#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
有道云笔记 Cookie 手动更新工具
用于手动输入和更新 cookies.json 文件

推荐使用: python -m src login
"""

import json
import os
import sys

# 添加父目录到路径
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

from src.cookies import CookieManager


def update_cookies_interactive():
    """交互式更新 cookies"""
    print("🔧 有道云笔记 Cookie 手动更新工具")
    print("=" * 50)
    print("\n💡 推荐使用自动登录: python -m src login\n")
    
    cookie_dict = {}
    
    required_cookies = [
        ("YNOTE_CSTK", "CSTK 令牌"),
        ("YNOTE_LOGIN", "登录信息"),
        ("YNOTE_SESS", "会话信息")
    ]
    
    print("请输入以下 cookie 值（从浏览器开发者工具中获取）:\n")
    
    for cookie_name, description in required_cookies:
        while True:
            value = input(f"请输入 {cookie_name} ({description}): ").strip()
            if value and value != "**":
                cookie_dict[cookie_name] = value
                print(f"✅ {cookie_name} 已设置")
                break
            else:
                print("❌ 请输入有效的 cookie 值")
    
    cookies_data = CookieManager.create_from_dict(cookie_dict)
    success, error = CookieManager.save(cookies_data)
    
    if success:
        print(f"\n🎉 Cookie 已成功保存到 {CookieManager.get_default_path()}")
        print("\n现在可以使用:")
        print("  python -m src pull   # 全量导出")
        print("  python -m src gui    # 图形界面")
        return True
    else:
        print(f"❌ 保存失败: {error}")
        return False


def main():
    """主函数"""
    if len(sys.argv) > 1:
        # 如果提供了命令行参数，尝试作为 JSON 解析
        json_string = " ".join(sys.argv[1:])
        try:
            cookies_data = json.loads(json_string)
            success, error = CookieManager.save(cookies_data)
            if success:
                print("🎉 Cookie 已成功更新！")
            else:
                print(f"❌ 保存失败: {error}")
        except json.JSONDecodeError as e:
            print(f"❌ JSON 解析错误: {e}")
    else:
        update_cookies_interactive()


if __name__ == "__main__":
    main()
