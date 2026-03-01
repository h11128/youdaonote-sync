# -*- coding:utf-8 -*-
"""
文件名规范化测试（sanitize_filename、normalize_filename、map_cloud_name、round-trip）
"""

import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch, MagicMock

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from src.sync.metadata import SyncMetadata
from src.sync.utils import (
    decide_action, SyncAction, filter_by_direction, SyncDirection,
    SyncItem, VerifyIssueType, sanitize_filename,
)
from src.sync.scanner import map_cloud_name
from src.sync.moves import normalize_filename
from src.sync.dedup import _cloud_score
from src.common import format_file_size
from src.convert.md_to_note import markdown_to_note_json


# ========== P0 纯函数测试 ==========

class MapCloudNameTest(unittest.TestCase):
    """map_cloud_name() 云端文件名映射"""

    def test_note_to_md(self):
        """test.note → test.md"""
        # Given
        name = "test.note"
        # When
        result = map_cloud_name(name)
        # Then
        self.assertEqual(result, "test.md")

    def test_clip_to_md(self):
        """test.clip → test.md"""
        # Given
        name = "test.clip"
        # When
        result = map_cloud_name(name)
        # Then
        self.assertEqual(result, "test.md")

    def test_no_extension_to_md(self):
        """noext → noext.md (no extension)"""
        # Given
        name = "noext"
        # When
        result = map_cloud_name(name)
        # Then
        self.assertEqual(result, "noext.md")

    def test_already_md_unchanged(self):
        """test.md → test.md (already md)"""
        # Given
        name = "test.md"
        # When
        result = map_cloud_name(name)
        # Then
        self.assertEqual(result, "test.md")

    def test_other_extension_unchanged(self):
        """test.pdf → test.pdf (other extension)"""
        # Given
        name = "test.pdf"
        # When
        result = map_cloud_name(name)
        # Then
        self.assertEqual(result, "test.pdf")

    def test_nested_note_extension(self):
        """my.note.note → my.note.md (nested extension)"""
        # Given
        name = "my.note.note"
        # When
        result = map_cloud_name(name)
        # Then
        self.assertEqual(result, "my.note.md")

    def test_empty_string(self):
        """'' → '.md' (empty string)"""
        # Given
        name = ""
        # When
        result = map_cloud_name(name)
        # Then
        self.assertEqual(result, ".md")

    def test_trailing_space_note(self):
        """'title .note' → 'title.md' (trailing space in stem stripped)"""
        # Given
        name = "Does Eating Slowly Help You Lose Weight .note"
        # When
        result = map_cloud_name(name)
        # Then
        self.assertEqual(result, "Does Eating Slowly Help You Lose Weight.md")

    def test_trailing_space_no_ext(self):
        """'title ' → 'title.md' (trailing space in stem stripped, no ext)"""
        # Given
        name = "Does Eating Slowly Help You Lose Weight "
        # When
        result = map_cloud_name(name)
        # Then
        self.assertEqual(result, "Does Eating Slowly Help You Lose Weight.md")

    def test_trailing_space_md(self):
        """'title .md' → 'title.md' (trailing space in stem stripped, .md ext)"""
        # Given
        name = "title .md"
        # When
        result = map_cloud_name(name)
        # Then
        self.assertEqual(result, "title.md")

    def test_pipe_removed(self):
        """cloud name with | → pipe removed"""
        name = "福利来了|工程管理及物流申请微信讲座全纪录 重点部分已HIGHLIGHT"
        result = map_cloud_name(name)
        self.assertEqual(result, "福利来了工程管理及物流申请微信讲座全纪录 重点部分已HIGHLIGHT.md")

    def test_fullwidth_space_prefix_stripped(self):
        """cloud name with \\u3000 prefix → stripped, .note → .md"""
        name = "\u3000\u3000面试官：您对您的工作待遇有什么要求吗.note"
        result = map_cloud_name(name)
        self.assertEqual(result, "面试官：您对您的工作待遇有什么要求吗.md")

    def test_question_mark_and_trailing_space_note(self):
        """cloud name with ? and trailing space in .note → cleaned .md"""
        name = "What is Your Recovery Rate? .note"
        result = map_cloud_name(name)
        self.assertEqual(result, "What is Your Recovery Rate.md")

    def test_pipe_in_note_file(self):
        """pipe + no extension → removed, gets .md"""
        name = "A|B"
        result = map_cloud_name(name)
        self.assertEqual(result, "AB.md")

    def test_hash_removed(self):
        """# in filename removed"""
        name = "title#1.md"
        result = map_cloud_name(name)
        self.assertEqual(result, "title1.md")

    def test_angle_bracket_replaced(self):
        """< replaced with _ (consistent with download)"""
        name = "file<name.md"
        result = map_cloud_name(name)
        self.assertEqual(result, "file_name.md")





class NormalizeFilenameTest(unittest.TestCase):
    """normalize_filename() 文件名净化"""

    def test_normal_unchanged(self):
        """normal.md → normal.md (no change)"""
        # Given
        name = "normal.md"
        # When
        result = normalize_filename(name)
        # Then
        self.assertEqual(result, "normal.md")

    def test_colon_removed(self):
        """file:name → filename (colon removed)"""
        # Given
        name = "file:name"
        # When
        result = normalize_filename(name)
        # Then
        self.assertEqual(result, "filename")

    def test_special_chars_removed(self):
        """a\"b*c → abc (special chars removed)"""
        # Given
        name = 'a"b*c'
        # When
        result = normalize_filename(name)
        # Then
        self.assertEqual(result, "abc")

    def test_fullwidth_space_lstrip(self):
        """\\u3000\\u3000leading.md → leading.md (fullwidth space lstrip)"""
        # Given
        name = "\u3000\u3000leading.md"
        # When
        result = normalize_filename(name)
        # Then
        self.assertEqual(result, "leading.md")

    def test_strip_spaces(self):
        """  spaces   → spaces (strip)"""
        # Given
        name = "  spaces  "
        # When
        result = normalize_filename(name)
        # Then
        self.assertEqual(result, "spaces")

    def test_newline_removed(self):
        """a\\nb → ab (newline removed)"""
        # Given
        name = "a\nb"
        # When
        result = normalize_filename(name)
        # Then
        self.assertEqual(result, "ab")

    def test_empty_string(self):
        """'' → '' (empty string)"""
        # Given
        name = ""
        # When
        result = normalize_filename(name)
        # Then
        self.assertEqual(result, "")

    def test_space_before_extension(self):
        """'title .md' → 'title.md' (space before ext stripped)"""
        # Given
        name = "Does Eating Slowly Help You Lose Weight .md"
        # When
        result = normalize_filename(name)
        # Then
        self.assertEqual(result, "Does Eating Slowly Help You Lose Weight.md")

    def test_space_before_ext_with_special_chars(self):
        """'a:b .md' → 'ab.md' (special chars removed + space before ext)"""
        # Given
        name = "a:b .md"
        # When
        result = normalize_filename(name)
        # Then
        self.assertEqual(result, "ab.md")

    def test_angle_bracket_replaced_with_underscore(self):
        """< replaced with _ (consistent with download behavior)"""
        self.assertEqual(normalize_filename("a<b"), "a_b")

    def test_hash_removed(self):
        """# removed (consistent with download behavior)"""
        self.assertEqual(normalize_filename("a#b"), "ab")

    def test_pipe_removed(self):
        """|  removed from filename"""
        self.assertEqual(normalize_filename("a|b.md"), "ab.md")





class SanitizeFilenameTest(unittest.TestCase):
    """sanitize_filename() — single source of truth for character cleaning"""

    def test_idempotent(self):
        """sanitize(sanitize(x)) == sanitize(x) for all problematic inputs"""
        cases = [
            "福利来了|工程管理HIGHLIGHT",
            "\u3000\u3000面试官：要求吗.note",
            "What is Your Recovery Rate? .note",
            "Mirror, Mirror---What do I See.md",
            'a<b"c:d|e*f?g#h>i\\j/k',
            "  hello  ",
            "\u3000hello\u3000",
            "",
        ]
        for name in cases:
            first = sanitize_filename(name)
            second = sanitize_filename(first)
            self.assertEqual(first, second, f"not idempotent for {name!r}")

    def test_matches_optimize_file_name(self):
        """sanitize_filename must produce same result as _optimize_file_name"""
        from unittest.mock import MagicMock
        from src.transfer.download import YoudaoNoteDownload
        dl = YoudaoNoteDownload(api=MagicMock())
        cases = [
            "normal.md",
            "file<name",
            'file"name',
            "file:name",
            "a#b>c",
            "test\n.md",
            "  spaced.md  ",
            "\u3000\u3000面试官.note",
            "What is Your Recovery Rate? .note",
            "A|B.md",
        ]
        for name in cases:
            self.assertEqual(
                sanitize_filename(name),
                dl._optimize_file_name(name),
                f"mismatch for {name!r}",
            )





class RoundTripFilenameTest(unittest.TestCase):
    """map_cloud_name(cloud) must match what the downloader saves locally.

    This is the round-trip property: for every cloud name, the scanner
    and the downloader agree on the resulting local filename.
    """

    CLOUD_NAMES = [
        ("福利来了|工程管理及物流HIGHLIGHT", 0,
         "福利来了工程管理及物流HIGHLIGHT.md"),
        ("\u3000\u3000面试官：您对您的工作待遇有什么要求吗.note", 0,
         "面试官：您对您的工作待遇有什么要求吗.md"),
        ("What is Your Recovery Rate? .note", 0,
         "What is Your Recovery Rate.md"),
        ("Mirror, Mirror---What do I See.note", 0,
         "Mirror, Mirror---What do I See.md"),
        ("normal title.note", 0, "normal title.md"),
        ("already.md", 1, "already.md"),
        ("report.pdf", 1, "report.pdf"),
    ]

    def test_round_trip(self):
        """map_cloud_name produces the same name as _optimize_file_name + ext mapping"""
        from unittest.mock import MagicMock
        from src.transfer.download import YoudaoNoteDownload
        dl = YoudaoNoteDownload(api=MagicMock())

        for cloud_name, domain, expected in self.CLOUD_NAMES:
            mapped = map_cloud_name(cloud_name)
            self.assertEqual(mapped, expected,
                             f"map_cloud_name({cloud_name!r}) = {mapped!r}, expected {expected!r}")

            optimized = dl._optimize_file_name(cloud_name)
            _, ext = os.path.splitext(optimized)
            if ext in (".note", ".clip") or ext == "":
                stem = os.path.splitext(optimized)[0]
                local_name = stem + ".md"
            else:
                local_name = optimized
            self.assertEqual(mapped, local_name,
                             f"round-trip mismatch for {cloud_name!r}: "
                             f"scanner={mapped!r}, downloader={local_name!r}")





class OptimizeFileNameTest(unittest.TestCase):
    """YoudaoNoteDownload._optimize_file_name() 文件名优化"""

    def setUp(self):
        from unittest.mock import MagicMock
        from src.transfer.download import YoudaoNoteDownload
        self.downloader = YoudaoNoteDownload(api=MagicMock())

    def test_normal_unchanged(self):
        """normal.md → normal.md"""
        # Given
        name = "normal.md"
        # When
        result = self.downloader._optimize_file_name(name)
        # Then
        self.assertEqual(result, "normal.md")

    def test_newline_removed(self):
        """test\\n.md → test.md (newline removed)"""
        # Given
        name = "test\n.md"
        # When
        result = self.downloader._optimize_file_name(name)
        # Then
        self.assertEqual(result, "test.md")

    def test_strip_spaces(self):
        """  spaced.md   → spaced.md (strip)"""
        # Given
        name = "  spaced.md  "
        # When
        result = self.downloader._optimize_file_name(name)
        # Then
        self.assertEqual(result, "spaced.md")

    def test_angle_bracket_replaced_with_underscore(self):
        """file<name → file_name (< replaced with _)"""
        # Given
        name = "file<name"
        # When
        result = self.downloader._optimize_file_name(name)
        # Then
        self.assertEqual(result, "file_name")

    def test_double_quote_removed(self):
        """file\"name → filename (double quote removed)"""
        # Given
        name = 'file"name'
        # When
        result = self.downloader._optimize_file_name(name)
        # Then
        self.assertEqual(result, "filename")

    def test_colon_removed(self):
        """file:name → filename (colon removed)"""
        # Given
        name = "file:name"
        # When
        result = self.downloader._optimize_file_name(name)
        # Then
        self.assertEqual(result, "filename")

    def test_hash_and_angle_removed(self):
        """a#b>c → abc (# and > removed)"""
        # Given
        name = "a#b>c"
        # When
        result = self.downloader._optimize_file_name(name)
        # Then
        self.assertEqual(result, "abc")



# ========== Unit: normalize_filename =====================================

class NormalizeFilenameNewTest(unittest.TestCase):

    def test_all_invalid_chars_returns_underscore(self):
        from src.sync.moves import normalize_filename
        result = normalize_filename("\\/:*?\"<>|")
        self.assertEqual(result, "_")

    def test_normal_name_unchanged(self):
        from src.sync.moves import normalize_filename
        self.assertEqual(normalize_filename("hello.md"), "hello.md")

    def test_strips_fullwidth_space(self):
        from src.sync.moves import normalize_filename
        result = normalize_filename("\u3000hello")
        self.assertEqual(result, "hello")

    def test_collapses_spaces(self):
        from src.sync.moves import normalize_filename
        result = normalize_filename("a  b   c")
        self.assertEqual(result, "a b c")



if __name__ == "__main__":
    unittest.main()
