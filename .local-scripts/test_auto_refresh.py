"""测试 session 自动刷新: 用过期的 cookies.json 调用 API"""
import os
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.api import YoudaoNoteApi

config_path = os.path.join(os.path.dirname(__file__), '..', 'config')
api = YoudaoNoteApi(cookies_path=os.path.join(config_path, 'cookies.json'))

err = api.login_by_cookies()
if err:
    print(f"登录失败: {err}")
    sys.exit(1)

print(f"登录成功, CSTK: {api.cstk}")
print("尝试获取根目录...")

try:
    root_id = api.get_root_id()
    print(f"获取根目录成功: {root_id}")
except Exception as e:
    print(f"获取根目录失败: {e}")
