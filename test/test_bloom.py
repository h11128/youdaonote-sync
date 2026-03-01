# -*- coding:utf-8 -*-
"""
Bloom filter 测试
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


# ========== Unit: Bloom filter ===================================

class BloomFilterTest(unittest.TestCase):

    def test_basic_membership(self):
        from src.sync.bloom import BloomFilter
        bf = BloomFilter(1000, 0.01)
        bf.add("hello")
        bf.add("world")
        self.assertTrue(bf.might_contain("hello"))
        self.assertTrue(bf.might_contain("world"))

    def test_likely_not_present(self):
        from src.sync.bloom import BloomFilter
        bf = BloomFilter(1000, 0.01)
        bf.add("hello")
        false_positives = 0
        for i in range(1000):
            if bf.might_contain(f"test_{i}"):
                false_positives += 1
        # FP rate should be ~1%, allow generous margin
        self.assertLess(false_positives, 50)

    def test_serialize_deserialize(self):
        from src.sync.bloom import BloomFilter
        bf = BloomFilter(100, 0.01)
        bf.add("a")
        bf.add("b")
        data = bf.serialize()
        bf2 = BloomFilter.deserialize(data)
        self.assertTrue(bf2.might_contain("a"))
        self.assertTrue(bf2.might_contain("b"))

    def test_empty_filter(self):
        from src.sync.bloom import BloomFilter
        bf = BloomFilter(10, 0.01)
        self.assertFalse(bf.might_contain("anything"))



# ========== Bug Fix Tests =========================================

class BloomFilterEdgeCaseTest(unittest.TestCase):
    """P0: expected_items=0 + P1: deserialize validation"""

    def test_zero_expected_items_no_crash(self):
        from src.sync.bloom import BloomFilter
        bf = BloomFilter(expected_items=0)
        bf.add("test")
        self.assertTrue(bf.might_contain("test"))

    def test_negative_expected_items_no_crash(self):
        from src.sync.bloom import BloomFilter
        bf = BloomFilter(expected_items=-5)
        bf.add("x")
        self.assertTrue(bf.might_contain("x"))

    def test_deserialize_too_short(self):
        from src.sync.bloom import BloomFilter
        with self.assertRaises(ValueError):
            BloomFilter.deserialize(b"\x00\x01")

    def test_deserialize_empty(self):
        from src.sync.bloom import BloomFilter
        with self.assertRaises(ValueError):
            BloomFilter.deserialize(b"")

    def test_deserialize_wrong_bit_array_size(self):
        import struct
        from src.sync.bloom import BloomFilter
        header = struct.pack("<II", 100, 3)
        wrong_bits = b"\x00" * 5  # should be (100+7)//8 = 13
        with self.assertRaises(ValueError):
            BloomFilter.deserialize(header + wrong_bits)

    def test_serialize_deserialize_roundtrip_still_works(self):
        from src.sync.bloom import BloomFilter
        bf = BloomFilter(500, 0.01)
        for i in range(100):
            bf.add(f"item_{i}")
        data = bf.serialize()
        bf2 = BloomFilter.deserialize(data)
        for i in range(100):
            self.assertTrue(bf2.might_contain(f"item_{i}"))





class BloomFilterImprovementsTest(unittest.TestCase):
    """P1-10: Bloom filter fp_rate validation and improved hash independence."""

    def test_invalid_fp_rate_raises(self):
        from src.sync.bloom import BloomFilter
        with self.assertRaises(ValueError):
            BloomFilter(100, fp_rate=0.0)
        with self.assertRaises(ValueError):
            BloomFilter(100, fp_rate=1.0)
        with self.assertRaises(ValueError):
            BloomFilter(100, fp_rate=-0.1)

    def test_valid_fp_rate(self):
        from src.sync.bloom import BloomFilter
        bf = BloomFilter(1000, fp_rate=0.001)
        bf.add("test")
        self.assertTrue(bf.might_contain("test"))
        self.assertFalse(bf.might_contain("definitely_not_in_set_xyz"))

    def test_false_positive_rate_reasonable(self):
        from src.sync.bloom import BloomFilter
        bf = BloomFilter(1000, fp_rate=0.01)
        for i in range(1000):
            bf.add(f"item_{i}")

        false_positives = 0
        test_count = 10000
        for i in range(test_count):
            if bf.might_contain(f"nonexistent_{i}"):
                false_positives += 1

        fp_rate = false_positives / test_count
        self.assertLess(fp_rate, 0.05,
                        f"FP rate {fp_rate:.3f} too high (expected < 5%)")



# ========== Unit: Bloom filter edge cases =================================

class BloomDeserializeEdgeCaseTest(unittest.TestCase):
    """P0: deserialize must reject m=0 / k=0 to prevent ZeroDivisionError."""

    def test_m_zero_raises(self):
        import struct
        data = struct.pack("<II", 0, 5)
        from src.sync.bloom import BloomFilter
        with self.assertRaises(ValueError):
            BloomFilter.deserialize(data)

    def test_k_zero_raises(self):
        import struct
        data = struct.pack("<II", 100, 0) + bytearray(13)
        from src.sync.bloom import BloomFilter
        with self.assertRaises(ValueError):
            BloomFilter.deserialize(data)

    def test_both_zero_raises(self):
        import struct
        data = struct.pack("<II", 0, 0)
        from src.sync.bloom import BloomFilter
        with self.assertRaises(ValueError):
            BloomFilter.deserialize(data)

    def test_valid_roundtrip(self):
        from src.sync.bloom import BloomFilter
        bf = BloomFilter(100, 0.01)
        bf.add("hello")
        bf.add("world")
        data = bf.serialize()
        bf2 = BloomFilter.deserialize(data)
        self.assertTrue(bf2.might_contain("hello"))
        self.assertTrue(bf2.might_contain("world"))



if __name__ == "__main__":
    unittest.main()
