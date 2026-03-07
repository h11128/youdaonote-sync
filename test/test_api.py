# -*- coding:utf-8 -*-
"""
有道云笔记 API 测试

python -m pytest test/test_api.py -v
"""

import os
import sys
import unittest
from unittest.mock import Mock, mock_open, patch

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from src.api import YoudaoNoteApi


TEST_COOKIES_PATH = "test_cookies.json"


class MockResponse:
    def __init__(self, json_data, status_code):
        self.json_data = json_data
        self.status_code = status_code

    def json(self):
        return self.json_data


class YoudaoNoteApiTest(unittest.TestCase):
    """
    测试有道云笔记 API
    python -m pytest test/test_api.py::YoudaoNoteApiTest -v
    """

    TEST_COOKIES_PATH = "test_cookies.json"

    def tearDown(self):
        if os.path.exists(self.TEST_COOKIES_PATH):
            os.remove(self.TEST_COOKIES_PATH)

    def test_cookies_login(self):
        """
        测试 cookies 登录
        python -m pytest test/test_api.py::YoudaoNoteApiTest::test_cookies_login -v
        """

        _no_desktop = lambda: patch(
            "src.cookies.CookieManager.load_from_desktop",
            return_value=([], "未安装桌面客户端"))

        # 如果 cookies 文件不存在。期待：登录失败
        youdaonote_api = YoudaoNoteApi(cookies_path=self.TEST_COOKIES_PATH)
        with _no_desktop():
            message = youdaonote_api.login_by_cookies()
            self.assertIsNotNone(message)
            self.assertIn("Cookie 加载失败", message)

        # 如果 cookies 格式不对（少了一个 [）。期待：登录失败
        cookies_json_str = """{
                "cookies": 
                    ["YNOTE_CSTK", "fPk5IkDg", ".note.youdao.com", "/"],
                    ["YNOTE_LOGIN", "3||1591964671668", ".note.youdao.com", "/"],
                    ["YNOTE_SESS", "***", ".note.youdao.com", "/"],
                }"""

        youdaonote_api = YoudaoNoteApi(cookies_path=self.TEST_COOKIES_PATH)
        with patch(
            "builtins.open", mock_open(read_data=cookies_json_str.encode("utf-8"))
        ), _no_desktop():
            message = youdaonote_api.login_by_cookies()
            self.assertIsNotNone(message)
            self.assertIn("Cookie 加载失败", message)

        # 如果 cookies 格式正确，但少了 YNOTE_CSTK。期待：登录失败
        cookies_json_str = """{"cookies": [
                                    ["YNOTE_LOGIN", "3||1591964671668", ".note.youdao.com", "/"],
                                    ["YNOTE_SESS", "***", ".note.youdao.com", "/"]
                                ]}"""
        youdaonote_api = YoudaoNoteApi(cookies_path=self.TEST_COOKIES_PATH)
        with patch(
            "builtins.open", mock_open(read_data=cookies_json_str.encode("utf-8"))
        ), _no_desktop():
            message = youdaonote_api.login_by_cookies()
            self.assertIsNotNone(message)
            self.assertIn("Cookie 加载失败", message)

        # 如果 cookies 格式正确，并包含 YNOTE_CSTK。期待：登录成功
        cookies_json_str = """{"cookies": [
                                    ["YNOTE_CSTK", "fPk5IkDg", ".note.youdao.com", "/"],
                                    ["YNOTE_LOGIN", "3||1591964671668", ".note.youdao.com", "/"],
                                    ["YNOTE_SESS", "***", ".note.youdao.com", "/"]
                                ]}"""
        youdaonote_api = YoudaoNoteApi(cookies_path=self.TEST_COOKIES_PATH)
        with patch(
            "builtins.open", mock_open(read_data=cookies_json_str.encode("utf-8"))
        ):
            message = youdaonote_api.login_by_cookies()
            self.assertFalse(message)
            self.assertEqual(youdaonote_api.cstk, "fPk5IkDg")

    def _mock_login(self) -> YoudaoNoteApi:
        """创建一个已 mock 登录的 API 实例（cstk 已设置）。"""
        api = YoudaoNoteApi(cookies_path=TEST_COOKIES_PATH)
        api.cstk = "fPk5IkDg"
        return api

    def test_get_root_dir_info_id(self):
        """
        测试获取有道云笔记根目录信息
        python -m pytest test/test_api.py::YoudaoNoteApiTest::test_get_root_dir_info_id -v
        """

        youdaonote_api = self._mock_login()

        # 接口返回正常时。期待：根目录信息中有根目录 ID
        youdaonote_api.http_post = Mock(
            return_value=MockResponse(
                {"fileEntry": {"id": "test_root_id", "name": "ROOT"}}, 200
            )
        )
        root_dir_info = youdaonote_api.get_root_dir_info_id()
        self.assertEqual(root_dir_info["fileEntry"]["id"], "test_root_id")

    def test_get_dir_info_by_id(self):
        """
        测试根据目录 ID 获取目录下所有文件信息
        python -m pytest test/test_api.py::YoudaoNoteApiTest::test_get_dir_info_by_id -v
        """

        youdaonote_api = self._mock_login()

        # 当目录 ID 存在时。期待获取正常
        youdaonote_api.http_get = Mock(
            return_value=MockResponse(
                {
                    "count": 2,
                    "entries": [
                        {
                            "fileEntry": {
                                "id": "test_dir_id",
                                "name": "test_dir",
                                "dir": True,
                            }
                        },
                        {
                            "fileEntry": {
                                "id": "test_note_id",
                                "name": "test_note",
                                "dir": False,
                            }
                        },
                    ],
                },
                200,
            )
        )
        dir_info = youdaonote_api.get_dir_info_by_id(dir_id="test_dir_id")
        self.assertEqual(dir_info["count"], 2)
        self.assertTrue(dir_info["entries"][0]["fileEntry"]["dir"])
        self.assertFalse(dir_info["entries"][1]["fileEntry"]["dir"])

    def test_get_file_by_id(self):
        """
        测试根据文件 ID 获取文件内容
        python -m pytest test/test_api.py::YoudaoNoteApiTest::test_get_file_by_id -v
        """

        youdaonote_api = self._mock_login()

        # 当文件 ID 存在时。期待获取正常
        youdaonote_api.http_post = Mock(return_value=MockResponse({}, 200))
        file = youdaonote_api.get_file_by_id(file_id="test_note_id")
        self.assertTrue(file)


if __name__ == "__main__":
    unittest.main()
