"""
验证 move_file API 是否正常工作。

步骤：
1. 登录有道云
2. 在测试目录创建一个临时文件
3. 创建另一个测试目录
4. 调用 move_file 把文件移到新目录
5. 验证文件在新位置存在、旧位置不存在
6. 清理
"""
import os
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

from src.api import YoudaoNoteApi
from src.cookies import CookieManager


def main():
    api = YoudaoNoteApi(cookies_path=CookieManager.get_default_path())
    error = api.login_by_cookies()
    if error:
        print(f"登录失败: {error}")
        return 1

    root_id = api.get_root_id()
    print(f"root_id: {root_id}")

    # 1. 创建测试目录 A
    print("\n--- 创建测试目录 _test_move_src ---")
    dir_a_resp = api.create_dir(root_id, "_test_move_src")
    dir_a_id = dir_a_resp.get("fileEntry", {}).get("id", "")
    if not dir_a_id:
        print(f"创建目录 A 失败: {dir_a_resp}")
        return 1
    print(f"dir_a_id: {dir_a_id}")

    # 2. 创建测试目录 B
    print("\n--- 创建测试目录 _test_move_dst ---")
    dir_b_resp = api.create_dir(root_id, "_test_move_dst")
    dir_b_id = dir_b_resp.get("fileEntry", {}).get("id", "")
    if not dir_b_id:
        print(f"创建目录 B 失败: {dir_b_resp}")
        return 1
    print(f"dir_b_id: {dir_b_id}")

    # 3. 在目录 A 创建一个文件
    print("\n--- 在 _test_move_src 创建测试文件 ---")
    file_id = api.generate_file_id()
    now = int(time.time())
    push_resp = api.push_file(
        file_id=file_id,
        parent_id=dir_a_id,
        name="move_test.md",
        domain=1,
        body_string="# Move Test\n\nThis file will be moved.",
        create_time=now,
        modify_time=now,
        is_create=True,
    )
    created_fid = push_resp.get("fileEntry", {}).get("id", file_id)
    print(f"created file_id: {created_fid}")

    # 4. 验证文件在目录 A
    print("\n--- 验证文件在 _test_move_src ---")
    dir_a_contents = api.get_dir_info_by_id(dir_a_id)
    entries_a = dir_a_contents.get("entries", [])
    found_in_a = any(e.get("fileEntry", {}).get("id") == created_fid for e in entries_a)
    print(f"文件在 dir_a: {found_in_a} (entries: {len(entries_a)})")

    # 5. 调用 move_file
    print(f"\n--- 调用 move_file({created_fid}, {dir_b_id}) ---")
    move_resp = api.move_file(created_fid, dir_b_id, domain=1)
    print(f"move 响应: {move_resp}")

    # 6. 验证移动后状态
    print("\n--- 验证移动后状态 ---")
    time.sleep(1)

    dir_a_contents2 = api.get_dir_info_by_id(dir_a_id)
    entries_a2 = dir_a_contents2.get("entries", [])
    still_in_a = any(e.get("fileEntry", {}).get("id") == created_fid for e in entries_a2)

    dir_b_contents = api.get_dir_info_by_id(dir_b_id)
    entries_b = dir_b_contents.get("entries", [])
    found_in_b = any(e.get("fileEntry", {}).get("id") == created_fid for e in entries_b)

    print(f"文件仍在 dir_a: {still_in_a}")
    print(f"文件在 dir_b:   {found_in_b}")

    if found_in_b and not still_in_a:
        print("\n✓ move_file API 工作正常！文件已从 A 移到 B，file_id 不变。")
    else:
        print("\n✗ move_file API 结果异常！")

    # 7. 验证 file_id 下载后内容一致
    print("\n--- 验证内容 ---")
    content_resp = api.get_file_by_id(created_fid)
    print(f"file_id 仍然有效: {content_resp is not None}")

    # 8. 清理
    print("\n--- 清理测试文件和目录 ---")
    try:
        api.delete_file(created_fid)
        print(f"已删除测试文件: {created_fid}")
    except Exception as e:
        print(f"删除文件失败: {e}")

    try:
        api.delete_file(dir_a_id)
        print(f"已删除 _test_move_src: {dir_a_id}")
    except Exception as e:
        print(f"删除目录 A 失败: {e}")

    try:
        api.delete_file(dir_b_id)
        print(f"已删除 _test_move_dst: {dir_b_id}")
    except Exception as e:
        print(f"删除目录 B 失败: {e}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
