# -*- coding:utf-8 -*-
"""
下载功能测试

python -m pytest test/test_download.py -v
"""

import os
import sys
import unittest
from unittest.mock import patch

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from youdaonote.common import load_config


class YoudaoNoteDownloadTest(unittest.TestCase):
    """
    测试下载功能
    python -m pytest test/test_download.py::YoudaoNoteDownloadTest -v
    """

    def test_load_config(self):
        """
        测试加载配置文件
        python -m pytest test/test_download.py::YoudaoNoteDownloadTest::test_load_config -v
        """
        # 当配置文件不存在时，返回默认配置
        with patch("os.path.exists", return_value=False):
            config, error = load_config()
            self.assertFalse(error)
            self.assertEqual(config.get("local_dir"), "")
            self.assertEqual(config.get("is_relative_path"), True)

    def test_check_local_dir(self):
        """
        测试本地目录创建
        python -m pytest test/test_download.py::YoudaoNoteDownloadTest::test_check_local_dir -v
        """
        test_dir = os.path.join(os.path.dirname(__file__), "test_download_dir")

        # 清理测试目录
        if os.path.exists(test_dir):
            os.rmdir(test_dir)

        # 测试创建目录
        os.makedirs(test_dir, exist_ok=True)
        self.assertTrue(os.path.exists(test_dir))

        # 清理
        os.rmdir(test_dir)


if __name__ == "__main__":
    unittest.main()
