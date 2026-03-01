# -*- coding:utf-8 -*-
"""
Merkle tree 测试
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


# ========== Unit: Merkle tree ====================================

class MerkleTreeTest(unittest.TestCase):

    def test_build_tree_single_file(self):
        from src.sync.merkle import build_tree
        local_files = {
            "a.md": {"path": "/tmp/a.md", "is_dir": False, "mtime": 1}
        }
        hc = {"/tmp/a.md": "abc123"}
        tree = build_tree(local_files, hc)
        self.assertIn("", tree)  # root
        self.assertTrue(len(tree[""]) == 32)  # xxh3_128 hex

    def test_diff_trees_same(self):
        from src.sync.merkle import build_tree, diff_trees
        files = {
            "a.md": {"path": "/tmp/a.md", "is_dir": False, "mtime": 1}
        }
        hc = {"/tmp/a.md": "aaa"}
        t1 = build_tree(files, hc)
        t2 = build_tree(files, hc)
        self.assertEqual(diff_trees(t1, t2), set())

    def test_diff_trees_changed(self):
        from src.sync.merkle import build_tree, diff_trees
        files = {
            "dir1": {"path": "/tmp/dir1", "is_dir": True, "mtime": 1},
            "dir1/a.md": {"path": "/tmp/dir1/a.md", "is_dir": False, "mtime": 1},
            "dir2": {"path": "/tmp/dir2", "is_dir": True, "mtime": 1},
            "dir2/b.md": {"path": "/tmp/dir2/b.md", "is_dir": False, "mtime": 1},
        }
        hc1 = {"/tmp/dir1/a.md": "h1", "/tmp/dir2/b.md": "h2"}
        hc2 = {"/tmp/dir1/a.md": "h1", "/tmp/dir2/b.md": "CHANGED"}
        t1 = build_tree(files, hc1)
        t2 = build_tree(files, hc2)
        changed = diff_trees(t1, t2)
        self.assertIn("dir2", changed)
        self.assertIn("", changed)  # root changed
        self.assertNotIn("dir1", changed)

    def test_new_directory(self):
        from src.sync.merkle import build_tree, diff_trees
        files_old = {"a.md": {"path": "/tmp/a.md", "is_dir": False, "mtime": 1}}
        files_new = {
            "a.md": {"path": "/tmp/a.md", "is_dir": False, "mtime": 1},
            "new": {"path": "/tmp/new", "is_dir": True, "mtime": 1},
            "new/b.md": {"path": "/tmp/new/b.md", "is_dir": False, "mtime": 1},
        }
        hc = {"/tmp/a.md": "h1", "/tmp/new/b.md": "h2"}
        t1 = build_tree(files_old, hc)
        t2 = build_tree(files_new, hc)
        changed = diff_trees(t1, t2)
        self.assertIn("new", changed)



# ========== E2E: full Merkle tree + engine simulation ============

class MerkleE2ETest(unittest.TestCase):

    def test_merkle_detects_changed_subdirectory(self):
        """Merkle tree 识别出只有一个子目录变化"""
        from src.sync.merkle import build_tree, diff_trees
        from src.sync.utils import compute_content_hash

        tmpdir = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(tmpdir, "stable"))
            os.makedirs(os.path.join(tmpdir, "changing"))

            stable_f = os.path.join(tmpdir, "stable", "a.md")
            changing_f = os.path.join(tmpdir, "changing", "b.md")
            with open(stable_f, "w") as f:
                f.write("stable content")
            with open(changing_f, "w") as f:
                f.write("original")

            local_files = {
                "stable": {"path": os.path.join(tmpdir, "stable"), "is_dir": True, "mtime": 100},
                "stable/a.md": {"path": stable_f, "is_dir": False, "mtime": 100},
                "changing": {"path": os.path.join(tmpdir, "changing"), "is_dir": True, "mtime": 100},
                "changing/b.md": {"path": changing_f, "is_dir": False, "mtime": 100},
            }

            hc1 = {stable_f: compute_content_hash(stable_f),
                   changing_f: compute_content_hash(changing_f)}
            t1 = build_tree(local_files, hc1)

            # Modify only the changing file
            with open(changing_f, "w") as f:
                f.write("modified content")
            hc2 = {stable_f: hc1[stable_f],
                   changing_f: compute_content_hash(changing_f)}
            t2 = build_tree(local_files, hc2)

            changed = diff_trees(t1, t2)
            self.assertIn("changing", changed)
            self.assertNotIn("stable", changed)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)



# ========== Unit: Merkle tree edge cases =================================

class MerkleTreeEdgeCaseTest(unittest.TestCase):
    """Coverage: build_tree and diff_trees with empty inputs."""

    def test_empty_local_files(self):
        from src.sync.merkle import build_tree
        result = build_tree({}, {})
        self.assertIn("", result)

    def test_minimal_local_file_info(self):
        from src.sync.merkle import build_tree
        local_files = {"test.md": {"is_dir": False, "path": "/tmp/test.md", "mtime": 0}}
        result = build_tree(local_files, {})
        self.assertIn("", result)

    def test_diff_trees_identical(self):
        from src.sync.merkle import diff_trees
        h = {"": "abc123", "dir1": "def456"}
        result = diff_trees(h, h)
        self.assertEqual(result, set())

    def test_diff_trees_different_root(self):
        from src.sync.merkle import diff_trees
        old = {"": "abc", "dir1": "same"}
        new = {"": "def", "dir1": "same"}
        result = diff_trees(old, new)
        self.assertIn("", result)
        self.assertNotIn("dir1", result)



if __name__ == "__main__":
    unittest.main()
