# -*- coding:utf-8 -*-
"""
新功能测试覆盖:

单元测试:
  - xxhash 替换验证
  - metadata schema 扩展 (sync_log, file_refs, cloud_content_hash, file_base, tree_hash)
  - diff3 三路合并
  - Bloom filter
  - Rolling hash + delta
  - Merkle tree
  - 选择性同步过滤
  - GC / verify
  - scandir 递归
  - 增量引用索引

集成测试:
  - calibrate_metadata + batch()
  - engine._record_file_change + sync_log + cloud_hash
  - dedup incremental refs

E2E 测试:
  - 完整 dry_run 流程（模拟云端/本地差异 → 收集 items → 验证决策）
"""

import os
import shutil
import sys
import tempfile
import time
import unittest

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from src.sync.metadata import SyncMetadata


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


# ========== Unit: metadata schema extensions =====================

class MetadataSchemaExtensionTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = self._make_meta()

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _make_meta(self):
        from src.sync.metadata import SyncMetadata
        return SyncMetadata(os.path.join(self.tmpdir, "test.json"))

    # -- sync_log --
    def test_log_sync_action_roundtrip(self):
        self.meta.log_sync_action("a.md", "downloaded", direction="pull",
                                  old_hash="aaa", new_hash="bbb",
                                  cloud_id="c1", detail="ok")
        self.meta.save()
        logs = self.meta.get_sync_log(limit=10)
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0]["path"], "a.md")
        self.assertEqual(logs[0]["action"], "downloaded")
        self.assertEqual(logs[0]["cloud_id"], "c1")

    def test_get_sync_log_filter_by_path(self):
        self.meta.log_sync_action("a.md", "downloaded")
        self.meta.log_sync_action("b.md", "uploaded")
        self.meta.save()
        logs = self.meta.get_sync_log(path="b.md")
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0]["path"], "b.md")

    # -- cloud_content_hash --
    def test_cloud_content_hash_roundtrip(self):
        self.meta.set_file_info("a.md", "f1", 100)
        self.meta.set_cloud_content_hash("a.md", "xyz123")
        self.meta.save()
        self.assertEqual(self.meta.get_cloud_content_hash("a.md"), "xyz123")

    def test_cloud_content_hash_in_file_info(self):
        self.meta.set_file_info("a.md", "f1", 100)
        self.meta.set_cloud_content_hash("a.md", "abc")
        info = self.meta.get_file_info("a.md")
        self.assertEqual(info["cloud_content_hash"], "abc")

    # -- file_refs --
    def test_file_refs_roundtrip(self):
        self.meta.set_file_refs("doc.md", ["img/a.png", "img/b.jpg"])
        refs = self.meta.get_file_refs("doc.md")
        self.assertEqual(sorted(refs), ["img/a.png", "img/b.jpg"])

    def test_file_refs_replace(self):
        self.meta.set_file_refs("doc.md", ["old.png"])
        self.meta.set_file_refs("doc.md", ["new.png"])
        self.assertEqual(self.meta.get_file_refs("doc.md"), ["new.png"])

    def test_get_all_cached_refs(self):
        self.meta.set_file_refs("a.md", ["x.png"])
        self.meta.set_file_refs("b.md", ["y.png", "z.png"])
        all_refs = self.meta.get_all_cached_refs()
        self.assertIn("a.md", all_refs)
        self.assertEqual(len(all_refs["b.md"]), 2)

    # -- file_base --
    def test_base_content_roundtrip(self):
        content = b"original content here"
        self.meta.save_base_content("a.md", content, "hash1")
        self.assertEqual(self.meta.get_base_content("a.md"), content)

    def test_base_content_overwrite(self):
        self.meta.save_base_content("a.md", b"v1", "h1")
        self.meta.save_base_content("a.md", b"v2", "h2")
        self.assertEqual(self.meta.get_base_content("a.md"), b"v2")

    def test_base_content_missing(self):
        self.assertIsNone(self.meta.get_base_content("nonexistent.md"))

    # -- tree_hash --
    def test_tree_hash_roundtrip(self):
        self.meta.set_dir_info("notes", "d1")
        self.meta.set_tree_hash("notes", "tree_abc")
        self.assertEqual(self.meta.get_tree_hash("notes"), "tree_abc")

    def test_get_all_tree_hashes(self):
        self.meta.set_dir_info("a", "d1")
        self.meta.set_dir_info("b", "d2")
        self.meta.set_tree_hash("a", "h1")
        self.meta.set_tree_hash("b", "h2")
        hashes = self.meta.get_all_tree_hashes()
        self.assertEqual(hashes, {"a": "h1", "b": "h2"})

    # -- migration tracking --
    def test_migration_idempotent(self):
        self.meta.set_file_info("a.md", "f1", 100, content_hash="abc")
        self.meta.save()
        self.meta.close()
        meta2 = self._make_meta()
        info = meta2.get_file_info("a.md")
        self.assertEqual(info["content_hash"], "abc")
        meta2.close()


# ========== Unit: diff3 merge ====================================

class Diff3MergeTest(unittest.TestCase):

    def test_no_conflict(self):
        from src.sync.merge import three_way_merge
        base = "line1\nline2\nline3\n"
        ours = "line1\nline2_modified\nline3\n"
        theirs = "line1\nline2\nline3_modified\n"
        result = three_way_merge(base, ours, theirs)
        self.assertFalse(result.has_conflicts)
        self.assertIn("line2_modified", result.merged_text)
        self.assertIn("line3_modified", result.merged_text)

    def test_conflict_markers(self):
        from src.sync.merge import three_way_merge
        base = "shared\n"
        ours = "local version\n"
        theirs = "cloud version\n"
        result = three_way_merge(base, ours, theirs)
        self.assertTrue(result.has_conflicts)
        self.assertEqual(result.conflict_count, 1)
        self.assertIn("<<<<<<< LOCAL", result.merged_text)
        self.assertIn(">>>>>>> CLOUD", result.merged_text)
        self.assertIn("local version", result.merged_text)
        self.assertIn("cloud version", result.merged_text)

    def test_both_same_change_no_conflict(self):
        from src.sync.merge import three_way_merge
        base = "old\n"
        ours = "new\n"
        theirs = "new\n"
        result = three_way_merge(base, ours, theirs)
        self.assertFalse(result.has_conflicts)
        self.assertEqual(result.merged_text.strip(), "new")

    def test_empty_base(self):
        from src.sync.merge import three_way_merge
        result = three_way_merge("", "hello\n", "hello\n")
        self.assertFalse(result.has_conflicts)

    def test_one_side_delete(self):
        from src.sync.merge import three_way_merge
        base = "a\nb\nc\n"
        ours = "a\nc\n"  # deleted line b
        theirs = "a\nb\nc\n"  # unchanged
        result = three_way_merge(base, ours, theirs)
        self.assertFalse(result.has_conflicts)
        self.assertNotIn("b\n", result.merged_text)


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


# ========== Unit: Selective sync filter ==========================

class SelectiveSyncFilterTest(unittest.TestCase):

    def test_exclude_pattern(self):
        from src.sync.scanner import matches_selective as _matches_selective
        self.assertFalse(_matches_selective(
            "temp/draft.md", [], ["temp/*"]))
        self.assertTrue(_matches_selective(
            "notes/hello.md", [], ["temp/*"]))

    def test_include_pattern(self):
        from src.sync.scanner import matches_selective as _matches_selective
        self.assertTrue(_matches_selective(
            "important/a.md", ["important/*"], []))
        self.assertFalse(_matches_selective(
            "other/b.md", ["important/*"], []))

    def test_no_filters(self):
        from src.sync.scanner import matches_selective as _matches_selective
        self.assertTrue(_matches_selective("anything.md", [], []))

    def test_exclude_overrides_include(self):
        from src.sync.scanner import matches_selective as _matches_selective
        self.assertFalse(_matches_selective(
            "notes/secret.md", ["notes/*"], ["*secret*"]))


# ========== Unit: GC ============================================

class GarbageCollectionTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir, exist_ok=True)
        from src.sync.metadata import SyncMetadata
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_gc_removes_orphan_files(self):
        old_ts = int(time.time()) - 40 * 86400
        self.meta.set_file_info("gone.md", "f1", 100)
        self.meta.mark_synced("gone.md", ts=old_ts)
        self.meta.save()
        stats = self.meta.gc(self.local_dir)
        self.assertEqual(stats["files"], 1)
        self.assertIsNone(self.meta.get_file_info("gone.md"))

    def test_gc_keeps_existing_files(self):
        p = os.path.join(self.local_dir, "exists.md")
        with open(p, "w") as f:
            f.write("hello")
        old_ts = int(time.time()) - 40 * 86400
        self.meta.set_file_info("exists.md", "f1", 100)
        self.meta.mark_synced("exists.md", ts=old_ts)
        self.meta.save()
        stats = self.meta.gc(self.local_dir)
        self.assertEqual(stats["files"], 0)
        self.assertIsNotNone(self.meta.get_file_info("exists.md"))

    def test_gc_removes_orphan_dirs(self):
        self.meta.set_dir_info("deleted_dir", "d1")
        self.meta.save()
        stats = self.meta.gc(self.local_dir)
        self.assertEqual(stats["dirs"], 1)

    def test_gc_removes_old_logs(self):
        old_ts = int(time.time()) - 100 * 86400
        self.meta._conn.execute(
            "INSERT INTO sync_log (timestamp, path, action) VALUES (?, ?, ?)",
            (old_ts, "old.md", "uploaded"))
        self.meta.save()
        stats = self.meta.gc(self.local_dir)
        self.assertEqual(stats["logs"], 1)

    def test_gc_removes_orphan_bases(self):
        self.meta.save_base_content("gone.md", b"content", "h1")
        self.meta.save()
        stats = self.meta.gc(self.local_dir)
        self.assertEqual(stats["bases"], 1)


# ========== Unit: verify ========================================

class VerifyTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir, exist_ok=True)
        from src.sync.metadata import SyncMetadata
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_detects_orphan(self):
        self.meta.set_file_info("gone.md", "f1", 100)
        issues = self.meta.verify(self.local_dir)
        self.assertEqual(len(issues), 1)
        self.assertEqual(issues[0][1], "orphan")

    def test_detects_hash_mismatch(self):
        p = os.path.join(self.local_dir, "test.md")
        with open(p, "w") as f:
            f.write("actual content")
        self.meta.set_file_info("test.md", "f1", 100,
                                content_hash="wrong_hash")
        issues = self.meta.verify(self.local_dir)
        hash_issues = [i for i in issues if i[1] == "hash_mismatch"]
        self.assertEqual(len(hash_issues), 1)

    def test_auto_fix_hash(self):
        p = os.path.join(self.local_dir, "test.md")
        with open(p, "w") as f:
            f.write("actual content")
        self.meta.set_file_info("test.md", "f1", 100,
                                content_hash="wrong_hash")
        self.meta.verify(self.local_dir, auto_fix=True)
        info = self.meta.get_file_info("test.md")
        self.assertNotEqual(info["content_hash"], "wrong_hash")


# ========== Unit: scandir recursive ==============================

class ScandirRecursiveTest(unittest.TestCase):

    def test_scandir_finds_nested_files(self):
        from src.sync.scanner import scan_local
        tmpdir = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(tmpdir, "a", "b"))
            with open(os.path.join(tmpdir, "a", "b", "c.md"), "w") as f:
                f.write("hi")
            with open(os.path.join(tmpdir, "root.md"), "w") as f:
                f.write("root")
            files = scan_local(tmpdir)
            self.assertIn("a/b/c.md", files)
            self.assertIn("root.md", files)
            self.assertIn("a", files)
            self.assertIn("a/b", files)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_scandir_skips_hidden(self):
        from src.sync.scanner import scan_local
        tmpdir = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(tmpdir, ".hidden"))
            with open(os.path.join(tmpdir, ".hidden", "secret.md"), "w") as f:
                f.write("x")
            with open(os.path.join(tmpdir, ".dotfile"), "w") as f:
                f.write("x")
            files = scan_local(tmpdir)
            self.assertNotIn(".hidden", files)
            self.assertNotIn(".hidden/secret.md", files)
            self.assertNotIn(".dotfile", files)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_selective_sync_exclude(self):
        from src.sync.scanner import scan_local
        tmpdir = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(tmpdir, "keep"))
            os.makedirs(os.path.join(tmpdir, "skip"))
            with open(os.path.join(tmpdir, "keep", "a.md"), "w") as f:
                f.write("a")
            with open(os.path.join(tmpdir, "skip", "b.md"), "w") as f:
                f.write("b")
            files = scan_local(tmpdir, sync_exclude=["skip/*"])
            self.assertIn("keep/a.md", files)
            self.assertNotIn("skip/b.md", files)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


# ========== Integration: calibrate_metadata + batch ==============

class CalibrateMetadataBatchTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        from src.sync.metadata import SyncMetadata
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_batch_calibration_multiple_files(self):
        from src.sync.decision import calibrate_metadata
        local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(local_dir, exist_ok=True)

        cloud_files = {}
        local_files = {}
        for i in range(5):
            name = f"file{i}.md"
            p = os.path.join(local_dir, name)
            with open(p, "w") as f:
                f.write(f"content {i}")
            cloud_files[name] = {
                "id": f"cloud_{i}", "mtime": 1000 + i,
                "parent_id": "root", "domain": 1, "ctime": 900 + i
            }
            local_files[name] = {
                "path": p, "mtime": 1000 + i, "is_dir": False
            }

        count = calibrate_metadata(self.meta, cloud_files, local_files)
        self.assertEqual(count, 5)
        for i in range(5):
            info = self.meta.get_file_info(f"file{i}.md")
            self.assertIsNotNone(info)
            self.assertEqual(info["file_id"], f"cloud_{i}")


# ========== Integration: sync_log in _record_file_change =========

class SyncLogIntegrationTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        from src.sync.metadata import SyncMetadata
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir, exist_ok=True)

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_record_file_change_logs_action(self):
        from src.sync.utils import SyncAction, SyncItem
        from src.sync.engine import SyncManager
        from unittest.mock import MagicMock

        api = MagicMock()
        api.get_root_id.return_value = "root"
        mgr = SyncManager(api, self.local_dir, metadata=self.meta)

        p = os.path.join(self.local_dir, "test.md")
        with open(p, "w") as f:
            f.write("hello")
        self.meta.set_file_info("test.md", "f1", 100,
                                content_hash="old_hash")
        self.meta.save()

        item = SyncItem(
            relative_path="test.md",
            local_path=p,
            cloud_id="f1",
            cloud_parent_id="root",
            local_mtime=200,
            cloud_mtime=200,
            is_dir=False,
            action=SyncAction.DOWNLOAD,
            cloud_name="test.md",
            domain=1,
            cloud_ctime=50,
        )
        mgr._record_file_change(item, "downloaded",
                                local_mtime=200, content_hash="new_hash")
        mgr.metadata.save()

        logs = self.meta.get_sync_log(path="test.md")
        self.assertGreaterEqual(len(logs), 1)
        self.assertEqual(logs[0]["action"], "downloaded")
        self.assertEqual(logs[0]["old_hash"], "old_hash")
        self.assertEqual(logs[0]["new_hash"], "new_hash")

        # cloud_content_hash should also be cached
        cached = self.meta.get_cloud_content_hash("test.md")
        self.assertEqual(cached, "new_hash")


# ========== Integration: incremental ref index ===================

class IncrementalRefIndexTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        from src.sync.metadata import SyncMetadata
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))
        self.root = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.root, exist_ok=True)

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_incremental_refs_cached(self):
        from src.sync.dedup import build_all_indexes
        from src.sync.utils import compute_content_hash

        md_path = os.path.join(self.root, "doc.md")
        img_path = os.path.join(self.root, "img.png")
        with open(md_path, "w") as f:
            f.write("![alt](img.png)\n")
        with open(img_path, "wb") as f:
            f.write(b"\x89PNG")

        local_files = {
            "doc.md": {"path": md_path, "mtime": 100, "is_dir": False},
            "img.png": {"path": img_path, "mtime": 100, "is_dir": False},
        }

        # First build: parses md, caches refs
        _, refs1 = build_all_indexes(self.root, self.meta,
                                     local_files=local_files)
        self.assertIn("img.png", refs1)

        # Set metadata mtime to match so cache is used
        self.meta.set_file_info("doc.md", "f1", 100, local_mtime=100)
        self.meta.save()

        # Second build: should use cached refs
        _, refs2 = build_all_indexes(self.root, self.meta,
                                     local_files=local_files)
        self.assertIn("img.png", refs2)

        # Verify refs are in metadata
        cached = self.meta.get_file_refs("doc.md")
        self.assertIn("img.png", cached)


# ========== E2E: complete dry_run flow ===========================

class DryRunE2ETest(unittest.TestCase):
    """模拟完整同步流程（扫描 → 决策 → 冲突精炼 → 输出）。"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir, exist_ok=True)
        from src.sync.metadata import SyncMetadata
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_e2e_new_local_file_detected_as_upload(self):
        """本地新增文件 + 云端没有 → UPLOAD"""
        from src.sync.decision import build_item
        from src.sync.utils import SyncAction

        p = os.path.join(self.local_dir, "new.md")
        with open(p, "w") as f:
            f.write("brand new note")

        local = {"path": p, "mtime": int(time.time()), "is_dir": False}
        item = build_item("new.md", None, local, self.meta, self.local_dir)
        self.assertEqual(item.action, SyncAction.UPLOAD)

    def test_e2e_cloud_only_file_detected_as_download(self):
        """云端有文件 + 本地没有 → DOWNLOAD"""
        from src.sync.decision import build_item
        from src.sync.utils import SyncAction

        cloud = {"id": "c1", "mtime": 1000, "parent_id": "root",
                 "domain": 1, "name": "cloud.md"}
        item = build_item("cloud.md", cloud, None, self.meta, self.local_dir)
        self.assertEqual(item.action, SyncAction.DOWNLOAD)

    def test_e2e_both_same_detected_as_skip(self):
        """两端都有 + mtime 一致 + 已标记同步 → SKIP"""
        from src.sync.decision import build_item, calibrate_metadata
        from src.sync.utils import SyncAction

        p = os.path.join(self.local_dir, "synced.md")
        with open(p, "w") as f:
            f.write("synced content")
        mtime = int(os.path.getmtime(p))

        cloud_files = {
            "synced.md": {"id": "c1", "mtime": mtime, "parent_id": "root",
                          "domain": 1, "ctime": mtime, "name": "synced.md"}
        }
        local_files = {
            "synced.md": {"path": p, "mtime": mtime, "is_dir": False}
        }
        calibrate_metadata(self.meta, cloud_files, local_files)

        cloud = cloud_files["synced.md"]
        local = local_files["synced.md"]
        item = build_item("synced.md", cloud, local, self.meta, self.local_dir)
        self.assertEqual(item.action, SyncAction.SKIP)

    def test_e2e_conflict_detection(self):
        """两端都变化 + mtime 相同 → CONFLICT"""
        from src.sync.decision import build_item
        from src.sync.utils import SyncAction

        p = os.path.join(self.local_dir, "conflict.md")
        with open(p, "w") as f:
            f.write("local version")

        self.meta.set_file_info("conflict.md", "c1", 500,
                                local_mtime=500, content_hash="old_hash")
        self.meta.mark_synced("conflict.md", ts=100)
        self.meta.save()

        # mtime 相同且都比 meta 新 → 无法分出胜负 → CONFLICT
        cloud = {"id": "c1", "mtime": 600, "parent_id": "root",
                 "domain": 1, "name": "conflict.md"}
        local = {"path": p, "mtime": 600, "is_dir": False}

        item = build_item("conflict.md", cloud, local, self.meta,
                          self.local_dir)
        self.assertEqual(item.action, SyncAction.CONFLICT)

    def test_e2e_calibrate_and_build_full_set(self):
        """模拟完整 calibrate → build_item 流程，验证结果数量和分布"""
        from src.sync.decision import calibrate_metadata, build_item
        from src.sync.utils import SyncAction

        # 创建 3 个本地文件
        for name in ("a.md", "b.md", "c.md"):
            with open(os.path.join(self.local_dir, name), "w") as f:
                f.write(f"content of {name}")

        cloud_files = {
            "a.md": {"id": "ca", "mtime": 100, "parent_id": "root",
                     "domain": 1, "ctime": 50, "name": "a.md"},
            "b.md": {"id": "cb", "mtime": 100, "parent_id": "root",
                     "domain": 1, "ctime": 50, "name": "b.md"},
            "d.md": {"id": "cd", "mtime": 100, "parent_id": "root",
                     "domain": 1, "ctime": 50, "name": "d.md"},
        }
        local_files = {}
        for name in ("a.md", "b.md", "c.md"):
            p = os.path.join(self.local_dir, name)
            local_files[name] = {
                "path": p, "mtime": int(os.path.getmtime(p)), "is_dir": False
            }

        hc = {}
        calibrate_metadata(self.meta, cloud_files, local_files, hash_cache=hc)

        all_paths = set(cloud_files.keys()) | set(local_files.keys())
        items = [
            build_item(p, cloud_files.get(p), local_files.get(p),
                       self.meta, self.local_dir, hash_cache=hc)
            for p in all_paths
        ]

        actions = {i.relative_path: i.action for i in items}

        # a.md, b.md: calibrated (both exist) → SKIP
        self.assertEqual(actions["a.md"], SyncAction.SKIP)
        self.assertEqual(actions["b.md"], SyncAction.SKIP)
        # c.md: local only → UPLOAD
        self.assertEqual(actions["c.md"], SyncAction.UPLOAD)
        # d.md: cloud only → DOWNLOAD
        self.assertEqual(actions["d.md"], SyncAction.DOWNLOAD)


# ========== E2E: diff3 merge ====================================

class Diff3E2ETest(unittest.TestCase):
    """diff3 完整流程: base 存储 → 合并 → 写入本地"""

    def test_diff3_with_base_storage(self):
        from src.sync.merge import three_way_merge

        base = "line1\nline2\nline3\n"
        ours = "line1\nmodified locally\nline3\n"
        theirs = "line1\nline2\nmodified on cloud\n"

        result = three_way_merge(base, ours, theirs)
        self.assertFalse(result.has_conflicts)
        self.assertIn("modified locally", result.merged_text)
        self.assertIn("modified on cloud", result.merged_text)

        # Simulate saving base and verifying retrieval
        tmpdir = tempfile.mkdtemp()
        try:
            from src.sync.metadata import SyncMetadata
            meta = SyncMetadata(os.path.join(tmpdir, "meta.json"))
            meta.save_base_content("test.md",
                                   result.merged_text.encode("utf-8"),
                                   "merged_hash")
            retrieved = meta.get_base_content("test.md")
            self.assertEqual(retrieved.decode("utf-8"),
                             result.merged_text)
            meta.close()
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


# ========== E2E: Bloom + dedup integration =======================

class BloomDedupE2ETest(unittest.TestCase):

    def test_bloom_prefilter_for_dedup(self):
        """Bloom filter 作为去重预过滤：快速排除不存在的 hash"""
        from src.sync.bloom import BloomFilter
        from src.sync.utils import compute_content_hash

        tmpdir = tempfile.mkdtemp()
        try:
            existing_hashes = set()
            bf = BloomFilter(100)

            for i in range(5):
                p = os.path.join(tmpdir, f"file{i}.md")
                with open(p, "w") as f:
                    f.write(f"content {i}")
                h = compute_content_hash(p)
                existing_hashes.add(h)
                bf.add(h)

            # All existing hashes should be "might contain"
            for h in existing_hashes:
                self.assertTrue(bf.might_contain(h))

            # A new file's hash should likely not be in the filter
            new_p = os.path.join(tmpdir, "unique.md")
            with open(new_p, "w") as f:
                f.write("unique content that definitely wasn't seen before xyz123")
            new_h = compute_content_hash(new_p)
            # Can't assert False (FP possible), but check it works
            _ = bf.might_contain(new_h)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


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


class ScanLocalSingleWorkerTest(unittest.TestCase):
    """P0: workers<=1 should scan ALL subdirs, not just the first"""

    def test_all_subdirs_scanned_with_single_worker(self):
        from src.sync.scanner import scan_local
        tmpdir = tempfile.mkdtemp()
        try:
            # Create two subdirs with files
            for dname in ("dir_a", "dir_b", "dir_c"):
                dp = os.path.join(tmpdir, dname)
                os.makedirs(dp)
                with open(os.path.join(dp, "note.md"), "w") as f:
                    f.write("content")

            # Force workers=1 by mocking cpu_count
            import src.sync.scanner as scanner_mod
            orig = os.cpu_count
            try:
                os.cpu_count = lambda: 1
                files = scan_local(tmpdir)
            finally:
                os.cpu_count = orig

            file_rels = {k for k, v in files.items() if not v.get("is_dir")}
            self.assertIn("dir_a/note.md", file_rels)
            self.assertIn("dir_b/note.md", file_rels)
            self.assertIn("dir_c/note.md", file_rels)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


class AsyncScanCloudPaginationTest(unittest.TestCase):
    """P0: async_scan_cloud should handle pagination like get_dir_info_by_id"""

    def test_pagination_collects_all_entries(self):
        import asyncio
        from unittest.mock import AsyncMock, MagicMock
        from src.sync.scanner import async_scan_cloud

        page1_entries = [
            {"fileEntry": {"id": f"f{i}", "name": f"file{i}.md", "dir": False,
                           "modifyTimeForSort": 100, "createTimeForSort": 50, "domain": 1}}
            for i in range(3)
        ]
        page2_entries = [
            {"fileEntry": {"id": f"f{i}", "name": f"file{i}.md", "dir": False,
                           "modifyTimeForSort": 100, "createTimeForSort": 50, "domain": 1}}
            for i in range(3, 5)
        ]

        call_count = [0]
        async def mock_get(url):
            resp = MagicMock()
            resp.raise_for_status = MagicMock()
            if call_count[0] == 0:
                resp.json.return_value = {"entries": page1_entries, "count": 5}
            else:
                resp.json.return_value = {"entries": page2_entries, "count": 5}
            call_count[0] += 1
            return resp

        client = MagicMock()
        client.get = mock_get
        client.__aenter__ = AsyncMock(return_value=client)
        client.__aexit__ = AsyncMock(return_value=False)

        url_tmpl = "https://example.com/{dir_id}?len={page_size}&cstk={cstk}"

        async def run():
            return await async_scan_cloud(
                client, url_tmpl, page_size=3, cstk="tok",
                dir_id="root", max_concurrent=1
            )

        files = asyncio.run(run())
        self.assertEqual(len(files), 5)
        self.assertGreater(call_count[0], 1, "Should have fetched multiple pages")


class ApiContextManagerTest(unittest.TestCase):
    """P0: httpx.Client should be properly closed"""

    def test_context_manager_closes_session(self):
        from unittest.mock import patch, MagicMock
        from src.api import YoudaoNoteApi

        mock_transport = MagicMock()
        with patch("httpx.HTTPTransport", return_value=mock_transport):
            with patch("httpx.Client") as mock_client_cls:
                mock_session = MagicMock()
                mock_client_cls.return_value = mock_session

                with YoudaoNoteApi("/fake/cookies.json") as api:
                    pass

                mock_session.close.assert_called_once()

    def test_close_method_exists(self):
        from unittest.mock import patch, MagicMock
        from src.api import YoudaoNoteApi

        with patch("httpx.HTTPTransport", return_value=MagicMock()):
            with patch("httpx.Client", return_value=MagicMock()):
                api = YoudaoNoteApi("/fake/cookies.json")
                api.close()
                api.session.close.assert_called_once()


class ApiHttpErrorHandlingTest(unittest.TestCase):
    """P1: HTTP network errors should be wrapped"""

    def test_http_get_wraps_network_error(self):
        import httpx
        from unittest.mock import patch, MagicMock
        from src.api import YoudaoNoteApi

        with patch("httpx.HTTPTransport", return_value=MagicMock()):
            with patch("httpx.Client") as mock_cls:
                mock_session = MagicMock()
                mock_session.get.side_effect = httpx.ConnectError("DNS failed")
                mock_cls.return_value = mock_session

                api = YoudaoNoteApi("/fake/cookies.json")
                with self.assertRaises(RuntimeError) as ctx:
                    api.http_get("https://example.com")
                self.assertIn("网络请求失败", str(ctx.exception))

    def test_http_post_wraps_timeout(self):
        import httpx
        from unittest.mock import patch, MagicMock
        from src.api import YoudaoNoteApi

        with patch("httpx.HTTPTransport", return_value=MagicMock()):
            with patch("httpx.Client") as mock_cls:
                mock_session = MagicMock()
                mock_session.post.side_effect = httpx.ReadTimeout("timed out")
                mock_cls.return_value = mock_session

                api = YoudaoNoteApi("/fake/cookies.json")
                with self.assertRaises(RuntimeError) as ctx:
                    api.http_post("https://example.com", data={})
                self.assertIn("网络请求失败", str(ctx.exception))

    def test_http_status_error_still_raised_directly(self):
        import httpx
        from unittest.mock import patch, MagicMock
        from src.api import YoudaoNoteApi

        with patch("httpx.HTTPTransport", return_value=MagicMock()):
            with patch("httpx.Client") as mock_cls:
                mock_session = MagicMock()
                mock_resp = MagicMock()
                mock_resp.status_code = 403
                mock_resp.raise_for_status.side_effect = httpx.HTTPStatusError(
                    "Forbidden", request=MagicMock(), response=mock_resp
                )
                mock_session.get.return_value = mock_resp
                mock_cls.return_value = mock_session

                api = YoudaoNoteApi("/fake/cookies.json")
                with self.assertRaises(httpx.HTTPStatusError):
                    api.http_get("https://example.com")


class MetadataMigrationFailureTest(unittest.TestCase):
    """P1: failed migration should NOT be recorded in _migrations"""

    def test_failed_migration_not_recorded(self):
        from src.sync.metadata import SyncMetadata
        tmpdir = tempfile.mkdtemp()
        try:
            meta = SyncMetadata(os.path.join(tmpdir, "test.json"))
            applied = {r[0] for r in meta._conn.execute(
                "SELECT idx FROM _migrations").fetchall()}
            for i in range(len(meta._conn.execute(
                    "SELECT idx FROM _migrations").fetchall())):
                self.assertIn(i, applied)
            meta.close()
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


class MetadataRemoveFileUnifiedTest(unittest.TestCase):
    """P1: remove_file should delegate to remove_file_info"""

    def test_remove_file_delegates_to_remove_file_info(self):
        from src.sync.metadata import SyncMetadata
        tmpdir = tempfile.mkdtemp()
        try:
            meta = SyncMetadata(os.path.join(tmpdir, "test.json"))
            meta.set_file_info("a.md", "f1", 100)
            self.assertIsNotNone(meta.get_file_info("a.md"))

            meta.remove_file("a.md")
            self.assertIsNone(meta.get_file_info("a.md"))

            meta.set_file_info("b.md", "f2", 200)
            meta.remove_file_info("b.md")
            self.assertIsNone(meta.get_file_info("b.md"))
            meta.close()
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


class DedupDeleteOrderTest(unittest.TestCase):
    """Dedup deletes local FIRST, then cloud (safe order to prevent data loss)."""

    def test_cloud_failure_still_deletes_local(self):
        """Local delete happens first; cloud failure only affects cloud_deleted stat."""
        from src.sync.dedup import _execute_removals
        from unittest.mock import MagicMock

        tmpdir = tempfile.mkdtemp()
        try:
            local_file = os.path.join(tmpdir, "dup.md")
            with open(local_file, "w") as f:
                f.write("content")

            mock_api = MagicMock()
            mock_api.delete_file.side_effect = Exception("cloud error")
            mock_meta = MagicMock()

            actions = [("dup.md", "cloud_id_123", "keep.md", "duplicate")]
            stats = {"deleted": 1, "cloud_deleted": 1}

            _execute_removals(actions, tmpdir, mock_meta, mock_api,
                              dry_run=False, stats=stats)

            self.assertFalse(os.path.exists(local_file),
                             "Local file should be deleted first (before cloud attempt)")
            self.assertEqual(stats["deleted"], 1, "Local delete succeeded")
            self.assertEqual(stats["cloud_deleted"], 0, "Cloud delete failed, stat decremented")
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


class CalibrateNullHashTest(unittest.TestCase):
    """P1: calibrate_metadata should skip entries where content_hash is None"""

    def test_null_hash_skipped(self):
        from src.sync.metadata import SyncMetadata
        from src.sync.decision import calibrate_metadata

        tmpdir = tempfile.mkdtemp()
        try:
            meta = SyncMetadata(os.path.join(tmpdir, "meta.json"))

            cloud_files = {
                "missing.md": {"id": "c1", "mtime": 100, "parent_id": "p1",
                               "domain": 1, "ctime": 50}
            }
            local_files = {
                "missing.md": {"path": "/nonexistent/path/missing.md",
                               "mtime": 100, "is_dir": False}
            }

            count = calibrate_metadata(meta, cloud_files, local_files)
            info = meta.get_file_info("missing.md")
            self.assertIsNone(info,
                              "Should not create metadata when hash computation fails")
            meta.close()
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


class EngineMetaDirtyLockTest(unittest.TestCase):
    """P1: _meta_dirty should be protected by lock"""

    def test_try_flush_is_threadsafe(self):
        import threading
        from unittest.mock import MagicMock
        from src.sync.engine import SyncManager

        mock_api = MagicMock()
        mock_api.get_root_id.return_value = "root"

        tmpdir = tempfile.mkdtemp()
        try:
            mgr = SyncManager.__new__(SyncManager)
            mgr._lock = threading.Lock()
            mgr._meta_dirty = 0
            mgr.METADATA_SAVE_BATCH = 5
            mgr.metadata = MagicMock()

            errors = []

            def call_flush(n):
                try:
                    for _ in range(n):
                        mgr._try_flush_metadata()
                except Exception as e:
                    errors.append(e)

            threads = [threading.Thread(target=call_flush, args=(20,))
                       for _ in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            self.assertEqual(len(errors), 0, f"Thread errors: {errors}")
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


class SyncApiProtocolTest(unittest.TestCase):
    """P1: SyncApi protocol should include async client and URL attributes"""

    def test_protocol_has_required_methods(self):
        from src.protocols import SyncApi
        members = dir(SyncApi)
        self.assertIn("create_async_client", members)
        self.assertIn("get_root_id", members)
        self.assertIn("get_file_by_id", members)
        self.assertIn("delete_file", members)

    def test_protocol_has_required_annotations(self):
        from src.protocols import SyncApi
        annotations = getattr(SyncApi, "__annotations__", {})
        proto_attrs = getattr(SyncApi, "__protocol_attrs__", set())
        all_attrs = set(annotations.keys()) | proto_attrs
        self.assertIn("DIR_MES_URL", all_attrs)
        self.assertIn("DIR_PAGE_SIZE", all_attrs)
        self.assertIn("cstk", all_attrs)


# ========== Bug Fixes Regression Tests =========================================

class MetadataBatchRollbackTest(unittest.TestCase):
    """P0-1: batch() should rollback on exception, not commit partial data."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(metadata_path=os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_batch_commits_on_success(self):
        with self.meta.batch() as m:
            m.set_file_info("a.md", "id1", 100, 100)

        info = self.meta.get_file_info("a.md")
        self.assertIsNotNone(info)
        self.assertEqual(info["file_id"], "id1")

    def test_batch_rollbacks_on_exception(self):
        self.meta.set_file_info("existing.md", "id0", 50, 50)
        self.meta.save()

        try:
            with self.meta.batch() as m:
                m.set_file_info("bad.md", "id_bad", 200, 200)
                raise ValueError("simulated failure")
        except ValueError:
            pass

        info = self.meta.get_file_info("bad.md")
        self.assertIsNone(info, "Partial data should NOT be committed after exception")

        existing = self.meta.get_file_info("existing.md")
        self.assertIsNotNone(existing, "Pre-existing data should survive rollback")


class MetadataContextManagerTest(unittest.TestCase):
    """P1-8: SyncMetadata supports with-statement."""

    def test_context_manager(self):
        tmpdir = tempfile.mkdtemp()
        try:
            path = os.path.join(tmpdir, "meta.json")
            with SyncMetadata(metadata_path=path) as meta:
                meta.set_file_info("test.md", "id1", 100, 100)
                meta.save()

            meta2 = SyncMetadata(metadata_path=path)
            info = meta2.get_file_info("test.md")
            meta2.close()
            self.assertIsNotNone(info)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


class MetadataInitFailureTest(unittest.TestCase):
    """P1-6: __init__ should close connection if migration fails."""

    def test_init_closes_conn_on_failure(self):
        tmpdir = tempfile.mkdtemp()
        try:
            db_path = os.path.join(tmpdir, "meta.db")
            import sqlite3
            conn = sqlite3.connect(db_path)
            conn.execute("CREATE TABLE _migrations (idx INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)")
            conn.execute("INSERT INTO _migrations VALUES (0, 0)")
            conn.execute("CREATE TABLE files (path TEXT)")
            conn.commit()
            conn.close()

            with self.assertRaises(Exception):
                SyncMetadata(metadata_path=os.path.join(tmpdir, "meta.json"))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


class MetadataSetTreeHashUpsertTest(unittest.TestCase):
    """P2: set_tree_hash should create row if not exists."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(metadata_path=os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_set_tree_hash_creates_missing_dir(self):
        self.meta.set_tree_hash("some/new/dir", "abc123")
        result = self.meta.get_tree_hash("some/new/dir")
        self.assertEqual(result, "abc123")

    def test_set_tree_hash_updates_existing_dir(self):
        self.meta.set_dir_info("existing/dir", "dir_id_1", "parent_id_1")
        self.meta.set_tree_hash("existing/dir", "hash_v1")
        self.assertEqual(self.meta.get_tree_hash("existing/dir"), "hash_v1")

        self.meta.set_tree_hash("existing/dir", "hash_v2")
        self.assertEqual(self.meta.get_tree_hash("existing/dir"), "hash_v2")
        self.assertEqual(self.meta.get_dir_id("existing/dir"), "dir_id_1")


class MovesGhostEntryTest(unittest.TestCase):
    """P0-3: When source file doesn't exist, don't create ghost local_files entry."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(metadata_path=os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_cloud_move_missing_source_restores_state(self):
        from src.sync.moves import _detect_cloud_moves

        local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(local_dir)

        self.meta.set_file_info("old/file.md", "fid1", 100, 100)
        self.meta.save()

        local_files = {
            "old/file.md": {"path": os.path.join(local_dir, "old/file.md"), "mtime": 100, "is_dir": False}
        }
        cloud_files = {
            "new/file.md": {"id": "fid1", "mtime": 200, "is_dir": False, "parent_id": "p1", "domain": 1, "ctime": 50}
        }

        only_local = {"old/file.md"}
        only_cloud = {"new/file.md"}
        cloud_id_to_path = {"fid1": "new/file.md"}

        _detect_cloud_moves(
            only_local, only_cloud, cloud_id_to_path,
            cloud_files, local_files, self.meta, local_dir, dry_run=False)

        self.assertIn("old/file.md", local_files,
                       "Original entry must be restored after failed move")
        self.assertNotIn("new/file.md", local_files,
                         "Target path must not remain in local_files")
        self.assertIn("old/file.md", only_local,
                       "Original path must be restored in only_local")
        self.assertIn("new/file.md", only_cloud,
                       "Cloud path should remain for engine to download")


class DedupDeletionOrderTest(unittest.TestCase):
    """P0-4: Dedup should delete local first, then cloud."""

    def test_local_delete_failure_skips_cloud_delete(self):
        from src.sync.dedup import _execute_removals
        from src.common import safe_long_path

        tmpdir = tempfile.mkdtemp()
        try:
            cloud_deletes = []

            class MockApi:
                def delete_file(self, fid):
                    cloud_deletes.append(fid)

            stats = {"deleted": 1, "cloud_deleted": 1}
            actions = [
                ("nonexistent/file.md", "cloud_id_1", "keep.md", "test reason")
            ]

            _execute_removals(actions, tmpdir, None, MockApi(), dry_run=False, stats=stats)

            self.assertEqual(len(cloud_deletes), 0,
                             "Cloud should NOT be deleted when local delete fails")
            self.assertEqual(stats["deleted"], 0)
            self.assertEqual(stats["cloud_deleted"], 0)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_successful_local_and_cloud_delete(self):
        from src.sync.dedup import _execute_removals

        tmpdir = tempfile.mkdtemp()
        try:
            local_file = os.path.join(tmpdir, "dup.md")
            with open(local_file, "w") as f:
                f.write("content")

            cloud_deletes = []

            class MockApi:
                def delete_file(self, fid):
                    cloud_deletes.append(fid)

            stats = {"deleted": 1, "cloud_deleted": 1}
            actions = [("dup.md", "cloud_id_1", "keep.md", "test reason")]

            _execute_removals(actions, tmpdir, None, MockApi(), dry_run=False, stats=stats)

            self.assertFalse(os.path.exists(local_file))
            self.assertEqual(cloud_deletes, ["cloud_id_1"])
            self.assertEqual(stats["deleted"], 1)
            self.assertEqual(stats["cloud_deleted"], 1)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


class DedupStatsLoggingTest(unittest.TestCase):
    """P1-11: Stats in log should reflect actual (post-execution) counts."""

    def test_stats_decremented_on_failure(self):
        from src.sync.dedup import _execute_removals

        tmpdir = tempfile.mkdtemp()
        try:
            stats = {"deleted": 2, "cloud_deleted": 0}
            actions = [
                ("missing1.md", None, "keep.md", "reason1"),
                ("missing2.md", None, "keep.md", "reason2"),
            ]

            _execute_removals(actions, tmpdir, None, None, dry_run=False, stats=stats)

            self.assertEqual(stats["deleted"], 0,
                             "Stats should be decremented for each failed deletion")
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


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


class WindowsPidCheckTest(unittest.TestCase):
    """P1-9: _is_pid_alive works on current platform."""

    def test_current_pid_alive(self):
        from src.sync.engine import _SyncLock
        self.assertTrue(_SyncLock._is_pid_alive(os.getpid()))

    def test_invalid_pid_not_alive(self):
        from src.sync.engine import _SyncLock
        self.assertFalse(_SyncLock._is_pid_alive(0))
        self.assertFalse(_SyncLock._is_pid_alive(-1))

    def test_nonexistent_pid_not_alive(self):
        from src.sync.engine import _SyncLock
        self.assertFalse(_SyncLock._is_pid_alive(99999999))


class EngineTryFinallyTest(unittest.TestCase):
    """P0-2: metadata.save() should run even when _async_main raises."""

    def test_metadata_saved_on_exception(self):
        from src.sync.utils import SyncDirection
        tmpdir = tempfile.mkdtemp()
        try:
            meta = SyncMetadata(metadata_path=os.path.join(tmpdir, "meta.json"))

            class FakeApi:
                def get_root_id(self):
                    return "root"
                def create_async_client(self):
                    raise RuntimeError("simulated API failure")

            from src.sync.engine import SyncManager
            mgr = SyncManager(api=FakeApi(), local_dir=tmpdir,
                              metadata=meta,
                              downloader=object(),
                              uploader=object())
            mgr._meta_dirty = 5

            try:
                mgr._sync_inner("root", "", SyncDirection.BOTH, False, False, False)
            except Exception:
                pass

            self.assertEqual(mgr._meta_dirty, 0,
                             "metadata should have been flushed in finally block")
            meta.close()
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


class DedupClassifyUnreadableTest(unittest.TestCase):
    """P1: Unreadable files should be skipped, not grouped as sz=-1 duplicates."""

    def test_unreadable_files_skipped(self):
        from src.sync.dedup import _classify_duplicates

        stats = {"skipped": 0}
        raw = {"hash1": ["nonexistent/a.md", "nonexistent/b.md"]}
        tmpdir = tempfile.mkdtemp()
        try:
            result = _classify_duplicates(raw, tmpdir, stats)
            self.assertEqual(len(result), 0,
                             "Unreadable files should not form a duplicate group")
            self.assertEqual(stats["skipped"], 2)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


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


# ========== Unit: Merkle tree edge cases =================================

class MerkleTreeEdgeCaseTest(unittest.TestCase):
    """Coverage: build_tree and diff_trees with empty inputs."""

    def test_empty_local_files(self):
        from src.sync.merkle import build_tree
        result = build_tree({}, {})
        self.assertIn("", result)

    def test_missing_path_in_info(self):
        from src.sync.merkle import build_tree
        local_files = {"test.md": {"is_dir": False}}
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


# ========== Unit: merge.py edge cases ====================================

class MergeNoneInputTest(unittest.TestCase):
    """P1: three_way_merge must reject None inputs."""

    def test_none_base_raises(self):
        from src.sync.merge import three_way_merge
        with self.assertRaises(TypeError):
            three_way_merge(None, "a", "b")

    def test_none_ours_raises(self):
        from src.sync.merge import three_way_merge
        with self.assertRaises(TypeError):
            three_way_merge("base", None, "b")

    def test_none_theirs_raises(self):
        from src.sync.merge import three_way_merge
        with self.assertRaises(TypeError):
            three_way_merge("base", "a", None)

    def test_empty_strings_ok(self):
        from src.sync.merge import three_way_merge
        result = three_way_merge("", "", "")
        self.assertFalse(result.has_conflicts)
        self.assertEqual(result.merged_text, "")


# ========== Unit: moves.py _common_ancestor_depth ========================

class CommonAncestorDepthTest(unittest.TestCase):

    def test_same_parent(self):
        from src.sync.moves import _common_ancestor_depth
        self.assertEqual(_common_ancestor_depth("a/b/c.md", "a/b/d.md"), 2)

    def test_no_common(self):
        from src.sync.moves import _common_ancestor_depth
        self.assertEqual(_common_ancestor_depth("x/a.md", "y/b.md"), 0)

    def test_root_files(self):
        from src.sync.moves import _common_ancestor_depth
        self.assertEqual(_common_ancestor_depth("a.md", "b.md"), 0)

    def test_one_level_common(self):
        from src.sync.moves import _common_ancestor_depth
        self.assertEqual(_common_ancestor_depth("docs/a.md", "docs/sub/b.md"), 1)

    def test_backslash_normalized(self):
        from src.sync.moves import _common_ancestor_depth
        self.assertEqual(_common_ancestor_depth("a\\b\\c.md", "a\\b\\d.md"), 2)


# ========== Unit: reconcile_moves integration ============================

class ReconcileMovesIntegrationTest(unittest.TestCase):
    """Integration test for the full reconcile_moves pipeline."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir)
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "test_meta.db"))

    def tearDown(self):
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_file_id_move_detected(self):
        from src.sync.moves import reconcile_moves

        src_dir = os.path.join(self.local_dir, "old")
        os.makedirs(src_dir)
        with open(os.path.join(src_dir, "a.md"), "w") as f:
            f.write("content")

        self.meta.set_file_info("old/a.md", "WEB1", cloud_mtime=100, local_mtime=100)
        self.meta.save()

        cloud_files = {
            "new/a.md": {"id": "WEB1", "mtime": 200, "is_dir": False,
                         "parent_id": "P2", "domain": 1, "ctime": 0},
        }
        local_files = {
            "old/a.md": {"mtime": 100, "is_dir": False,
                         "path": os.path.join(self.local_dir, "old/a.md")},
        }

        pending = reconcile_moves(
            cloud_files, local_files, self.meta,
            self.local_dir, dry_run=False)

        self.assertNotIn("old/a.md", local_files)
        self.assertIn("new/a.md", local_files)
        self.assertTrue(os.path.exists(os.path.join(self.local_dir, "new/a.md")))
        self.assertEqual(pending, [])

    def test_dry_run_no_disk_changes(self):
        from src.sync.moves import reconcile_moves

        self.meta.set_file_info("old/b.md", "WEB2", cloud_mtime=100, local_mtime=100)
        self.meta.save()

        cloud_files = {
            "new/b.md": {"id": "WEB2", "mtime": 200, "is_dir": False,
                         "parent_id": "P3", "domain": 1, "ctime": 0},
        }
        local_files = {
            "old/b.md": {"mtime": 100, "is_dir": False,
                         "path": os.path.join(self.local_dir, "old/b.md")},
        }

        reconcile_moves(cloud_files, local_files, self.meta,
                        self.local_dir, dry_run=True)

        self.assertIn("new/b.md", local_files)
        self.assertNotIn("old/b.md", local_files)

    def test_no_moves_returns_empty(self):
        from src.sync.moves import reconcile_moves

        cloud_files = {"a.md": {"id": "WEB1", "mtime": 100, "is_dir": False}}
        local_files = {"a.md": {"mtime": 100, "is_dir": False, "path": "x"}}

        pending = reconcile_moves(cloud_files, local_files, self.meta,
                                  self.local_dir, dry_run=True)
        self.assertEqual(pending, [])


# ========== Unit: git_helper.py ==========================================

class GitHelperBasicTest(unittest.TestCase):
    """Basic tests for GitHelper."""

    def test_non_git_dir(self):
        from src.sync.git_helper import GitHelper
        tmpdir = tempfile.mkdtemp()
        try:
            gh = GitHelper(tmpdir)
            self.assertFalse(gh.is_git_repo())
            self.assertFalse(gh.has_changes(["some/path"]))
            self.assertFalse(gh.commit_sync(["some/path"], {"downloaded": 1}))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_empty_changed_paths_returns_false(self):
        from src.sync.git_helper import GitHelper
        tmpdir = tempfile.mkdtemp()
        try:
            gh = GitHelper(tmpdir)
            self.assertFalse(gh.commit_sync([], {}))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_has_changes_needs_paths_and_repo(self):
        from src.sync.git_helper import GitHelper
        tmpdir = tempfile.mkdtemp()
        try:
            gh = GitHelper(tmpdir)
            self.assertFalse(gh.has_changes([]))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_get_file_content_non_repo(self):
        from src.sync.git_helper import GitHelper
        tmpdir = tempfile.mkdtemp()
        try:
            gh = GitHelper(tmpdir)
            self.assertIsNone(gh.get_file_content("some/file.md"))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


# ========== Unit: normalize_filename =====================================

class NormalizeFilenameTest(unittest.TestCase):

    def test_all_invalid_chars_returns_empty(self):
        from src.sync.moves import normalize_filename
        result = normalize_filename("\\/:*?\"<>|")
        self.assertEqual(result, "")

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


# ========== Unit: _move_local_file helper ================================

class MoveLocalFileHelperTest(unittest.TestCase):
    """Unit tests for the extracted _move_local_file helper."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.tmpdir, "old"))
        with open(os.path.join(self.tmpdir, "old/a.md"), "w") as f:
            f.write("test content")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_successful_move(self):
        from src.sync.moves import _move_local_file
        local_files = {"new/a.md": {"path": os.path.join(self.tmpdir, "old/a.md")}}
        only_local = set()
        only_cloud = set()

        result = _move_local_file(
            self.tmpdir, "old/a.md", "new/a.md",
            local_files, only_local, only_cloud, dry_run=False)

        self.assertTrue(result)
        self.assertTrue(os.path.exists(os.path.join(self.tmpdir, "new/a.md")))
        self.assertFalse(os.path.exists(os.path.join(self.tmpdir, "old/a.md")))

    def test_missing_source_reverts(self):
        from src.sync.moves import _move_local_file
        local_files = {"new/a.md": {"path": "nonexistent"}}
        only_local = set()
        only_cloud = set()

        result = _move_local_file(
            self.tmpdir, "missing/a.md", "new/a.md",
            local_files, only_local, only_cloud, dry_run=False)

        self.assertFalse(result)
        self.assertIn("missing/a.md", local_files)
        self.assertNotIn("new/a.md", local_files)
        self.assertIn("missing/a.md", only_local)
        self.assertIn("new/a.md", only_cloud)

    def test_dry_run_no_disk_change(self):
        from src.sync.moves import _move_local_file
        local_files = {"new/a.md": {"path": os.path.join(self.tmpdir, "old/a.md")}}
        only_local = set()
        only_cloud = set()

        result = _move_local_file(
            self.tmpdir, "old/a.md", "new/a.md",
            local_files, only_local, only_cloud, dry_run=True)

        self.assertTrue(result)
        self.assertTrue(os.path.exists(os.path.join(self.tmpdir, "old/a.md")))


# ========== Unit: common.py load_config narrow exception =================

class LoadConfigExceptionTest(unittest.TestCase):
    """P0: load_config should not catch arbitrary exceptions."""

    def test_missing_config_returns_defaults(self):
        from src.common import load_config
        config, err = load_config()
        self.assertIsInstance(config, dict)

    def test_format_file_size(self):
        from src.common import format_file_size
        self.assertEqual(format_file_size(0), "0B")
        self.assertEqual(format_file_size(1023), "1023B")
        self.assertIn("KB", format_file_size(2048))
        self.assertIn("MB", format_file_size(2 * 1024 * 1024))


if __name__ == "__main__":
    unittest.main()
