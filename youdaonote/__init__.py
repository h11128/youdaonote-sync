#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
有道云笔记导出工具

一个用于导出有道云笔记的 Python 工具，支持 CLI 和 GUI 两种使用方式。

使用方法:
    python -m youdaonote login     # 登录
    python -m youdaonote pull      # 全量导出
    python -m youdaonote gui       # 图形界面
    python -m youdaonote search XX # 搜索笔记
"""

__version__ = '2.0.0'
__author__ = 'DeppWang'

from youdaonote.api import YoudaoNoteApi
from youdaonote.transfer.search import YoudaoNoteSearch
from youdaonote.transfer.download import YoudaoNoteDownload
from youdaonote.common import load_config
from youdaonote.cookies import CookieManager
from youdaonote.convert.note_convert import YoudaoNoteConvert

__all__ = [
    'YoudaoNoteApi',
    'YoudaoNoteSearch',
    'YoudaoNoteDownload',
    'load_config',
    'CookieManager',
    'YoudaoNoteConvert',
    '__version__',
]
