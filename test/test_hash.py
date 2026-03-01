# -*- coding:utf-8 -*-
"""
哈希计算测试（content_hash、md_normalized_hash、xxhash、rolling_hash）
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


# ========== compute_content_hash 独立函数测试 ==========

class ComputeContentHashTest(unittest.TestCase):
    """
    测试 compute_content_hash 纯函数
    python -m pytest test/test_sync.py::ComputeContentHashTest -v
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_basic_file(self):
        """普通文件计算出非空 hash"""
        from src.sync.utils import compute_content_hash

        # Given
        path = os.path.join(self.tmpdir, "a.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write("hello")

        # When
        h = compute_content_hash(path)

        # Then
        self.assertIsNotNone(h)
        self.assertEqual(len(h), 32)

    def test_crlf_lf_same_hash(self):
        """CRLF 和 LF 文件应产生相同 hash"""
        from src.sync.utils import compute_content_hash

        # Given
        lf_path = os.path.join(self.tmpdir, "lf.md")
        crlf_path = os.path.join(self.tmpdir, "crlf.md")
        with open(lf_path, "wb") as f:
            f.write(b"line1\nline2\n")
        with open(crlf_path, "wb") as f:
            f.write(b"line1\r\nline2\r\n")

        # When / Then
        self.assertEqual(compute_content_hash(lf_path),
                         compute_content_hash(crlf_path))

    def test_bom_stripped(self):
        """UTF-8 BOM 文件与无 BOM 文件应产生相同 hash"""
        from src.sync.utils import compute_content_hash

        # Given
        plain = os.path.join(self.tmpdir, "plain.md")
        bom = os.path.join(self.tmpdir, "bom.md")
        with open(plain, "wb") as f:
            f.write(b"hello")
        with open(bom, "wb") as f:
            f.write(b"\xef\xbb\xbfhello")

        # When / Then
        self.assertEqual(compute_content_hash(plain),
                         compute_content_hash(bom))

    def test_empty_file(self):
        """空文件返回非 None hash"""
        from src.sync.utils import compute_content_hash

        path = os.path.join(self.tmpdir, "empty.md")
        with open(path, "wb"):
            pass

        h = compute_content_hash(path)
        self.assertIsNotNone(h)

    def test_nonexistent_file_returns_none(self):
        """文件不存在返回 None"""
        from src.sync.utils import compute_content_hash

        h = compute_content_hash(os.path.join(self.tmpdir, "no_such.md"))
        self.assertIsNone(h)

    def test_empty_path_raises_value_error(self):
        """空路径抛出 ValueError"""
        from src.sync.utils import compute_content_hash

        with self.assertRaises(ValueError):
            compute_content_hash("")



# ========== Markdown 格式归一化 hash 测试 ==========

class MdNormalizedHashTest(unittest.TestCase):
    """
    验证 .md 文件 hash 在编辑器格式差异下保持一致
    python -m pytest test/test_sync.py::MdNormalizedHashTest -v
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write(self, name, content):
        path = os.path.join(self.tmpdir, name)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return path

    def test_hr_star_vs_dash(self):
        """*** 和 --- 分隔线应产生相同 hash"""
        from src.sync.utils import compute_content_hash
        a = self._write("a.md", "# Title\n\n***\n\nContent\n")
        b = self._write("b.md", "# Title\n\n---\n\nContent\n")
        self.assertEqual(compute_content_hash(a), compute_content_hash(b))

    def test_list_marker_star_vs_dash(self):
        """* 和 - 无序列表标记应产生相同 hash"""
        from src.sync.utils import compute_content_hash
        a = self._write("a.md", "*   Item one\n*   Item two\n")
        b = self._write("b.md", "- Item one\n- Item two\n")
        self.assertEqual(compute_content_hash(a), compute_content_hash(b))

    def test_ordered_list_spacing(self):
        """1.  xxx 和 1. xxx 应产生相同 hash"""
        from src.sync.utils import compute_content_hash
        a = self._write("a.md", "1.  First\n2.  Second\n")
        b = self._write("b.md", "1. First\n2. Second\n")
        self.assertEqual(compute_content_hash(a), compute_content_hash(b))

    def test_table_alignment_padding(self):
        """表格对齐空格不影响 hash"""
        from src.sync.utils import compute_content_hash
        a = self._write("a.md", "| Name        | Age |\n| foo         | 30  |\n")
        b = self._write("b.md", "| Name | Age |\n| foo | 30 |\n")
        self.assertEqual(compute_content_hash(a), compute_content_hash(b))

    def test_blank_lines_ignored(self):
        """空行数量差异不影响 hash"""
        from src.sync.utils import compute_content_hash
        a = self._write("a.md", "# Title\n\n\nPara1\n\n\n\nPara2\n")
        b = self._write("b.md", "# Title\nPara1\nPara2\n")
        self.assertEqual(compute_content_hash(a), compute_content_hash(b))

    def test_escaped_underscore(self):
        r"""\_ 和 _ 应产生相同 hash"""
        from src.sync.utils import compute_content_hash
        a = self._write("a.md", "Speaker\\_1 said hello\n")
        b = self._write("b.md", "Speaker_1 said hello\n")
        self.assertEqual(compute_content_hash(a), compute_content_hash(b))

    def test_real_content_diff_still_different(self):
        """真正不同的内容应产生不同 hash"""
        from src.sync.utils import compute_content_hash
        a = self._write("a.md", "Apple\n")
        b = self._write("b.md", "Banana\n")
        self.assertNotEqual(compute_content_hash(a), compute_content_hash(b))

    def test_blockquote_list_marker(self):
        """引用块内的 * → - 归一化"""
        from src.sync.utils import compute_content_hash
        a = self._write("a.md", "> * Item one\n> * Item two\n")
        b = self._write("b.md", "> - Item one\n> - Item two\n")
        self.assertEqual(compute_content_hash(a), compute_content_hash(b))

    def test_table_separator_dash_count(self):
        """表格分隔行不同破折号数量应产生相同 hash"""
        from src.sync.utils import compute_content_hash
        a = self._write("a.md",
            "| Name | Age |\n| ---------- | --- |\n| foo | 30 |\n")
        b = self._write("b.md",
            "| Name | Age |\n|------|-----|\n| foo | 30 |\n")
        self.assertEqual(compute_content_hash(a), compute_content_hash(b))

    def test_backslash_dollar_escape(self):
        r"""\$ 和 $ 应产生相同 hash"""
        from src.sync.utils import compute_content_hash
        a = self._write("a.md", "Price: \\$100\n")
        b = self._write("b.md", "Price: $100\n")
        self.assertEqual(compute_content_hash(a), compute_content_hash(b))

    def test_angle_bracket_link(self):
        """<URL> 和 URL 应产生相同 hash"""
        from src.sync.utils import compute_content_hash
        a = self._write("a.md", "Visit <https://example.com>\n")
        b = self._write("b.md", "Visit https://example.com\n")
        self.assertEqual(compute_content_hash(a), compute_content_hash(b))

    def test_code_fence_stripping(self):
        """代码围栏行不影响 hash"""
        from src.sync.utils import compute_content_hash
        a = self._write("a.md", "Config:\n```\nkey: value\n```\n")
        b = self._write("b.md", "Config:\nkey: value\n")
        self.assertEqual(compute_content_hash(a), compute_content_hash(b))

    def test_table_cell_padding(self):
        """表格单元格 padding 不影响 hash"""
        from src.sync.utils import compute_content_hash
        a = self._write("a.md", "| Name | Age |\n|---|---|\n| foo | 30 |\n")
        b = self._write("b.md", "|Name|Age|\n|---|---|\n|foo|30|\n")
        self.assertEqual(compute_content_hash(a), compute_content_hash(b))

    def test_non_md_not_normalized(self):
        """.py 文件不应做 md 归一化"""
        from src.sync.utils import compute_content_hash
        a = self._write("a.py", "x = 1\n\n\ny = 2\n")
        b = self._write("b.py", "x = 1\ny = 2\n")
        self.assertNotEqual(compute_content_hash(a), compute_content_hash(b))

    def test_hash_from_bytes_consistent(self):
        """compute_hash_from_bytes 对 .md 应用同样的归一化"""
        from src.sync.utils import compute_content_hash, compute_hash_from_bytes
        path = self._write("test.md", "# Title\n\n***\n\n*   Item\n")
        file_hash = compute_content_hash(path)
        byte_hash = compute_hash_from_bytes(
            b"# Title\n\n---\n\n- Item\n", "test.md")
        self.assertEqual(file_hash, byte_hash)





class LargeFileHashTest(unittest.TestCase):
    """大文件 hash（> 1MB 阈值）测试"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_large_binary_file(self):
        """大二进制文件使用 mmap 路径，返回有效 hash"""
        from src.sync.utils import compute_content_hash

        path = os.path.join(self.tmpdir, "big.bin")
        with open(path, "wb") as f:
            f.write(b"\x00" * (1024 * 1024 + 1))

        h = compute_content_hash(path)
        self.assertIsNotNone(h)
        self.assertEqual(len(h), 32)

    def test_large_text_small_text_consistency(self):
        """大文本路径和小文本路径对同一内容产生相同 hash"""
        from src.sync.utils import (
            _hash_small_text_file, _hash_large_text_file)

        content = b"line1\r\nline2\r\nline3\n"
        path = os.path.join(self.tmpdir, "test.css")
        with open(path, "wb") as f:
            f.write(content)

        small_hash = _hash_small_text_file(path)
        large_hash = _hash_large_text_file(path, chunk_size=8)
        self.assertEqual(small_hash, large_hash)

    def test_crlf_split_across_chunks(self):
        """CRLF 跨 chunk 边界时，hash 应与完整读取一致"""
        from src.sync.utils import (
            _hash_small_text_file, _hash_large_text_file)

        # chunk_size=5 → "ABCD\r" | "\nEFGH" 正好把 \r\n 拆开
        content = b"ABCD\r\nEFGH"
        path = os.path.join(self.tmpdir, "split.css")
        with open(path, "wb") as f:
            f.write(content)

        small_hash = _hash_small_text_file(path)
        large_hash = _hash_large_text_file(path, chunk_size=5)
        self.assertEqual(small_hash, large_hash)

    def test_file_ending_with_cr(self):
        """文件以 \\r 结尾时两种路径结果一致"""
        from src.sync.utils import (
            _hash_small_text_file, _hash_large_text_file)

        content = b"hello\r"
        path = os.path.join(self.tmpdir, "cr_end.css")
        with open(path, "wb") as f:
            f.write(content)

        small_hash = _hash_small_text_file(path)
        large_hash = _hash_large_text_file(path, chunk_size=4)
        self.assertEqual(small_hash, large_hash)

    def test_bom_only_stripped_from_start(self):
        """BOM 只从文件开头去除，中间出现的 BOM 字节不影响"""
        from src.sync.utils import (
            _hash_small_text_file, _hash_large_text_file)

        content = b"\xef\xbb\xbfhello \xef\xbb\xbf world"
        path = os.path.join(self.tmpdir, "mid_bom.css")
        with open(path, "wb") as f:
            f.write(content)

        small_hash = _hash_small_text_file(path)
        large_hash = _hash_large_text_file(path, chunk_size=6)
        self.assertEqual(small_hash, large_hash)





class ComputeHashFromBytesTest(unittest.TestCase):
    """compute_hash_from_bytes 与 compute_content_hash 一致性"""

    def test_text_matches_file_hash(self):
        from src.sync.utils import compute_hash_from_bytes, compute_content_hash
        content = "Hello\r\nWorld\r\n"
        tmpdir = tempfile.mkdtemp()
        try:
            path = os.path.join(tmpdir, "test.md")
            with open(path, "wb") as f:
                f.write(content.encode("utf-8"))
            file_hash = compute_content_hash(path)
            bytes_hash = compute_hash_from_bytes(content.encode("utf-8"), "test.md")
            self.assertEqual(file_hash, bytes_hash)
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_bom_stripped(self):
        from src.sync.utils import compute_hash_from_bytes
        with_bom = b"\xef\xbb\xbfHello"
        without_bom = b"Hello"
        self.assertEqual(
            compute_hash_from_bytes(with_bom, "test.md"),
            compute_hash_from_bytes(without_bom, "test.md"))

    def test_binary_no_normalization(self):
        from src.sync.utils import compute_hash_from_bytes
        import xxhash
        data = b"\x00\x01\r\n\x02"
        expected = xxhash.xxh3_128(data).hexdigest()
        self.assertEqual(
            compute_hash_from_bytes(data, "test.png"), expected)

    def test_empty_bytes(self):
        from src.sync.utils import compute_hash_from_bytes
        result = compute_hash_from_bytes(b"", "test.md")
        self.assertIsNotNone(result)



# ========== Unit: xxhash =========================================

class XxhashReplacementTest(unittest.TestCase):

    def test_compute_content_hash_uses_xxhash(self):
        from src.sync.utils import compute_content_hash
        tmpdir = tempfile.mkdtemp()
        try:
            p = os.path.join(tmpdir, "a.md")
            with open(p, "w", encoding="utf-8") as f:
                f.write("hello")
            h = compute_content_hash(p)
            self.assertIsNotNone(h)
            # xxh3_128 produces 32-char hex
            self.assertEqual(len(h), 32)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_hash_consistency_text_normalization(self):
        """CRLF 和 LF 文件应产生相同 hash"""
        from src.sync.utils import compute_content_hash
        tmpdir = tempfile.mkdtemp()
        try:
            p1 = os.path.join(tmpdir, "crlf.md")
            p2 = os.path.join(tmpdir, "lf.md")
            with open(p1, "wb") as f:
                f.write(b"line1\r\nline2\r\n")
            with open(p2, "wb") as f:
                f.write(b"line1\nline2\n")
            self.assertEqual(compute_content_hash(p1),
                             compute_content_hash(p2))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_binary_hash_no_normalization(self):
        """二进制文件不做 CRLF 规范化"""
        from src.sync.utils import compute_content_hash
        tmpdir = tempfile.mkdtemp()
        try:
            p1 = os.path.join(tmpdir, "a.png")
            p2 = os.path.join(tmpdir, "b.png")
            with open(p1, "wb") as f:
                f.write(b"\x89PNG\r\n\x1a\n")
            with open(p2, "wb") as f:
                f.write(b"\x89PNG\n\x1a\n")
            self.assertNotEqual(compute_content_hash(p1),
                                compute_content_hash(p2))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)



# ========== Unit: Rolling hash + delta ===========================

class RollingHashDeltaTest(unittest.TestCase):

    def test_block_hashes_consistent(self):
        from src.sync.rolling_hash import BlockHash
        tmpdir = tempfile.mkdtemp()
        try:
            p = os.path.join(tmpdir, "test.bin")
            with open(p, "wb") as f:
                f.write(b"A" * 8192)
            rh = BlockHash(block_size=4096)
            hashes = rh.compute_block_hashes(p)
            self.assertEqual(len(hashes), 2)
            # same content blocks = same hash
            self.assertEqual(hashes[0][2], hashes[1][2])
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_diff_blocks_detects_change(self):
        from src.sync.rolling_hash import BlockHash, diff_blocks
        tmpdir = tempfile.mkdtemp()
        try:
            p1 = os.path.join(tmpdir, "old.bin")
            p2 = os.path.join(tmpdir, "new.bin")
            with open(p1, "wb") as f:
                f.write(b"A" * 4096 + b"B" * 4096)
            with open(p2, "wb") as f:
                f.write(b"A" * 4096 + b"C" * 4096)
            rh = BlockHash()
            h1 = rh.compute_block_hashes(p1)
            h2 = rh.compute_block_hashes(p2)
            changes = diff_blocks(h1, h2)
            self.assertEqual(len(changes), 1)
            self.assertEqual(changes[0]["block_type"], "changed")
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_delta_roundtrip(self):
        from src.sync.rolling_hash import encode_delta, apply_delta
        tmpdir = tempfile.mkdtemp()
        try:
            old_p = os.path.join(tmpdir, "old.bin")
            new_p = os.path.join(tmpdir, "new.bin")
            with open(old_p, "wb") as f:
                f.write(b"X" * 4096 + b"Y" * 4096)
            new_content = b"X" * 4096 + b"Z" * 4096
            with open(new_p, "wb") as f:
                f.write(new_content)
            delta = encode_delta(old_p, new_p)
            reconstructed = apply_delta(old_p, delta)
            self.assertEqual(reconstructed, new_content)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_delta_identical_files(self):
        from src.sync.rolling_hash import encode_delta, apply_delta
        tmpdir = tempfile.mkdtemp()
        try:
            p = os.path.join(tmpdir, "same.bin")
            content = b"same content here " * 500
            with open(p, "wb") as f:
                f.write(content)
            delta = encode_delta(p, p)
            self.assertEqual(apply_delta(p, delta), content)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)





class RollingHashDeltaEdgeCaseTest(unittest.TestCase):
    """P0: unknown op / bounds checking in apply_delta"""

    def test_unknown_op_raises_error(self):
        import struct
        from src.sync.rolling_hash import apply_delta
        tmpdir = tempfile.mkdtemp()
        try:
            old_path = os.path.join(tmpdir, "old.bin")
            with open(old_path, "wb") as f:
                f.write(b"hello world")
            bad_delta = bytes([99])  # unknown op
            with self.assertRaises(ValueError) as ctx:
                apply_delta(old_path, bad_delta)
            self.assertIn("Unknown delta op", str(ctx.exception))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_copy_out_of_range_raises(self):
        import struct
        from src.sync.rolling_hash import apply_delta
        tmpdir = tempfile.mkdtemp()
        try:
            old_path = os.path.join(tmpdir, "old.bin")
            with open(old_path, "wb") as f:
                f.write(b"short")
            delta = struct.pack("<BII", 0, 0, 9999)  # copy beyond old_data
            with self.assertRaises(ValueError) as ctx:
                apply_delta(old_path, delta)
            self.assertIn("COPY out of range", str(ctx.exception))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_insert_out_of_range_raises(self):
        import struct
        from src.sync.rolling_hash import apply_delta
        tmpdir = tempfile.mkdtemp()
        try:
            old_path = os.path.join(tmpdir, "old.bin")
            with open(old_path, "wb") as f:
                f.write(b"data")
            delta = struct.pack("<BI", 1, 9999)  # insert length exceeds delta
            with self.assertRaises(ValueError) as ctx:
                apply_delta(old_path, delta)
            self.assertIn("INSERT out of range", str(ctx.exception))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_truncated_copy_header_raises(self):
        from src.sync.rolling_hash import apply_delta
        tmpdir = tempfile.mkdtemp()
        try:
            old_path = os.path.join(tmpdir, "old.bin")
            with open(old_path, "wb") as f:
                f.write(b"data")
            delta = bytes([0, 0x01])  # only 1 byte after op, need 8
            with self.assertRaises(ValueError) as ctx:
                apply_delta(old_path, delta)
            self.assertIn("truncated", str(ctx.exception).lower())
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_valid_delta_still_works(self):
        from src.sync.rolling_hash import encode_delta, apply_delta
        tmpdir = tempfile.mkdtemp()
        try:
            old_path = os.path.join(tmpdir, "old.txt")
            new_path = os.path.join(tmpdir, "new.txt")
            with open(old_path, "w") as f:
                f.write("A" * 8192)
            with open(new_path, "w") as f:
                f.write("A" * 4096 + "B" * 4096)
            delta = encode_delta(old_path, new_path)
            result = apply_delta(old_path, delta)
            with open(new_path, "rb") as f:
                expected = f.read()
            self.assertEqual(result, expected)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)





class UtilsHashFromBytesTest(unittest.TestCase):
    """P2: compute_hash_from_bytes None guard clarity."""

    def test_none_returns_none(self):
        from src.sync.utils import compute_hash_from_bytes
        result = compute_hash_from_bytes(None, "test.md")
        self.assertIsNone(result)

    def test_empty_bytes_returns_hash(self):
        from src.sync.utils import compute_hash_from_bytes
        result = compute_hash_from_bytes(b"", "test.md")
        self.assertIsNotNone(result)

    def test_normal_bytes_returns_hash(self):
        from src.sync.utils import compute_hash_from_bytes
        result = compute_hash_from_bytes(b"hello world", "test.md")
        self.assertIsNotNone(result)
        self.assertEqual(len(result), 32)





class BlockHashRenameTest(unittest.TestCase):
    """P2: RabinHash renamed to BlockHash."""

    def test_import_block_hash(self):
        from src.sync.rolling_hash import BlockHash
        rh = BlockHash(block_size=1024)
        self.assertEqual(rh.block_size, 1024)



# ========== Unit: Rolling hash edge cases =================================

class BlockHashValidationTest(unittest.TestCase):
    """P0: BlockHash(block_size=0) must raise ValueError."""

    def test_block_size_zero_raises(self):
        from src.sync.rolling_hash import BlockHash
        with self.assertRaises(ValueError):
            BlockHash(block_size=0)

    def test_block_size_negative_raises(self):
        from src.sync.rolling_hash import BlockHash
        with self.assertRaises(ValueError):
            BlockHash(block_size=-1)

    def test_block_size_one_works(self):
        from src.sync.rolling_hash import BlockHash
        bh = BlockHash(block_size=1)
        self.assertEqual(bh.block_size, 1)





class DiffBlocksAddedRemovedTest(unittest.TestCase):
    """Coverage: diff_blocks 'added' and 'removed' block types."""

    def test_added_blocks(self):
        from src.sync.rolling_hash import diff_blocks
        old_h = [(0, 4, "aaa")]
        new_h = [(0, 4, "aaa"), (4, 4, "bbb")]
        result = diff_blocks(old_h, new_h)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["block_type"], "added")
        self.assertEqual(result[0]["offset"], 4)

    def test_removed_blocks(self):
        from src.sync.rolling_hash import diff_blocks
        old_h = [(0, 4, "aaa"), (4, 4, "bbb")]
        new_h = [(0, 4, "aaa")]
        result = diff_blocks(old_h, new_h)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["block_type"], "removed")

    def test_no_changes(self):
        from src.sync.rolling_hash import diff_blocks
        old_h = [(0, 4, "aaa"), (4, 4, "bbb")]
        new_h = [(0, 4, "aaa"), (4, 4, "bbb")]
        result = diff_blocks(old_h, new_h)
        self.assertEqual(result, [])

    def test_changed_block(self):
        from src.sync.rolling_hash import diff_blocks
        old_h = [(0, 4, "aaa")]
        new_h = [(0, 4, "bbb")]
        result = diff_blocks(old_h, new_h)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["block_type"], "changed")



if __name__ == "__main__":
    unittest.main()
