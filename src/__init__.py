#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
有道云笔记导出工具

一个用于导出有道云笔记的 Python 工具，支持 CLI 和 GUI 两种使用方式。

使用方法:
    python -m src login     # 登录
    python -m src pull      # 全量导出
    python -m src gui       # 图形界面
    python -m src search XX # 搜索笔记
"""

__version__ = '2.0.0'
__author__ = 'DeppWang'

from src.api import YoudaoNoteApi
from src.transfer.search import YoudaoNoteSearch
from src.transfer.download import YoudaoNoteDownload
from src.common import load_config
from src.cookies import CookieManager
from src.convert.note_convert import YoudaoNoteConvert

__all__ = [
    'YoudaoNoteApi',
    'YoudaoNoteSearch',
    'YoudaoNoteDownload',
    'load_config',
    'CookieManager',
    'YoudaoNoteConvert',
    '__version__',
]
