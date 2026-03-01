# -*- coding:utf-8 -*-
"""
双向同步相关模块的单元测试

覆盖：
- SyncMetadata: 元数据增删改查 + 反向索引
- markdown_to_note_json: Markdown → 有道 JSON 转换
- decide_action: 同步决策逻辑
- _cloud_score: 去重评分逻辑
- P0 纯函数: map_cloud_name, normalize_filename, filter_by_direction, format_file_size, _optimize_file_name
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from src.sync.metadata import SyncMetadata
from src.convert.md_to_note import markdown_to_note_json
from src.sync.utils import decide_action, SyncAction, filter_by_direction, SyncDirection, SyncItem, VerifyIssueType
from src.sync.dedup import _cloud_score
from src.sync.scanner import map_cloud_name
from src.sync.moves import normalize_filename
from src.common import format_file_size


# ========== SyncMetadata 测试 ==========

class SyncMetadataTest(unittest.TestCase):
    """
    元数据管理测试
    python -m pytest test/test_sync.py::SyncMetadataTest -v
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.metadata_path = os.path.join(self.tmpdir, "sync_metadata.json")
        self.meta = SyncMetadata(metadata_path=self.metadata_path)

    def tearDown(self):
        import shutil
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_save_and_load(self):
        """保存后重新打开，数据一致"""
        # Given
        self.meta.set_file_info("a/b.md", "WEB123", cloud_mtime=1000, local_mtime=1000)

        # When
        self.meta.save()
        reloaded = SyncMetadata(metadata_path=self.metadata_path)

        # Then
        self.assertEqual(reloaded.get_file_id("a/b.md"), "WEB123")
        reloaded.close()

    def test_set_and_get_file_info(self):
        """设置文件信息后能正确读取"""
        # When
        self.meta.set_file_info(
            "notes/test.md", "WEBabc123", cloud_mtime=2000,
            local_mtime=2000, parent_id="PARENT1", domain=1,
        )

        # Then
        info = self.meta.get_file_info("notes/test.md")
        self.assertIsNotNone(info)
        self.assertEqual(info["file_id"], "WEBabc123")
        self.assertEqual(info["cloud_mtime"], 2000)
        self.assertEqual(info["local_mtime"], 2000)
        self.assertEqual(info["parent_id"], "PARENT1")
        self.assertEqual(info["domain"], 1)

    def test_get_file_id_not_found(self):
        """查询不存在的路径返回 None"""
        self.assertIsNone(self.meta.get_file_id("no/such/file.md"))

    def test_remove_file(self):
        """删除后再查询返回 None"""
        # Given
        self.meta.set_file_info("x.md", "WEB1", cloud_mtime=1)

        # When
        self.meta.remove_file("x.md")

        # Then
        self.assertIsNone(self.meta.get_file_id("x.md"))

    def test_record_sync_sets_all_fields(self):
        """record_sync atomically writes all metadata fields"""
        # When
        self.meta.record_sync(
            "x.md",
            file_id="WEB1",
            cloud_mtime=200,
            local_mtime=100,
            parent_id="DIR1",
            domain=1,
            content_hash="hash_abc",
            cloud_content_hash="hash_abc",
            action="uploaded",
            direction="push",
        )

        # Then
        info = self.meta.get_file_info("x.md")
        self.assertIsNotNone(info)
        self.assertEqual(info["file_id"], "WEB1")
        self.assertEqual(info["cloud_mtime"], 200)
        self.assertEqual(info["local_mtime"], 100)
        self.assertEqual(info.get("parent_id"), "DIR1")
        self.assertEqual(info.get("domain"), 1)
        self.assertEqual(info.get("content_hash"), "hash_abc")
        self.assertEqual(info.get("cloud_content_hash"), "hash_abc")
        self.assertGreater(info.get("last_sync_at", 0), 0)

    def test_find_by_file_id(self):
        """根据云端 ID 反查本地路径"""
        # Given
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1)
        self.meta.set_file_info("b.md", "WEBB", cloud_mtime=2)

        # Then
        self.assertEqual(self.meta.find_by_file_id("WEBA"), "a.md")
        self.assertEqual(self.meta.find_by_file_id("WEBB"), "b.md")
        self.assertIsNone(self.meta.find_by_file_id("WEBC"))

    def test_directory_operations(self):
        """目录的增删查"""
        # Given / When
        self.meta.set_dir_info("docs", "DIR1", parent_id="ROOT")

        # Then
        self.assertEqual(self.meta.get_dir_id("docs"), "DIR1")
        self.assertEqual(self.meta.find_by_dir_id("DIR1"), "docs")

        # When
        self.meta.remove_dir("docs")

        # Then
        self.assertIsNone(self.meta.get_dir_id("docs"))

    def test_get_all_files(self):
        """获取所有文件记录"""
        # Given
        self.meta.set_file_info("a.md", "A", cloud_mtime=1)
        self.meta.set_file_info("b.md", "B", cloud_mtime=2)

        # When
        all_files = self.meta.get_all_files()

        # Then
        self.assertEqual(len(all_files), 2)
        self.assertIn("a.md", all_files)
        self.assertIn("b.md", all_files)

    def test_path_normalization(self):
        """反斜杠路径被统一为正斜杠"""
        # When
        self.meta.set_file_info("a\\b\\c.md", "WEB1", cloud_mtime=1)

        # Then
        self.assertIsNotNone(self.meta.get_file_info("a/b/c.md"))

    def test_load_corrupt_json_migration_safe(self):
        """损坏的旧 JSON 文件不会导致迁移崩溃"""
        # Given — 写入一个损坏的 JSON 文件
        with open(self.metadata_path, "w") as f:
            f.write("this is not json")

        # When — 创建新实例（会尝试迁移 JSON）
        meta2 = SyncMetadata(metadata_path=self.metadata_path)

        # Then — 不崩溃，数据库为空
        self.assertEqual(meta2.get_all_files(), {})
        meta2.close()

    # ---------- 反向索引 (find_cloud_file_by_hash) ----------

    def test_find_cloud_file_by_hash_hit(self):
        """通过 content_hash 查找云端文件——命中"""
        # Given
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1, content_hash="abc123")

        # When
        result = self.meta.find_cloud_file_by_hash("abc123")

        # Then
        self.assertEqual(result, "a.md")

    def test_find_cloud_file_by_hash_miss(self):
        """通过 content_hash 查找——未命中"""
        # Given
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1, content_hash="abc123")

        # When / Then
        self.assertIsNone(self.meta.find_cloud_file_by_hash("zzz999"))

    def test_find_cloud_file_by_hash_exclude_self(self):
        """排除自身后，如果没有其他匹配则返回 None"""
        # Given
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1, content_hash="abc123")

        # When
        result = self.meta.find_cloud_file_by_hash("abc123", exclude_path="a.md")

        # Then
        self.assertIsNone(result)

    def test_find_cloud_file_by_hash_exclude_self_with_other(self):
        """排除自身后，返回另一个匹配"""
        # Given
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1, content_hash="abc123")
        self.meta.set_file_info("b.md", "WEBB", cloud_mtime=2, content_hash="abc123")

        # When
        result = self.meta.find_cloud_file_by_hash("abc123", exclude_path="a.md")

        # Then
        self.assertEqual(result, "b.md")

    def test_find_cloud_file_by_hash_ignores_no_file_id(self):
        """没有 file_id 的文件不会被查询命中"""
        # Given — file_id 为空字符串
        self.meta.set_file_info("local.md", "", cloud_mtime=1, local_mtime=1, content_hash="abc123")

        # When / Then
        self.assertIsNone(self.meta.find_cloud_file_by_hash("abc123"))

    def test_hash_index_survives_save_reload(self):
        """保存后重新打开，hash 查询仍正常"""
        # Given
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1, content_hash="hash1")
        self.meta.save()

        # When
        reloaded = SyncMetadata(metadata_path=self.metadata_path)

        # Then
        self.assertEqual(reloaded.find_cloud_file_by_hash("hash1"), "a.md")
        reloaded.close()

    def test_hash_index_updated_on_remove(self):
        """删除文件后反向索引同步清理"""
        # Given
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1, content_hash="hash1")

        # When
        self.meta.remove_file("a.md")

        # Then
        self.assertIsNone(self.meta.find_cloud_file_by_hash("hash1"))

    def test_hash_index_reindex_on_remove(self):
        """删除文件后，同 hash 的其他文件仍可通过 hash 查找"""
        # Given — 两个文件共享同一个 content_hash
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1, content_hash="shared")
        self.meta.set_file_info("b.md", "WEBB", cloud_mtime=2, content_hash="shared")

        # When — 删除其中一个
        self.meta.remove_file("a.md")

        # Then — 另一个仍可查到
        result = self.meta.find_cloud_file_by_hash("shared")
        self.assertEqual(result, "b.md")

    def test_hash_index_updated_on_update_content_hash(self):
        """update_content_hash 后反向索引更新"""
        # Given
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1, content_hash="old")

        # When
        self.meta.update_content_hash("a.md", "new")

        # Then
        self.assertIsNone(self.meta.find_cloud_file_by_hash("old"))
        self.assertEqual(self.meta.find_cloud_file_by_hash("new"), "a.md")


    # ---- cache_cloud_file_info 测试 ----

    def test_cache_cloud_creates_new_record(self):
        """cache_cloud_file_info 新记录：写入 file_id/cloud_mtime，local_mtime=0"""
        self.meta.cache_cloud_file_info("cloud.md", "WEB1", cloud_mtime=5000,
                                        parent_id="P1", domain=1)

        info = self.meta.get_file_info("cloud.md")
        self.assertIsNotNone(info)
        self.assertEqual(info["file_id"], "WEB1")
        self.assertEqual(info["cloud_mtime"], 5000)
        self.assertEqual(info["local_mtime"], 0)

    def test_cache_cloud_preserves_existing_mtime(self):
        """cache_cloud_file_info 已有记录：只更新 file_id，保留 cloud_mtime 和 local_mtime"""
        # Given: 已同步的文件（有 cloud_mtime 和 local_mtime）
        self.meta.set_file_info("synced.md", "OLD_ID", cloud_mtime=1000,
                                local_mtime=2000)

        # When: 扫描缓存更新 file_id
        self.meta.cache_cloud_file_info("synced.md", "NEW_ID", cloud_mtime=9999)

        # Then: file_id 更新，但 mtime 保留原值
        info = self.meta.get_file_info("synced.md")
        self.assertEqual(info["file_id"], "NEW_ID")
        self.assertEqual(info["cloud_mtime"], 1000)
        self.assertEqual(info["local_mtime"], 2000)

    def test_cache_cloud_empty_path_raises(self):
        """cache_cloud_file_info 空路径抛 ValueError"""
        with self.assertRaises(ValueError):
            self.meta.cache_cloud_file_info("", "WEB1", cloud_mtime=100)


# ========== markdown_to_note_json 测试 ==========

class MarkdownToNoteJsonTest(unittest.TestCase):
    """
    Markdown 转有道 JSON 格式测试
    python -m pytest test/test_sync.py::MarkdownToNoteJsonTest -v
    """

    def test_empty_input(self):
        """空字符串返回合法 JSON"""
        result = markdown_to_note_json("")
        parsed = json.loads(result)
        self.assertIn("5", parsed)

    def test_heading(self):
        """标题被转换为 h 类型节点"""
        result = markdown_to_note_json("# 一级标题")
        parsed = json.loads(result)
        contents = parsed["5"]

        # 找到 type=h 的节点
        h_nodes = [c for c in contents if c.get("6") == "h"]
        self.assertTrue(len(h_nodes) >= 1)

        # level 应为 h1
        self.assertEqual(h_nodes[0]["4"]["l"], "h1")

    def test_heading_levels(self):
        """各级标题映射正确"""
        data = [
            ("# H1", "h1"),
            ("## H2", "h2"),
            ("### H3", "h3"),
        ]
        for md_line, expected_level in data:
            result = json.loads(markdown_to_note_json(md_line))
            h_nodes = [c for c in result["5"] if c.get("6") == "h"]
            self.assertTrue(
                len(h_nodes) >= 1,
                f"'{md_line}' 没有产生 h 节点",
            )
            self.assertEqual(
                h_nodes[0]["4"]["l"], expected_level,
                f"'{md_line}' 的 level 应为 {expected_level}",
            )

    def test_unordered_list(self):
        """无序列表被转换为 l 类型节点"""
        result = json.loads(markdown_to_note_json("- 列表项"))
        l_nodes = [c for c in result["5"] if c.get("6") == "l"]
        self.assertTrue(len(l_nodes) >= 1)
        self.assertEqual(l_nodes[0]["4"]["lt"], "unordered")

    def test_ordered_list(self):
        """有序列表被转换为 l 类型节点"""
        result = json.loads(markdown_to_note_json("1. 列表项"))
        l_nodes = [c for c in result["5"] if c.get("6") == "l"]
        self.assertTrue(len(l_nodes) >= 1)
        self.assertEqual(l_nodes[0]["4"]["lt"], "ordered")

    def test_code_block(self):
        """代码块被转换为 cd 类型节点"""
        md = "```python\nprint('hello')\n```"
        result = json.loads(markdown_to_note_json(md))
        cd_nodes = [c for c in result["5"] if c.get("6") == "cd"]
        self.assertTrue(len(cd_nodes) >= 1)
        self.assertEqual(cd_nodes[0]["4"]["la"], "python")

    def test_quote(self):
        """引用被转换为 q 类型节点"""
        result = json.loads(markdown_to_note_json("> 引用文字"))
        q_nodes = [c for c in result["5"] if c.get("6") == "q"]
        self.assertTrue(len(q_nodes) >= 1)

    def test_image(self):
        """图片被转换为 im 类型节点"""
        result = json.loads(markdown_to_note_json("![alt](http://img.png)"))
        im_nodes = [c for c in result["5"] if c.get("6") == "im"]
        self.assertTrue(len(im_nodes) >= 1)
        self.assertEqual(im_nodes[0]["4"]["u"], "http://img.png")

    def test_paragraph(self):
        """普通段落不带 type"""
        result = json.loads(markdown_to_note_json("这是一段普通文字"))
        plain = [c for c in result["5"] if "6" not in c]
        self.assertTrue(len(plain) >= 1)

    def test_mixed_content(self):
        """混合内容产生正确数量的节点"""
        md = "# 标题\n\n段落\n\n- 列表\n\n> 引用"
        result = json.loads(markdown_to_note_json(md))
        # 至少包含标题、段落（含空行段落）、列表、引用
        self.assertTrue(len(result["5"]) >= 4)

    def test_result_is_valid_json(self):
        """任何输入都返回合法 JSON"""
        test_inputs = ["", "hello", "# h1\n## h2", "```\ncode\n```"]
        for md in test_inputs:
            result = markdown_to_note_json(md)
            try:
                json.loads(result)
            except json.JSONDecodeError:
                self.fail(f"输入 {repr(md)} 产生了非法 JSON")


# ========== decide_action 测试 ==========

class DecideActionTest(unittest.TestCase):
    """
    同步决策逻辑测试
    python -m pytest test/test_sync.py::DecideActionTest -v
    """

    def test_neither_exists(self):
        """两边都不存在 → 跳过"""
        result = decide_action(
            local_exists=False, cloud_exists=False,
            local_mtime=None, cloud_mtime=None,
            meta_local_mtime=None, meta_cloud_mtime=None,
        )
        self.assertEqual(result, SyncAction.SKIP)

    def test_only_local(self):
        """只有本地 → 上传"""
        result = decide_action(
            local_exists=True, cloud_exists=False,
            local_mtime=1000, cloud_mtime=None,
            meta_local_mtime=None, meta_cloud_mtime=None,
        )
        self.assertEqual(result, SyncAction.UPLOAD)

    def test_only_cloud(self):
        """只有云端 → 下载"""
        result = decide_action(
            local_exists=False, cloud_exists=True,
            local_mtime=None, cloud_mtime=1000,
            meta_local_mtime=None, meta_cloud_mtime=None,
        )
        self.assertEqual(result, SyncAction.DOWNLOAD)

    def test_both_unchanged(self):
        """两边都没有变化 → 跳过"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=100, cloud_mtime=100,
            meta_local_mtime=100, meta_cloud_mtime=100,
        )
        self.assertEqual(result, SyncAction.SKIP)

    def test_only_local_changed(self):
        """只有本地修改 → 上传"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=200, cloud_mtime=100,
            meta_local_mtime=100, meta_cloud_mtime=100,
        )
        self.assertEqual(result, SyncAction.UPLOAD)

    def test_only_cloud_changed(self):
        """只有云端修改 → 下载"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=100, cloud_mtime=200,
            meta_local_mtime=100, meta_cloud_mtime=100,
        )
        self.assertEqual(result, SyncAction.DOWNLOAD)

    def test_both_changed_local_newer(self):
        """两边都改了，本地更新 → 上传"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=300, cloud_mtime=200,
            meta_local_mtime=100, meta_cloud_mtime=100,
        )
        self.assertEqual(result, SyncAction.UPLOAD)

    def test_both_changed_cloud_newer(self):
        """两边都改了，云端更新 → 下载"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=200, cloud_mtime=300,
            meta_local_mtime=100, meta_cloud_mtime=100,
        )
        self.assertEqual(result, SyncAction.DOWNLOAD)

    def test_both_changed_same_time(self):
        """两边都改了，时间相同 → 冲突"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=200, cloud_mtime=200,
            meta_local_mtime=100, meta_cloud_mtime=100,
        )
        self.assertEqual(result, SyncAction.CONFLICT)

    def test_no_metadata_both_exist(self):
        """没有元数据记录，两边都有 → 根据时间决定"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=500, cloud_mtime=300,
            meta_local_mtime=None, meta_cloud_mtime=None,
        )
        self.assertEqual(result, SyncAction.UPLOAD)


# ========== _cloud_score 评分测试 ==========

class CloudScoreTest(unittest.TestCase):
    """
    去重评分逻辑测试
    python -m pytest test/test_sync.py::CloudScoreTest -v
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.metadata_path = os.path.join(self.tmpdir, "sync_metadata.json")
        self.meta = SyncMetadata(metadata_path=self.metadata_path)

    def tearDown(self):
        import shutil
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_deeper_path_scores_higher(self):
        """路径越深分数越高"""
        # Given
        shallow = "a.md"
        deep = "dir1/dir2/a.md"

        # When
        score_shallow = _cloud_score(shallow, None, self.tmpdir)
        score_deep = _cloud_score(deep, None, self.tmpdir)

        # Then
        self.assertGreater(score_deep, score_shallow)

    def test_shorter_name_scores_higher(self):
        """同一目录下，文件名越短分数越高"""
        # Given — 两个文件在同一级目录
        clean = "dir/test.md"
        messy = "dir/test(1)(14-42-31).md"

        # When
        score_clean = _cloud_score(clean, None, self.tmpdir)
        score_messy = _cloud_score(messy, None, self.tmpdir)

        # Then — 深度相同，clean name 分数更高
        self.assertGreater(score_clean, score_messy)

    def test_earlier_create_time_scores_higher(self):
        """创建时间越早分数越高"""
        # Given
        self.meta.set_file_info("old.md", "WEB1", cloud_mtime=2000, create_time=1000)
        self.meta.set_file_info("new.md", "WEB2", cloud_mtime=2000, create_time=5000)

        # When
        score_old = _cloud_score("old.md", self.meta, self.tmpdir)
        score_new = _cloud_score("new.md", self.meta, self.tmpdir)

        # Then — 同深度同名长度，早创建的分数更高
        self.assertGreater(score_old, score_new)

    def test_score_without_metadata(self):
        """没有元数据时也不崩溃"""
        # When / Then — 不抛异常
        score = _cloud_score("any/path.md", None, self.tmpdir)
        self.assertIsInstance(score, tuple)
        self.assertEqual(len(score), 3)



# ========== 去重碰撞防护测试 ==========

class DedupCollisionTest(unittest.TestCase):
    """
    MD5 碰撞防护测试：同 hash 不同大小的文件不应被去重
    python -m pytest test/test_sync.py::DedupCollisionTest -v
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir)

    def test_same_hash_different_size_not_deduped(self):
        """同 hash 但不同大小的文件不当作重复"""
        from src.sync.dedup import auto_dedup

        meta = SyncMetadata(metadata_path=os.path.join(self.tmpdir, "meta.json"))
        try:
            f1 = os.path.join(self.tmpdir, "file1.md")
            f2 = os.path.join(self.tmpdir, "file2.md")
            with open(f1, "w") as f:
                f.write("short")
            with open(f2, "w") as f:
                f.write("this is a much longer content")

            meta.set_file_info("file1.md", "WEB1", cloud_mtime=1, content_hash="collision_hash")
            meta.set_file_info("file2.md", "WEB2", cloud_mtime=2, content_hash="collision_hash")
            meta.save()

            # When
            stats = auto_dedup(self.tmpdir, metadata=meta, dry_run=True)

            # Then
            self.assertEqual(stats["deleted"], 0)
        finally:
            meta.close()

    def test_same_hash_same_size_deduped(self):
        """同 hash 同大小的文件正常去重"""
        from src.sync.dedup import auto_dedup

        meta = SyncMetadata(metadata_path=os.path.join(self.tmpdir, "meta.json"))
        try:
            f1 = os.path.join(self.tmpdir, "file1.md")
            f2 = os.path.join(self.tmpdir, "file2.md")
            content = "identical content"
            with open(f1, "w") as f:
                f.write(content)
            with open(f2, "w") as f:
                f.write(content)

            real_hash = SyncMetadata.compute_content_hash(f1)
            meta.set_file_info("file1.md", "WEB1", cloud_mtime=1, content_hash=real_hash)
            meta.set_file_info("file2.md", "WEB2", cloud_mtime=2, content_hash=real_hash)
            meta.save()

            # When
            stats = auto_dedup(self.tmpdir, metadata=meta, dry_run=True)

            # Then
            self.assertEqual(stats["deleted"], 1)
            self.assertEqual(stats["kept"], 1)
        finally:
            meta.close()


# ========== covert.py 防御性处理测试 ==========

class JsonConvertDefensiveTest(unittest.TestCase):
    """
    JSON 转 Markdown 的防御性处理测试
    python -m pytest test/test_sync.py::JsonConvertDefensiveTest -v
    """

    def test_missing_key_5_returns_empty(self):
        """JSON 缺少 '5' 内容字段时返回空字符串"""
        from src.convert import YoudaoNoteConvert

        # Given — 写一个缺少 key "5" 的 JSON 文件
        tmpdir = tempfile.mkdtemp()
        f = os.path.join(tmpdir, "bad.note")
        with open(f, "w", encoding="utf-8") as fh:
            json.dump({"3": "id-only"}, fh)

        # When / Then — 不崩溃
        try:
            YoudaoNoteConvert.convert_json_to_markdown(f)
        except KeyError:
            self.fail("缺少 '5' 字段时不应抛出 KeyError")
        finally:
            import shutil
            shutil.rmtree(tmpdir)

    def test_invalid_json_returns_empty(self):
        """文件不是合法 JSON 时不崩溃"""
        from src.convert import YoudaoNoteConvert

        tmpdir = tempfile.mkdtemp()
        f = os.path.join(tmpdir, "invalid.note")
        with open(f, "w", encoding="utf-8") as fh:
            fh.write("this is not json {{{")

        try:
            YoudaoNoteConvert.convert_json_to_markdown(f)
        except (KeyError, json.JSONDecodeError):
            self.fail("非法 JSON 时不应崩溃")
        finally:
            import shutil
            shutil.rmtree(tmpdir)

    def test_heading_missing_key_4(self):
        """标题节点缺少 '4' 字段时不崩溃"""
        from src.convert import JsonConvert

        # Given — 一个缺少 "4" 的标题内容
        content = {"5": [{"7": [{"8": "test text"}]}], "6": "h"}

        # When / Then — 不抛异常
        converter = JsonConvert()
        try:
            result = converter.convert_h_func(content)
        except (AttributeError, KeyError, TypeError):
            self.fail("标题缺少 '4' 字段时不应崩溃")

    def test_image_missing_key_4(self):
        """图片节点缺少 '4' 字段时不崩溃"""
        from src.convert import JsonConvert

        content = {"6": "im"}
        converter = JsonConvert()
        try:
            result = converter.convert_im_func(content)
            self.assertIn("![](", result)
        except (AttributeError, KeyError, TypeError):
            self.fail("图片缺少 '4' 字段时不应崩溃")


# ========== safe_long_path 测试 ==========

class SafeLongPathTest(unittest.TestCase):
    """
    Windows 长路径处理测试
    python -m pytest test/test_sync.py::SafeLongPathTest -v
    """

    def test_short_path_unchanged(self):
        """短路径原样返回"""
        from src.common import safe_long_path
        path = "C:\\Users\\test\\notes\\file.md"
        result = safe_long_path(path)
        # 短路径不应被修改（除非恰好在 Windows 且超长）
        if len(path) < 240:
            self.assertFalse(result.startswith("\\\\?\\"))

    def test_already_prefixed_unchanged(self):
        """已有 \\\\?\\ 前缀的路径不会重复添加"""
        from src.common import safe_long_path
        path = "\\\\?\\" + "C:\\" + "a" * 300 + ".md"
        result = safe_long_path(path)
        # 不应出现双重前缀
        self.assertFalse(result.startswith("\\\\?\\\\\\?\\"))

    def test_empty_path(self):
        """空路径不崩溃"""
        from src.common import safe_long_path
        result = safe_long_path("")
        self.assertEqual(result, "" if len("") < 240 else result)


# ========== api._safe_json 测试 ==========

class SafeJsonTest(unittest.TestCase):
    """
    API JSON 安全解析测试
    python -m pytest test/test_sync.py::SafeJsonTest -v
    """

    def test_valid_json(self):
        """正常 JSON 响应解析成功"""
        from src.api import YoudaoNoteApi

        class FakeResp:
            status_code = 200
            text = '{"key": "value"}'
            def json(self):
                return {"key": "value"}

        result = YoudaoNoteApi._safe_json(FakeResp())
        self.assertEqual(result, {"key": "value"})

    def test_invalid_json_raises_runtime_error(self):
        """非 JSON 响应抛出 RuntimeError 并包含有用信息"""
        from src.api import YoudaoNoteApi

        class FakeResp:
            status_code = 502
            text = "<html>Bad Gateway</html>"
            def json(self):
                raise ValueError("No JSON")

        with self.assertRaises(RuntimeError) as ctx:
            YoudaoNoteApi._safe_json(FakeResp())

        self.assertIn("502", str(ctx.exception))
        self.assertIn("Bad Gateway", str(ctx.exception))

    def test_empty_response_raises_runtime_error(self):
        """空响应抛出 RuntimeError"""
        from src.api import YoudaoNoteApi

        class FakeResp:
            status_code = 200
            text = ""
            def json(self):
                raise ValueError("Empty")

        with self.assertRaises(RuntimeError):
            YoudaoNoteApi._safe_json(FakeResp())


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


# ========== _detect_content_type 测试 ==========

class DetectContentTypeTest(unittest.TestCase):
    """
    测试下载引擎的内容类型检测
    python -m pytest test/test_sync.py::DetectContentTypeTest -v
    """

    def test_xml_content(self):
        """XML 内容应检测为 XML"""
        from src.transfer.download import YoudaoNoteDownload, FileType

        result = YoudaoNoteDownload._detect_content_type(b"<?xml version='1.0'?>")
        self.assertEqual(result, FileType.XML)

    def test_json_content(self):
        """JSON 内容应检测为 JSON"""
        from src.transfer.download import YoudaoNoteDownload, FileType

        result = YoudaoNoteDownload._detect_content_type(b'{"key": "value"}')
        self.assertEqual(result, FileType.JSON)

    def test_other_content(self):
        """普通二进制内容应检测为 OTHER"""
        from src.transfer.download import YoudaoNoteDownload, FileType

        result = YoudaoNoteDownload._detect_content_type(b"hello world")
        self.assertEqual(result, FileType.OTHER)

    def test_empty_content(self):
        """空内容应检测为 OTHER"""
        from src.transfer.download import YoudaoNoteDownload, FileType

        result = YoudaoNoteDownload._detect_content_type(b"")
        self.assertEqual(result, FileType.OTHER)


# ========== _UPLOAD_HANDLERS dispatch 测试 ==========

class UploadHandlerDispatchTest(unittest.TestCase):
    """
    测试上传处理器分发逻辑
    python -m pytest test/test_sync.py::UploadHandlerDispatchTest -v
    """

    def test_md_dispatches_to_upload_markdown(self):
        """".md" 文件应映射到 _upload_markdown"""
        from src.transfer.upload import YoudaoNoteUpload

        handler_name = YoudaoNoteUpload._UPLOAD_HANDLERS.get(".md")
        self.assertEqual(handler_name, "_upload_markdown")

    def test_note_dispatches_to_skip(self):
        """".note" 文件应映射到 _upload_note_skip"""
        from src.transfer.upload import YoudaoNoteUpload

        handler_name = YoudaoNoteUpload._UPLOAD_HANDLERS.get(".note")
        self.assertEqual(handler_name, "_upload_note_skip")

    def test_unknown_suffix_falls_back_to_auto(self):
        """未知后缀应 fallback 到 _upload_auto"""
        from src.transfer.upload import YoudaoNoteUpload

        handler_name = YoudaoNoteUpload._UPLOAD_HANDLERS.get(".xyz", "_upload_auto")
        self.assertEqual(handler_name, "_upload_auto")

    def test_upload_auto_text_file_goes_markdown(self):
        """_upload_auto 对 UTF-8 文本文件应走 _upload_markdown 路径"""
        from unittest.mock import MagicMock, patch
        from src.transfer.upload import YoudaoNoteUpload

        tmpdir = tempfile.mkdtemp()
        try:
            txt_path = os.path.join(tmpdir, "readme.txt")
            with open(txt_path, "w", encoding="utf-8") as f:
                f.write("hello world")

            uploader = YoudaoNoteUpload(MagicMock(), SyncMetadata(
                metadata_path=os.path.join(tmpdir, "meta.json")))
            with patch.object(uploader, "_upload_markdown",
                              return_value=(True, None)) as mock_md:
                ok, err = uploader._upload_auto(txt_path, "pid", "readme.txt")
                mock_md.assert_called_once()
                self.assertTrue(ok)
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_upload_auto_binary_file_goes_binary(self):
        """_upload_auto 对二进制文件：先走 markdown 失败（[BINARY]），再回退到 binary"""
        from unittest.mock import MagicMock, patch
        from src.transfer.upload import YoudaoNoteUpload

        tmpdir = tempfile.mkdtemp()
        try:
            bin_path = os.path.join(tmpdir, "chart.pdf")
            with open(bin_path, "wb") as f:
                f.write(b"\x00\x01\x02\xff\xfe\xfd" * 100)

            uploader = YoudaoNoteUpload(MagicMock(), SyncMetadata(
                metadata_path=os.path.join(tmpdir, "meta.json")))
            with patch.object(uploader, "_upload_binary",
                              return_value=(True, None)) as mock_bin:
                ok, err = uploader._upload_auto(bin_path, "pid", "chart.pdf")
                mock_bin.assert_called_once_with(bin_path, "pid", "chart.pdf", False)
                self.assertTrue(ok)
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_upload_binary_calls_push_binary_file(self):
        """_upload_binary returns UploadResult and calls api.push_binary_file"""
        from unittest.mock import MagicMock
        from src.transfer.upload import YoudaoNoteUpload
        from src.sync.utils import UploadResult

        tmpdir = tempfile.mkdtemp()
        try:
            pdf_path = os.path.join(tmpdir, "doc.pdf")
            pdf_content = b"%PDF-1.4 fake content"
            with open(pdf_path, "wb") as f:
                f.write(pdf_content)

            mock_api = MagicMock()
            mock_api.push_binary_file.return_value = {
                "entry": {"modifyTimeForSort": 1000}
            }
            meta = SyncMetadata(metadata_path=os.path.join(tmpdir, "meta.json"))
            uploader = YoudaoNoteUpload(mock_api, meta)

            ok, result = uploader._upload_binary(pdf_path, "parent1", "doc.pdf", force=True)

            self.assertTrue(ok)
            self.assertIsInstance(result, UploadResult)
            self.assertEqual(result.cloud_mtime, 1000)
            self.assertEqual(result.parent_id, "parent1")
            mock_api.push_binary_file.assert_called_once()
            call_kwargs = mock_api.push_binary_file.call_args
            self.assertEqual(call_kwargs.kwargs["name"], "doc.pdf")
            self.assertEqual(call_kwargs.kwargs["file_bytes"], pdf_content)
            self.assertTrue(call_kwargs.kwargs["is_create"])
        finally:
            meta.close()
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)


# ========== score_func 自定义评分测试 ==========

class CustomScoreFuncTest(unittest.TestCase):
    """
    测试 auto_dedup / _resolve_cloud_group 的 score_func 参数
    python -m pytest test/test_sync.py::CustomScoreFuncTest -v
    """

    def test_custom_score_func_used(self):
        """自定义 score_func 应被 _resolve_cloud_group 使用"""
        from src.sync.dedup import _resolve_cloud_group

        # Given
        tmpdir = tempfile.mkdtemp()
        meta = SyncMetadata(metadata_path=os.path.join(tmpdir, "meta.json"))
        try:
            meta.set_file_info("a/x.md", "WEB1", cloud_mtime=1000, local_mtime=1000)
            meta.set_file_info("b/x.md", "WEB2", cloud_mtime=1000, local_mtime=1000)

            def custom_score(path, metadata, root):
                return 100 if path.startswith("b/") else 0

            # When
            keep, remove = _resolve_cloud_group(
                ["a/x.md", "b/x.md"], meta, set(), tmpdir,
                {"skipped": 0}, score_func=custom_score,
            )

            # Then
            self.assertEqual(keep, ["b/x.md"])
            self.assertEqual(remove, ["a/x.md"])
        finally:
            meta.close()
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)


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


class FilterByDirectionTest(unittest.TestCase):
    """filter_by_direction() 按方向过滤"""

    def test_pull_only_download_and_conflict(self):
        """PULL direction → only DOWNLOAD and CONFLICT, SKIP counted separately"""
        # Given
        items = [
            SyncItem("a.md", None, "id1", None, None, 100, False, SyncAction.DOWNLOAD),
            SyncItem("b.md", None, "id2", None, None, 100, False, SyncAction.UPLOAD),
            SyncItem("c.md", None, "id3", None, None, 100, False, SyncAction.SKIP),
            SyncItem("d.md", None, "id4", None, None, 100, False, SyncAction.CONFLICT),
        ]
        # When
        result, skip_count = filter_by_direction(items, SyncDirection.PULL)
        # Then
        self.assertEqual(len(result), 2)
        actions = {i.action for i in result}
        self.assertEqual(actions, {SyncAction.DOWNLOAD, SyncAction.CONFLICT})
        self.assertEqual(skip_count, 2)

    def test_push_only_upload(self):
        """PUSH direction → only UPLOAD, rest are skipped"""
        # Given
        items = [
            SyncItem("a.md", None, "id1", None, None, 100, False, SyncAction.DOWNLOAD),
            SyncItem("b.md", None, "id2", None, None, 100, False, SyncAction.UPLOAD),
            SyncItem("c.md", None, "id3", None, None, 100, False, SyncAction.SKIP),
            SyncItem("d.md", None, "id4", None, None, 100, False, SyncAction.CONFLICT),
        ]
        # When
        result, skip_count = filter_by_direction(items, SyncDirection.PUSH)
        # Then
        self.assertEqual(len(result), 1)
        actions = {i.action for i in result}
        self.assertEqual(actions, {SyncAction.UPLOAD})
        self.assertEqual(skip_count, 3)

    def test_both_returns_non_skip_items(self):
        """BOTH direction → all non-SKIP items, SKIP counted"""
        # Given
        items = [
            SyncItem("a.md", None, "id1", None, None, 100, False, SyncAction.DOWNLOAD),
            SyncItem("b.md", None, "id2", None, None, 100, False, SyncAction.UPLOAD),
            SyncItem("c.md", None, "id3", None, None, 100, False, SyncAction.SKIP),
            SyncItem("d.md", None, "id4", None, None, 100, False, SyncAction.CONFLICT),
        ]
        # When
        result, skip_count = filter_by_direction(items, SyncDirection.BOTH)
        # Then
        self.assertEqual(len(result), 3)
        self.assertEqual(skip_count, 1)


class FormatFileSizeTest(unittest.TestCase):
    """format_file_size() 文件大小格式化"""

    def test_zero_bytes(self):
        """0 → 0B"""
        # Given
        size = 0
        # When
        result = format_file_size(size)
        # Then
        self.assertEqual(result, "0B")

    def test_bytes(self):
        """512 → 512B"""
        # Given
        size = 512
        # When
        result = format_file_size(size)
        # Then
        self.assertEqual(result, "512B")

    def test_one_kb(self):
        """1024 → 1.0KB"""
        # Given
        size = 1024
        # When
        result = format_file_size(size)
        # Then
        self.assertEqual(result, "1.0KB")

    def test_one_point_five_kb(self):
        """1536 → 1.5KB"""
        # Given
        size = 1536
        # When
        result = format_file_size(size)
        # Then
        self.assertEqual(result, "1.5KB")

    def test_one_mb(self):
        """1048576 → 1.0MB"""
        # Given
        size = 1048576
        # When
        result = format_file_size(size)
        # Then
        self.assertEqual(result, "1.0MB")

    def test_ten_mb(self):
        """10485760 → 10.0MB"""
        # Given
        size = 10485760
        # When
        result = format_file_size(size)
        # Then
        self.assertEqual(result, "10.0MB")


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


# ========== 第三轮审查补全测试 ==========


class MetadataPartialUpdateTest(unittest.TestCase):
    """UPSERT 部分更新 + domain=0 + close 安全性测试"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(
            metadata_path=os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        import shutil
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_partial_update_preserves_existing_fields(self):
        """先设全字段，再只更新 file_id+cloud_mtime，原有字段应保留"""
        # Given
        self.meta.set_file_info(
            "a.md", "WEB1", cloud_mtime=1000, local_mtime=1000,
            parent_id="P1", domain=1, content_hash="abc123",
            create_time=500,
        )

        # When — 第二次调用只传必需参数
        self.meta.set_file_info("a.md", "WEB1", cloud_mtime=2000)

        # Then — 可选字段应保留原值
        info = self.meta.get_file_info("a.md")
        self.assertEqual(info["cloud_mtime"], 2000)
        self.assertEqual(info["content_hash"], "abc123")
        self.assertEqual(info["domain"], 1)
        self.assertEqual(info["parent_id"], "P1")
        self.assertEqual(info["create_time"], 500)

    def test_domain_zero_preserved(self):
        """domain=0（普通笔记）不应被过滤"""
        # When
        self.meta.set_file_info(
            "note.md", "WEB1", cloud_mtime=1000, domain=0)

        # Then
        info = self.meta.get_file_info("note.md")
        self.assertIn("domain", info)
        self.assertEqual(info["domain"], 0)

    def test_domain_zero_in_get_all_files(self):
        """get_all_files 也应包含 domain=0"""
        self.meta.set_file_info(
            "note.md", "WEB1", cloud_mtime=1000, domain=0)

        all_files = self.meta.get_all_files()
        self.assertIn("domain", all_files["note.md"])
        self.assertEqual(all_files["note.md"]["domain"], 0)

    def test_close_twice_no_crash(self):
        """close() 调用两次不应抛异常"""
        self.meta.close()
        self.meta.close()

    def test_find_cloud_file_by_hash_ignores_null_rows(self):
        """content_hash 为 NULL 的行不应被 find_cloud_file_by_hash 匹配"""
        # Given — 一行有 hash，一行无 hash（NULL）
        self.meta.set_file_info(
            "a.md", "WEB1", cloud_mtime=1000, content_hash="abc")
        self.meta.set_file_info(
            "b.md", "WEB2", cloud_mtime=1000)

        # When — 搜索 "abc"
        result = self.meta.find_cloud_file_by_hash("abc")
        self.assertEqual(result, "a.md")

        # When — 搜索 None
        result_none = self.meta.find_cloud_file_by_hash(None)
        self.assertIsNone(result_none)


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


class DecideActionEdgeCaseTest(unittest.TestCase):
    """decide_action 边界条件测试"""

    def test_both_changed_mtime_zero_local_newer(self):
        """两边都变了，cloud_mtime=0 时应根据数值比较（0 不是 None）"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=500, cloud_mtime=0,
            meta_local_mtime=None, meta_cloud_mtime=None,
        )
        self.assertEqual(result, SyncAction.UPLOAD)

    def test_both_changed_local_mtime_zero_cloud_newer(self):
        """local_mtime=0, cloud 有真实时间 → 下载"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=0, cloud_mtime=500,
            meta_local_mtime=None, meta_cloud_mtime=None,
        )
        self.assertEqual(result, SyncAction.DOWNLOAD)

    def test_both_mtime_zero_conflict(self):
        """两边 mtime 都是 0 → 冲突"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=0, cloud_mtime=0,
            meta_local_mtime=None, meta_cloud_mtime=None,
        )
        self.assertEqual(result, SyncAction.CONFLICT)


class FilterByDirectionEdgeTest(unittest.TestCase):
    """filter_by_direction 边界测试"""

    def test_empty_list(self):
        """空列表不崩溃"""
        result, skip_count = filter_by_direction([], SyncDirection.BOTH)
        self.assertEqual(result, [])
        self.assertEqual(skip_count, 0)

    def test_all_skip_items(self):
        """全是 SKIP 项"""
        items = [
            SyncItem("a.md", None, "id1", None, None, 100, False, SyncAction.SKIP),
            SyncItem("b.md", None, "id2", None, None, 100, False, SyncAction.SKIP),
        ]
        result, skip_count = filter_by_direction(items, SyncDirection.BOTH)
        self.assertEqual(result, [])
        self.assertEqual(skip_count, 2)


class DetectCloudMovesTest(unittest.TestCase):
    """_detect_cloud_moves 错误处理测试"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(
            metadata_path=os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        import shutil
        self.meta.close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_source_missing_skips_move_and_restores_state(self):
        """源文件不存在时：完整恢复原始状态（local_files + only_local + only_cloud）"""
        from src.sync.moves import _detect_cloud_moves

        self.meta.set_file_info(
            "old/a.md", "WEB1", cloud_mtime=1000, local_mtime=1000)

        only_local = {"old/a.md"}
        only_cloud = {"new/a.md"}
        cloud_files = {
            "new/a.md": {"id": "WEB1", "parent_id": "P2", "name": "a.md",
                         "is_dir": False, "mtime": 2000, "ctime": 0, "domain": 1},
        }
        local_files = {
            "old/a.md": {"path": os.path.join(self.tmpdir, "old", "a.md"),
                         "mtime": 1000, "is_dir": False},
        }
        cloud_id_to_path = {"WEB1": "new/a.md"}

        count = _detect_cloud_moves(
            only_local, only_cloud, cloud_id_to_path,
            cloud_files, local_files, self.meta,
            local_dir=self.tmpdir, dry_run=False,
        )

        self.assertEqual(count, 0)
        self.assertIn("old/a.md", local_files,
                       "Original entry must be restored in local_files")
        self.assertNotIn("new/a.md", local_files,
                         "Target path must not remain in local_files")
        self.assertIn("old/a.md", only_local,
                       "Original path must be restored in only_local")
        self.assertIn("new/a.md", only_cloud,
                       "Cloud path should remain so engine downloads it")

    def test_shutil_move_failure_restores_state(self):
        """shutil.move 失败时应恢复 dict 状态"""
        from unittest.mock import patch
        from src.sync.moves import _detect_cloud_moves

        # Given — 源文件存在，但目标目录无法创建
        src_dir = os.path.join(self.tmpdir, "old")
        os.makedirs(src_dir, exist_ok=True)
        src_file = os.path.join(src_dir, "a.md")
        with open(src_file, "w") as f:
            f.write("content")

        self.meta.set_file_info(
            "old/a.md", "WEB1", cloud_mtime=1000, local_mtime=1000)

        only_local = {"old/a.md"}
        only_cloud = {"new/a.md"}
        cloud_files = {
            "new/a.md": {"id": "WEB1", "parent_id": "P2", "name": "a.md",
                         "is_dir": False, "mtime": 2000, "ctime": 0, "domain": 1},
        }
        local_files = {
            "old/a.md": {"mtime": 1000, "is_dir": False, "path": src_file},
        }
        cloud_id_to_path = {"WEB1": "new/a.md"}

        # When — 模拟 shutil.move 抛 OSError
        with patch("src.sync.moves.shutil.move",
                    side_effect=OSError("Permission denied")):
            count = _detect_cloud_moves(
                only_local, only_cloud, cloud_id_to_path,
                cloud_files, local_files, self.meta,
                local_dir=self.tmpdir, dry_run=False,
            )

        # Then — 状态应恢复
        self.assertEqual(count, 0)
        self.assertIn("old/a.md", only_local)
        self.assertIn("new/a.md", only_cloud)
        self.assertIn("old/a.md", local_files)

    def test_dry_run_does_not_move_or_update_metadata(self):
        """dry_run 模式不应移动文件或更新 metadata"""
        from src.sync.moves import _detect_cloud_moves

        # Given
        src_dir = os.path.join(self.tmpdir, "old")
        os.makedirs(src_dir)
        src_file = os.path.join(src_dir, "a.md")
        with open(src_file, "w") as f:
            f.write("content")

        self.meta.set_file_info(
            "old/a.md", "WEB1", cloud_mtime=1000, local_mtime=1000)

        only_local = {"old/a.md"}
        only_cloud = {"new/a.md"}
        cloud_files = {
            "new/a.md": {"id": "WEB1", "parent_id": "P2", "name": "a.md",
                         "is_dir": False, "mtime": 2000, "ctime": 0, "domain": 1},
        }
        local_files = {
            "old/a.md": {"mtime": 1000, "is_dir": False, "path": src_file},
        }
        cloud_id_to_path = {"WEB1": "new/a.md"}

        # When
        count = _detect_cloud_moves(
            only_local, only_cloud, cloud_id_to_path,
            cloud_files, local_files, self.meta,
            local_dir=self.tmpdir, dry_run=True,
        )

        # Then — 文件未移动
        self.assertEqual(count, 1)
        self.assertTrue(os.path.exists(src_file))
        # metadata 中旧路径不应被删除
        self.assertIsNotNone(self.meta.get_file_info("old/a.md"))


# ========== Feature 1: WAL Checkpoint 测试 ==========

class WalCheckpointTest(unittest.TestCase):
    """metadata.save() 每 50 次触发 WAL checkpoint"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_save_count_increments(self):
        for i in range(10):
            self.meta.set_file_info(f"f{i}.md", "WEB1", cloud_mtime=1000)
            self.meta.save()
        self.assertEqual(self.meta._save_count, 10)

    def test_checkpoint_runs_without_error_at_50(self):
        """50 次 save 后 WAL checkpoint 不报错（间接验证：若 checkpoint 出错会被静默吞掉）"""
        for i in range(51):
            self.meta.set_file_info(f"f{i}.md", "WEB1", cloud_mtime=1000)
            self.meta.save()
        self.assertEqual(self.meta._save_count, 51)

    def test_maybe_wal_checkpoint_is_called(self):
        """直接调用 _maybe_wal_checkpoint 验证不抛异常"""
        self.meta._save_count = 49
        self.meta._maybe_wal_checkpoint()
        self.assertEqual(self.meta._save_count, 50)


# ========== Feature 2: PID Lock 测试 ==========

class SyncLockTest(unittest.TestCase):
    """_SyncLock PID 锁"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_acquire_and_release(self):
        from src.sync.engine import _SyncLock
        lock = _SyncLock(self.tmpdir)
        self.assertTrue(lock.acquire())
        self.assertTrue(os.path.exists(os.path.join(self.tmpdir, ".sync.lock")))
        lock.release()
        self.assertFalse(os.path.exists(os.path.join(self.tmpdir, ".sync.lock")))

    def test_double_acquire_same_pid_succeeds(self):
        """同一进程的 PID 存活检查 → 返回 False（已有实例）"""
        from src.sync.engine import _SyncLock
        lock1 = _SyncLock(self.tmpdir)
        lock2 = _SyncLock(self.tmpdir)
        self.assertTrue(lock1.acquire())
        self.assertFalse(lock2.acquire())
        lock1.release()

    def test_stale_lock_taken_over(self):
        """过期锁被接管"""
        from src.sync.engine import _SyncLock
        import json, time
        lock_path = os.path.join(self.tmpdir, ".sync.lock")
        with open(lock_path, "w") as f:
            json.dump({"pid": 99999999, "started": time.time() - 7200}, f)

        lock = _SyncLock(self.tmpdir)
        self.assertTrue(lock.acquire())
        lock.release()

    def test_dead_pid_lock_taken_over(self):
        """PID 不存在时锁被接管"""
        from src.sync.engine import _SyncLock
        import json, time
        lock_path = os.path.join(self.tmpdir, ".sync.lock")
        with open(lock_path, "w") as f:
            json.dump({"pid": 99999999, "started": time.time()}, f)

        lock = _SyncLock(self.tmpdir)
        self.assertTrue(lock.acquire())
        lock.release()


# ========== Feature 3: Delete Tracking 测试 ==========

class DeleteTrackingTest(unittest.TestCase):
    """delete tracking: previously_synced → SKIP"""

    def test_local_only_new_file_uploads(self):
        result = decide_action(
            local_exists=True, cloud_exists=False,
            local_mtime=1000, cloud_mtime=None,
            meta_local_mtime=None, meta_cloud_mtime=None,
            previously_synced=False)
        self.assertEqual(result, SyncAction.UPLOAD)

    def test_local_only_previously_synced_skips(self):
        """本地有 + 云端没 + 之前同步过 → 云端已删除 → SKIP"""
        result = decide_action(
            local_exists=True, cloud_exists=False,
            local_mtime=1000, cloud_mtime=None,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            previously_synced=True)
        self.assertEqual(result, SyncAction.SKIP)

    def test_cloud_only_new_file_downloads(self):
        result = decide_action(
            local_exists=False, cloud_exists=True,
            local_mtime=None, cloud_mtime=2000,
            meta_local_mtime=None, meta_cloud_mtime=None,
            previously_synced=False)
        self.assertEqual(result, SyncAction.DOWNLOAD)

    def test_cloud_only_previously_synced_skips(self):
        """本地没 + 云端有 + 之前同步过 + 云端未修改 → 本地已删除 → SKIP"""
        result = decide_action(
            local_exists=False, cloud_exists=True,
            local_mtime=None, cloud_mtime=2000,
            meta_local_mtime=1000, meta_cloud_mtime=2000,
            previously_synced=True)
        self.assertEqual(result, SyncAction.SKIP)

    def test_local_only_previously_synced_but_modified_uploads(self):
        """本地有 + 云端没 + 之前同步过 + 本地有修改 → 重新上传"""
        result = decide_action(
            local_exists=True, cloud_exists=False,
            local_mtime=2000, cloud_mtime=None,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            previously_synced=True)
        self.assertEqual(result, SyncAction.UPLOAD)

    def test_cloud_only_previously_synced_but_modified_downloads(self):
        """本地没 + 云端有 + 之前同步过 + 云端有修改 → 重新下载"""
        result = decide_action(
            local_exists=False, cloud_exists=True,
            local_mtime=None, cloud_mtime=3000,
            meta_local_mtime=1000, meta_cloud_mtime=2000,
            previously_synced=True)
        self.assertEqual(result, SyncAction.DOWNLOAD)

    def test_mark_synced_sets_timestamp(self):
        tmpdir = tempfile.mkdtemp()
        try:
            meta = SyncMetadata(os.path.join(tmpdir, "meta.json"))
            meta.set_file_info("a.md", "WEB1", cloud_mtime=100)
            meta.mark_synced("a.md", ts=12345)
            info = meta.get_file_info("a.md")
            self.assertEqual(info["last_sync_at"], 12345)
            meta.close()
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_last_sync_at_default_zero(self):
        tmpdir = tempfile.mkdtemp()
        try:
            meta = SyncMetadata(os.path.join(tmpdir, "meta.json"))
            meta.set_file_info("b.md", "WEB2", cloud_mtime=200)
            info = meta.get_file_info("b.md")
            self.assertNotIn("last_sync_at", info)
            meta.close()
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)


# ========== Feature 4: Retry + Backoff 测试 ==========

class RetryWithBackoffTest(unittest.TestCase):

    def test_succeeds_immediately(self):
        from src.sync.utils import retry_with_backoff
        result = retry_with_backoff(lambda: 42)
        self.assertEqual(result, 42)

    def test_retries_on_timeout(self):
        import httpx
        from src.sync.utils import retry_with_backoff
        attempts = []

        def flaky():
            attempts.append(1)
            if len(attempts) < 3:
                raise httpx.ConnectError("connection refused")
            return "ok"

        result = retry_with_backoff(flaky, max_retries=3, base_delay=0.01)
        self.assertEqual(result, "ok")
        self.assertEqual(len(attempts), 3)

    def test_raises_after_max_retries(self):
        import httpx
        from src.sync.utils import retry_with_backoff

        def always_fail():
            raise httpx.TimeoutException("timeout")

        with self.assertRaises(httpx.TimeoutException):
            retry_with_backoff(always_fail, max_retries=2, base_delay=0.01)

    def test_no_retry_on_4xx(self):
        import httpx
        from src.sync.utils import retry_with_backoff
        attempts = []

        def client_error():
            attempts.append(1)
            resp = httpx.Response(403, request=httpx.Request("GET", "http://x"))
            raise httpx.HTTPStatusError("forbidden", request=resp.request, response=resp)

        with self.assertRaises(httpx.HTTPStatusError):
            retry_with_backoff(client_error, max_retries=3, base_delay=0.01)
        self.assertEqual(len(attempts), 1)

    def test_retries_on_5xx(self):
        """5xx HTTPStatusError 应被重试"""
        import httpx
        from src.sync.utils import retry_with_backoff
        attempts = []

        def server_error():
            attempts.append(1)
            if len(attempts) < 3:
                resp = httpx.Response(502, request=httpx.Request("GET", "http://x"))
                raise httpx.HTTPStatusError("bad gateway", request=resp.request, response=resp)
            return "recovered"

        result = retry_with_backoff(server_error, max_retries=3, base_delay=0.01)
        self.assertEqual(result, "recovered")
        self.assertEqual(len(attempts), 3)

    def test_non_retryable_exception_propagates(self):
        from src.sync.utils import retry_with_backoff

        def raise_value_error():
            raise ValueError("bad input")

        with self.assertRaises(ValueError):
            retry_with_backoff(raise_value_error, max_retries=3, base_delay=0.01)


# ========== Feature 5: Content Hash in decide_action 测试 ==========

class ContentHashDecisionTest(unittest.TestCase):

    def test_mtime_changed_hash_same_skips(self):
        """mtime 变了但 hash 相同 → SKIP（文件被 touch 但内容没变）"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=2000, cloud_mtime=1000,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            local_hash="abc123", meta_hash="abc123")
        self.assertEqual(result, SyncAction.SKIP)

    def test_mtime_changed_hash_different_uploads(self):
        """mtime 变了且 hash 不同 → UPLOAD"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=2000, cloud_mtime=1000,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            local_hash="abc123", meta_hash="def456")
        self.assertEqual(result, SyncAction.UPLOAD)

    def test_no_hash_falls_back_to_mtime(self):
        """没有 hash 时按原 mtime 逻辑"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=2000, cloud_mtime=1000,
            meta_local_mtime=1000, meta_cloud_mtime=1000)
        self.assertEqual(result, SyncAction.UPLOAD)

    def test_both_changed_hash_same_still_checks_cloud(self):
        """双方 mtime 都变了但本地 hash 同 → 只有云端真正变了 → DOWNLOAD"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=2000, cloud_mtime=3000,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            local_hash="abc123", meta_hash="abc123")
        self.assertEqual(result, SyncAction.DOWNLOAD)


# ========== 云端 Hash 三方比较测试 ==========

class CloudHashDecisionTest(unittest.TestCase):
    """三方 hash（local / cloud / meta）参与决策"""

    def test_both_changed_converged_skips(self):
        """双方 mtime 都变了 + cloud_hash == local_hash → 内容一样 → SKIP"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=2000, cloud_mtime=3000,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            local_hash="same_hash", cloud_hash="same_hash", meta_hash="old_hash")
        self.assertEqual(result, SyncAction.SKIP)

    def test_cloud_hash_same_as_meta_means_cloud_not_changed(self):
        """双方 mtime 都变了 + cloud_hash == meta_hash → 云端没真正变 → UPLOAD"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=2000, cloud_mtime=3000,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            local_hash="new_local", cloud_hash="old_hash", meta_hash="old_hash")
        self.assertEqual(result, SyncAction.UPLOAD)

    def test_local_hash_same_as_meta_means_local_not_changed(self):
        """双方 mtime 都变了 + local_hash == meta_hash → 本地没真正变 → DOWNLOAD"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=2000, cloud_mtime=3000,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            local_hash="old_hash", cloud_hash="new_cloud", meta_hash="old_hash")
        self.assertEqual(result, SyncAction.DOWNLOAD)

    def test_all_different_remains_conflict(self):
        """三方 hash 全不同 → 真正冲突 → 按 mtime 决定"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=2000, cloud_mtime=3000,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            local_hash="hash_a", cloud_hash="hash_b", meta_hash="hash_c")
        self.assertEqual(result, SyncAction.DOWNLOAD)

    def test_all_different_local_newer_uploads(self):
        """三方 hash 全不同 + 本地更新 → UPLOAD"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=5000, cloud_mtime=3000,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            local_hash="hash_a", cloud_hash="hash_b", meta_hash="hash_c")
        self.assertEqual(result, SyncAction.UPLOAD)

    def test_all_three_same_skips(self):
        """三方 hash 全相同 → 完全没变 → SKIP"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=2000, cloud_mtime=2000,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            local_hash="same", cloud_hash="same", meta_hash="same")
        self.assertEqual(result, SyncAction.SKIP)

    def test_only_cloud_hash_no_local_hash_falls_back(self):
        """有 cloud_hash 但没 local_hash → cloud_hash 与 meta_hash 比较仍有效"""
        result = decide_action(
            local_exists=True, cloud_exists=True,
            local_mtime=2000, cloud_mtime=3000,
            meta_local_mtime=1000, meta_cloud_mtime=1000,
            cloud_hash="old_hash", meta_hash="old_hash")
        self.assertEqual(result, SyncAction.UPLOAD)


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


# ========== Feature: three_way_merge 测试 ==========

class ThreeWayMergeTest(unittest.TestCase):

    def test_no_conflict_both_sides_add(self):
        from src.sync.merge import three_way_merge
        base = "line1\nline2\nline3\n"
        ours = "line0\nline1\nline2\nline3\n"     # 头部加行
        theirs = "line1\nline2\nline3\nline4\n"    # 尾部加行
        result = three_way_merge(base, ours, theirs)
        self.assertFalse(result.has_conflicts)
        self.assertIn("line0", result.merged_text)
        self.assertIn("line4", result.merged_text)

    def test_no_conflict_one_side_edits(self):
        from src.sync.merge import three_way_merge
        base = "aaa\nbbb\nccc\n"
        ours = "aaa\nbbb\nccc\n"     # 没改
        theirs = "aaa\nBBB\nccc\n"   # 改了第二行
        result = three_way_merge(base, ours, theirs)
        self.assertFalse(result.has_conflicts)
        self.assertIn("BBB", result.merged_text)

    def test_conflict_both_edit_same_line(self):
        from src.sync.merge import three_way_merge
        base = "aaa\nbbb\nccc\n"
        ours = "aaa\nXXX\nccc\n"
        theirs = "aaa\nYYY\nccc\n"
        result = three_way_merge(base, ours, theirs)
        self.assertTrue(result.has_conflicts)
        self.assertEqual(result.conflict_count, 1)
        self.assertIn("<<<<<<< LOCAL", result.merged_text)
        self.assertIn(">>>>>>> CLOUD", result.merged_text)

    def test_empty_base(self):
        from src.sync.merge import three_way_merge
        result = three_way_merge("", "hello\n", "world\n")
        self.assertIsNotNone(result.merged_text)

    def test_both_same_change_no_conflict(self):
        """双方做了相同修改 → 无冲突"""
        from src.sync.merge import three_way_merge
        base = "aaa\nbbb\n"
        ours = "aaa\nXXX\n"
        theirs = "aaa\nXXX\n"
        result = three_way_merge(base, ours, theirs)
        self.assertFalse(result.has_conflicts)
        self.assertIn("XXX", result.merged_text)

    def test_no_changes(self):
        from src.sync.merge import three_way_merge
        base = "aaa\nbbb\n"
        result = three_way_merge(base, base, base)
        self.assertFalse(result.has_conflicts)
        self.assertEqual(result.merged_text, base)


# ========== Feature: GC 测试 ==========

class MetadataGCTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir)
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_gc_removes_orphan_files(self):
        """本地不存在 + last_sync_at 过期 → 被清理"""
        import time
        self.meta.set_file_info("gone.md", "WEB1", cloud_mtime=100)
        self.meta.mark_synced("gone.md", ts=int(time.time()) - 40 * 86400)
        self.meta.save()

        stats = self.meta.gc(self.local_dir)
        self.assertEqual(stats["files"], 1)
        self.assertIsNone(self.meta.get_file_info("gone.md"))

    def test_gc_keeps_existing_files(self):
        """本地存在的文件不被清理"""
        import time
        path = os.path.join(self.local_dir, "exist.md")
        with open(path, "w") as f:
            f.write("hi")
        self.meta.set_file_info("exist.md", "WEB2", cloud_mtime=100)
        self.meta.mark_synced("exist.md", ts=int(time.time()) - 40 * 86400)
        self.meta.save()

        stats = self.meta.gc(self.local_dir)
        self.assertEqual(stats["files"], 0)
        self.assertIsNotNone(self.meta.get_file_info("exist.md"))

    def test_gc_removes_orphan_dirs(self):
        self.meta.set_dir_info("old_dir", "DIR1", "ROOT")
        self.meta.save()
        stats = self.meta.gc(self.local_dir)
        self.assertEqual(stats["dirs"], 1)

    def test_gc_cleans_old_sync_log(self):
        """超过 max_log_age_days 的日志被清理"""
        import time
        old_ts = int(time.time()) - 100 * 86400
        self.meta.log_sync_action("a.md", "downloaded", timestamp_override=old_ts)
        self.meta.log_sync_action("b.md", "uploaded")
        self.meta.save()

        stats = self.meta.gc(self.local_dir, max_log_age_days=90)
        self.assertEqual(stats["logs"], 1)
        remaining = self.meta.get_sync_log()
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0]["path"], "b.md")

    def test_gc_removes_orphan_base(self):
        """file_base 中文件不存在 → 被清理"""
        self.meta.save_base_content("phantom.md", b"old", "hash1")
        self.meta.save()
        stats = self.meta.gc(self.local_dir)
        self.assertEqual(stats["bases"], 1)


# ========== Feature: verify 测试 ==========

class MetadataVerifyTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir)
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_verify_detects_orphan(self):
        self.meta.set_file_info("missing.md", "WEB1", cloud_mtime=100)
        self.meta.save()
        issues = self.meta.verify(self.local_dir)
        self.assertTrue(any(t == VerifyIssueType.ORPHAN for _, t, _ in issues))

    def test_verify_detects_hash_mismatch(self):
        from src.sync.utils import compute_content_hash
        path = os.path.join(self.local_dir, "changed.md")
        with open(path, "w") as f:
            f.write("original")
        real_hash = compute_content_hash(path)
        self.meta.set_file_info("changed.md", "WEB2", cloud_mtime=100,
                                content_hash="fake_hash_that_wont_match")
        self.meta.save()
        issues = self.meta.verify(self.local_dir)
        self.assertTrue(any(t == VerifyIssueType.HASH_MISMATCH for _, t, _ in issues))

    def test_verify_auto_fix(self):
        from src.sync.utils import compute_content_hash
        path = os.path.join(self.local_dir, "fix.md")
        with open(path, "w") as f:
            f.write("data")
        self.meta.set_file_info("fix.md", "WEB3", cloud_mtime=100,
                                content_hash="wrong")
        self.meta.save()
        issues = self.meta.verify(self.local_dir, auto_fix=True)
        self.assertTrue(len(issues) > 0)
        info = self.meta.get_file_info("fix.md")
        actual = compute_content_hash(path)
        self.assertEqual(info["content_hash"], actual)

    def test_verify_clean_passes(self):
        path = os.path.join(self.local_dir, "ok.md")
        with open(path, "w") as f:
            f.write("fine")
        from src.sync.utils import compute_content_hash
        h = compute_content_hash(path)
        self.meta.set_file_info("ok.md", "WEB4", cloud_mtime=100,
                                content_hash=h)
        self.meta.save()
        issues = self.meta.verify(self.local_dir)
        self.assertEqual(len(issues), 0)


# ========== record_sync 测试 ==========

class RecordSyncTest(unittest.TestCase):
    """metadata.record_sync — single atomic post-sync write"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_creates_new_record(self):
        self.meta.record_sync(
            "a/test.md",
            file_id="WEB1",
            cloud_mtime=200,
            local_mtime=100,
            parent_id="DIR1",
            domain=1,
            content_hash="hash_a",
            action="uploaded",
            direction="push",
        )
        info = self.meta.get_file_info("a/test.md")
        self.assertIsNotNone(info)
        self.assertEqual(info["file_id"], "WEB1")
        self.assertEqual(info["cloud_mtime"], 200)
        self.assertEqual(info["local_mtime"], 100)
        self.assertEqual(info.get("parent_id"), "DIR1")
        self.assertEqual(info.get("domain"), 1)
        self.assertEqual(info.get("content_hash"), "hash_a")
        self.assertGreater(info.get("last_sync_at", 0), 0)

    def test_updates_existing_record(self):
        self.meta.set_file_info("b.md", "WEB1", cloud_mtime=100, local_mtime=50)
        self.meta.record_sync(
            "b.md",
            file_id="WEB1",
            cloud_mtime=300,
            local_mtime=200,
            content_hash="hash_b",
            action="downloaded",
            direction="pull",
        )
        info = self.meta.get_file_info("b.md")
        self.assertEqual(info["cloud_mtime"], 300)
        self.assertEqual(info["local_mtime"], 200)
        self.assertEqual(info.get("content_hash"), "hash_b")

    def test_preserves_optional_fields_on_update(self):
        self.meta.set_file_info("c.md", "WEB1", cloud_mtime=100, local_mtime=50,
                                parent_id="DIR1", domain=1)
        self.meta.record_sync(
            "c.md",
            file_id="WEB1",
            cloud_mtime=200,
            local_mtime=150,
        )
        info = self.meta.get_file_info("c.md")
        self.assertEqual(info.get("parent_id"), "DIR1")
        self.assertEqual(info.get("domain"), 1)

    def test_sets_original_domain_once(self):
        self.meta.record_sync(
            "d.md",
            file_id="WEB1",
            cloud_mtime=100,
            local_mtime=50,
            original_domain=0,
            action="downloaded",
            direction="pull",
        )
        self.assertEqual(self.meta.get_original_domain("d.md"), 0)

        self.meta.record_sync(
            "d.md",
            file_id="WEB1",
            cloud_mtime=200,
            local_mtime=150,
            original_domain=1,
        )
        self.assertEqual(self.meta.get_original_domain("d.md"), 0)

    def test_writes_sync_log(self):
        self.meta.record_sync(
            "e.md",
            file_id="WEB1",
            cloud_mtime=100,
            local_mtime=50,
            action="uploaded",
            direction="push",
        )
        logs = self.meta.get_sync_log(limit=10, path="e.md")
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0]["path"], "e.md")
        self.assertEqual(logs[0]["action"], "uploaded")
        self.assertEqual(logs[0]["direction"], "push")

    def test_empty_path_raises(self):
        with self.assertRaises(ValueError):
            self.meta.record_sync(
                "",
                file_id="WEB1",
                cloud_mtime=100,
                local_mtime=50,
            )


# ========== heal 测试 ==========

class MetadataHealTest(unittest.TestCase):
    """metadata.heal — lightweight self-healing pass"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir)
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_detects_orphan_without_file_id(self):
        self.meta.set_file_info("ghost.md", "", cloud_mtime=0, local_mtime=100)
        self.meta.save()
        stats = self.meta.heal(self.local_dir, auto_fix=False)
        self.assertEqual(stats["orphan"], 1)
        self.assertIsNotNone(self.meta.get_file_info("ghost.md"))

    def test_fixes_orphan_when_auto_fix(self):
        self.meta.set_file_info("ghost.md", "", cloud_mtime=0, local_mtime=100)
        self.meta.save()
        self.meta.heal(self.local_dir, auto_fix=True)
        self.assertIsNone(self.meta.get_file_info("ghost.md"))

    def test_detects_mtime_drift(self):
        from src.sync.utils import compute_content_hash
        fpath = os.path.join(self.local_dir, "drift.md")
        with open(fpath, "w") as f:
            f.write("same content")
        real_hash = compute_content_hash(fpath)
        real_mtime = int(os.path.getmtime(fpath))

        self.meta.set_file_info("drift.md", "WEB1", cloud_mtime=100,
                                local_mtime=real_mtime - 100,
                                content_hash=real_hash)
        self.meta.save()

        stats = self.meta.heal(self.local_dir, auto_fix=False)
        self.assertEqual(stats["mtime_drift"], 1)

    def test_fixes_mtime_drift(self):
        from src.sync.utils import compute_content_hash
        fpath = os.path.join(self.local_dir, "drift2.md")
        with open(fpath, "w") as f:
            f.write("same content 2")
        real_hash = compute_content_hash(fpath)
        real_mtime = int(os.path.getmtime(fpath))

        self.meta.set_file_info("drift2.md", "WEB1", cloud_mtime=100,
                                local_mtime=real_mtime - 50,
                                content_hash=real_hash)
        self.meta.save()

        self.meta.heal(self.local_dir, auto_fix=True)
        info = self.meta.get_file_info("drift2.md")
        self.assertEqual(info["local_mtime"], real_mtime)

    def test_backfills_missing_hash(self):
        fpath = os.path.join(self.local_dir, "nohash.md")
        with open(fpath, "w") as f:
            f.write("need hash")
        self.meta.set_file_info("nohash.md", "WEB1", cloud_mtime=100,
                                local_mtime=int(os.path.getmtime(fpath)))
        self.meta.save()

        stats = self.meta.heal(self.local_dir, auto_fix=True)
        self.assertEqual(stats["hash_backfill"], 1)
        info = self.meta.get_file_info("nohash.md")
        self.assertIsNotNone(info.get("content_hash"))

    def test_detects_zero_cloud_mtime(self):
        fpath = os.path.join(self.local_dir, "zerocloud.md")
        with open(fpath, "w") as f:
            f.write("zero cloud")
        self.meta.set_file_info("zerocloud.md", "WEB1", cloud_mtime=0,
                                local_mtime=100)
        self.meta.save()

        stats = self.meta.heal(self.local_dir, auto_fix=False)
        self.assertEqual(stats["zero_cloud"], 1)

    def test_clean_metadata_reports_nothing(self):
        from src.sync.utils import compute_content_hash
        fpath = os.path.join(self.local_dir, "ok.md")
        with open(fpath, "w") as f:
            f.write("all good")
        real_hash = compute_content_hash(fpath)
        real_mtime = int(os.path.getmtime(fpath))
        self.meta.set_file_info("ok.md", "WEB1", cloud_mtime=100,
                                local_mtime=real_mtime,
                                content_hash=real_hash)
        self.meta.save()

        stats = self.meta.heal(self.local_dir, auto_fix=False)
        self.assertEqual(sum(stats.values()), 0)


# ========== Feature: matches_selective 测试 ==========

class MatchesSelectiveTest(unittest.TestCase):

    def test_no_filters_passes_all(self):
        from src.sync.scanner import matches_selective
        self.assertTrue(matches_selective("any/path.md", [], []))

    def test_exclude_blocks(self):
        from src.sync.scanner import matches_selective
        self.assertFalse(matches_selective("secret/notes.md", [], ["secret/*"]))

    def test_include_allows(self):
        from src.sync.scanner import matches_selective
        self.assertTrue(matches_selective("work/todo.md", ["work/*"], []))

    def test_include_rejects_others(self):
        from src.sync.scanner import matches_selective
        self.assertFalse(matches_selective("personal/diary.md", ["work/*"], []))

    def test_exclude_overrides_include(self):
        from src.sync.scanner import matches_selective
        self.assertFalse(matches_selective("work/secret.md",
                                           ["work/*"], ["work/secret.md"]))

    def test_recursive_pattern(self):
        from src.sync.scanner import matches_selective
        self.assertFalse(matches_selective("a/b/c/temp.md", [], ["*.md"]))

    def test_directory_paths(self):
        from src.sync.scanner import matches_selective
        self.assertTrue(matches_selective("docs/guide", ["docs/*"], []))


# ========== Feature: 跨目录移动方向感知 测试 ==========

class CrossDirMoveDirectionTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir)
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_local_wins_when_newer(self):
        """本地 mtime 更新 → 保留本地路径，云端文件排队删除"""
        from src.sync.moves import _detect_cross_dir_duplicates
        from src.sync.utils import compute_content_hash
        import xxhash

        h = xxhash.xxh3_128(b"same content").hexdigest()

        local_path = os.path.join(self.local_dir, "new_dir", "doc.md")
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        with open(local_path, "w") as f:
            f.write("same content")

        only_local = {"new_dir/doc.md"}
        only_cloud = {"old_dir/doc.md"}
        cloud_files = {
            "old_dir/doc.md": {"id": "CLOUD1", "parent_id": "P1", "name": "doc.md",
                               "is_dir": False, "mtime": 1000, "ctime": 0, "domain": 1}
        }
        local_files = {
            "new_dir/doc.md": {"path": local_path, "mtime": 2000, "is_dir": False}
        }
        self.meta.set_file_info("old_dir/doc.md", "CLOUD1",
                                cloud_mtime=1000, content_hash=h)
        self.meta.save()

        hash_cache = {local_path: h}
        count, pending = _detect_cross_dir_duplicates(
            only_local, only_cloud, cloud_files, local_files,
            self.meta, self.local_dir, dry_run=True, hash_cache=hash_cache)

        self.assertEqual(count, 1)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0].file_id, "CLOUD1")
        self.assertEqual(pending[0].new_local_path, "new_dir/doc.md")
        self.assertNotIn("old_dir/doc.md", cloud_files)
        self.assertIn("new_dir/doc.md", only_local)

    def test_cloud_wins_when_newer(self):
        """云端 mtime 更新 → 本地跟随云端路径"""
        from src.sync.moves import _detect_cross_dir_duplicates
        import xxhash

        h = xxhash.xxh3_128(b"same content").hexdigest()

        local_path = os.path.join(self.local_dir, "old_dir", "doc.md")
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        with open(local_path, "w") as f:
            f.write("same content")

        only_local = {"old_dir/doc.md"}
        only_cloud = {"new_dir/doc.md"}
        cloud_files = {
            "new_dir/doc.md": {"id": "CLOUD1", "parent_id": "P1", "name": "doc.md",
                               "is_dir": False, "mtime": 3000, "ctime": 100, "domain": 1}
        }
        local_files = {
            "old_dir/doc.md": {"path": local_path, "mtime": 1000, "is_dir": False}
        }
        self.meta.set_file_info("new_dir/doc.md", "CLOUD1",
                                cloud_mtime=3000, content_hash=h)
        self.meta.save()

        hash_cache = {local_path: h}
        count, pending = _detect_cross_dir_duplicates(
            only_local, only_cloud, cloud_files, local_files,
            self.meta, self.local_dir, dry_run=False, hash_cache=hash_cache)

        self.assertEqual(count, 1)
        self.assertEqual(len(pending), 0)
        self.assertNotIn("old_dir/doc.md", only_local)
        self.assertIn("new_dir/doc.md", local_files)

    def test_pending_deletes_include_local_path_and_domain(self):
        """pending tuple 包含 4 个元素: (file_id, old_cloud_path, new_local_path, domain)"""
        from src.sync.moves import _detect_cross_dir_duplicates
        import xxhash

        h = xxhash.xxh3_128(b"content").hexdigest()
        local_path = os.path.join(self.local_dir, "a", "f.md")
        os.makedirs(os.path.dirname(local_path), exist_ok=True)
        with open(local_path, "w") as f:
            f.write("content")

        only_local = {"a/f.md"}
        only_cloud = {"b/f.md"}
        cloud_files = {
            "b/f.md": {"id": "C1", "parent_id": "P", "name": "f.md",
                        "is_dir": False, "mtime": 500, "ctime": 0, "domain": 1}
        }
        local_files = {
            "a/f.md": {"path": local_path, "mtime": 1000, "is_dir": False}
        }
        self.meta.set_file_info("b/f.md", "C1", cloud_mtime=500, content_hash=h)
        self.meta.save()

        hash_cache = {local_path: h}
        count, pending = _detect_cross_dir_duplicates(
            only_local, only_cloud, cloud_files, local_files,
            self.meta, self.local_dir, dry_run=True, hash_cache=hash_cache)

        self.assertEqual(count, 1)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0].file_id, "C1")
        self.assertEqual(pending[0].old_cloud_path, "b/f.md")
        self.assertEqual(pending[0].new_local_path, "a/f.md")
        self.assertEqual(pending[0].domain, 1)


# ========== 扫描缓存测试 ==========

class SyncStateTest(unittest.TestCase):
    """sync_state 表的 get/set 操作"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()

    def test_get_state_missing_returns_none(self):
        """未设置的 key 返回 None"""
        self.assertIsNone(self.meta.get_state("nonexistent"))

    def test_set_and_get_state(self):
        """写入后能读回"""
        self.meta.set_state("my_key", "hello")
        self.assertEqual(self.meta.get_state("my_key"), "hello")

    def test_set_state_upsert(self):
        """重复写入同 key 更新值"""
        self.meta.set_state("k", "v1")
        self.meta.set_state("k", "v2")
        self.assertEqual(self.meta.get_state("k"), "v2")

    def test_get_state_int(self):
        """get_state_int 正确解析整数"""
        self.meta.set_state("ver", "12345")
        self.assertEqual(self.meta.get_state_int("ver"), 12345)

    def test_get_state_int_default(self):
        """get_state_int 缺失时返回 default"""
        self.assertEqual(self.meta.get_state_int("missing", 99), 99)

    def test_get_state_int_invalid(self):
        """get_state_int 非整数字符串返回 default"""
        self.meta.set_state("bad", "not_a_number")
        self.assertEqual(self.meta.get_state_int("bad", 0), 0)

    def test_state_persists_across_reopen(self):
        """关闭再打开后 state 仍在"""
        self.meta.set_state("persist", "yes")
        self.meta.save()
        self.meta.close()
        meta2 = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))
        self.assertEqual(meta2.get_state("persist"), "yes")
        meta2.close()


class ScanCacheTest(unittest.TestCase):
    """SyncManager 的扫描缓存逻辑（_load_cloud_files_from_cache 等）"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir, exist_ok=True)
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))
        self.api = _FakeApi()
        self.manager = _make_manager(self.api, self.local_dir, self.meta)

    def tearDown(self):
        self.meta.close()

    def test_empty_cache_returns_empty(self):
        """metadata 为空时 _load_cloud_files_from_cache 返回空 dict"""
        result = self.manager._load_cloud_files_from_cache()
        self.assertEqual(result, {})

    def test_cache_roundtrip_files(self):
        """set_file_info → _load_cloud_files_from_cache 返回正确结构"""
        self.meta.set_file_info("docs/hello.md", file_id="F1",
                                cloud_mtime=1000, parent_id="D1",
                                domain=1, create_time=900)
        result = self.manager._load_cloud_files_from_cache()

        self.assertIn("docs/hello.md", result)
        info = result["docs/hello.md"]
        self.assertEqual(info["id"], "F1")
        self.assertEqual(info["parent_id"], "D1")
        self.assertFalse(info["is_dir"])
        self.assertEqual(info["mtime"], 1000)
        self.assertEqual(info["domain"], 1)

    def test_cache_excludes_dirs(self):
        """目录不从缓存加载（避免幽灵目录导致虚假 DOWNLOAD）"""
        self.meta.set_dir_info("docs", dir_id="D1", parent_id="ROOT")
        result = self.manager._load_cloud_files_from_cache()
        self.assertNotIn("docs", result)

    def test_cache_excludes_conflict_files(self):
        """.conflict. 文件不从缓存加载（scan_local 也跳过它们）"""
        self.meta.set_file_info(
            "diary/04-13.conflict.20260214_190827.md",
            file_id="C1", cloud_mtime=1000)
        self.meta.set_file_info("diary/normal.md",
                                file_id="C2", cloud_mtime=2000)
        result = self.manager._load_cloud_files_from_cache()
        self.assertNotIn("diary/04-13.conflict.20260214_190827.md", result)
        self.assertIn("diary/normal.md", result)

    def test_cache_skips_local_only_files(self):
        """没有 file_id 的纯本地文件不出现在缓存中"""
        self.meta.set_file_info("local.md", file_id="",
                                cloud_mtime=0)
        result = self.manager._load_cloud_files_from_cache()
        self.assertNotIn("local.md", result)

    def test_save_scan_version(self):
        """_save_scan_version 写入 metadata 并记录 version"""
        cloud_files = {
            "a.md": {"id": "F1", "parent_id": "R", "name": "a.md",
                     "is_dir": False, "mtime": 500, "ctime": 400, "domain": 1},
            "dir1": {"id": "D1", "parent_id": "R", "name": "dir1",
                     "is_dir": True, "mtime": 0, "ctime": 0, "domain": 0},
        }
        self.manager._save_scan_version(cloud_files, 999)

        self.assertEqual(self.meta.get_state_int("last_cloud_version"), 999)
        self.assertIsNotNone(self.meta.get_state("last_scan_time"))
        self.assertEqual(self.meta.get_file_id("a.md"), "F1")
        self.assertEqual(self.meta.get_dir_id("dir1"), "D1")

    def test_save_scan_version_preserves_synced_mtime(self):
        """_save_scan_version 不覆盖已同步文件的 cloud_mtime/local_mtime"""
        # Given: 文件已同步，有 cloud_mtime=1000 和 local_mtime=2000
        self.meta.set_file_info("synced.md", "F1", cloud_mtime=1000,
                                local_mtime=2000)

        # When: 全量扫描写入缓存（云端 mtime 可能已变为 3000）
        cloud_files = {
            "synced.md": {"id": "F1", "parent_id": "R", "name": "synced.md",
                          "is_dir": False, "mtime": 3000, "ctime": 0, "domain": 1},
        }
        self.manager._save_scan_version(cloud_files, 100)

        # Then: cloud_mtime 和 local_mtime 保持不变（由 cache_cloud_file_info 保证）
        info = self.meta.get_file_info("synced.md")
        self.assertEqual(info["cloud_mtime"], 1000)
        self.assertEqual(info["local_mtime"], 2000)

    def test_cleanup_stale_paths(self):
        """_cleanup_stale_paths 清理云端已不存在的文件记录"""
        # Given: metadata 中有 3 个文件
        self.meta.set_file_info("alive.md", "F1", cloud_mtime=100)
        self.meta.set_file_info("dead.md", "F2", cloud_mtime=200)
        self.meta.set_file_info("local_only.md", "", cloud_mtime=0)

        # When: 云端扫描只包含 alive.md
        cloud_files = {
            "alive.md": {"id": "F1", "parent_id": "R", "name": "alive.md",
                         "is_dir": False, "mtime": 100, "ctime": 0, "domain": 1},
        }
        self.manager._cleanup_stale_paths(cloud_files)

        # Then: dead.md 的 file_id 被清空，alive.md 和 local_only.md 不受影响
        self.assertIsNone(self.meta.get_file_id("dead.md"))
        self.assertEqual(self.meta.get_file_id("alive.md"), "F1")

    def test_apply_incremental_preserves_synced_mtime(self):
        """_apply_incremental_changes 不覆盖已同步文件的 cloud_mtime/local_mtime"""
        # Given: 文件已同步
        self.meta.set_file_info("note.md", "F1", cloud_mtime=1000,
                                local_mtime=2000)
        cloud_files = {
            "note.md": {"id": "F1", "parent_id": "R", "name": "note.md",
                        "is_dir": False, "mtime": 1000, "ctime": 0, "domain": 1},
        }

        # When: 增量更新带来新的 cloud mtime
        changed = [_fake_entry("F1", "note.md", version=600, mtime=5000)]
        self.manager._apply_incremental_changes(cloud_files, changed)

        # Then: cloud_files 记录了新 mtime（供 decide_action 比较用）
        self.assertEqual(cloud_files["note.md"]["mtime"], 5000)
        # 但 metadata 中保留原始 mtime（代表"上次同步时"的值）
        info = self.meta.get_file_info("note.md")
        self.assertEqual(info["cloud_mtime"], 1000)
        self.assertEqual(info["local_mtime"], 2000)

    def test_try_cached_no_version_returns_none(self):
        """没有 cached version 时返回 None"""
        from unittest.mock import patch
        with patch.object(self.manager, "_try_seed_from_desktop", return_value=False):
            result = self.manager._try_cached_cloud_scan("ROOT", "")
        self.assertIsNone(result)

    def test_try_cached_fresh_returns_cache(self):
        """缓存 version >= 云端 version 时返回缓存"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100,
                                parent_id="R", domain=1)
        self.meta.set_state("last_cloud_version", "500")
        self.api._recent = [_fake_entry("F1", "a.md", version=500)]

        result = self.manager._try_cached_cloud_scan("ROOT", "")
        self.assertIsNotNone(result)
        self.assertIn("a.md", result)

    def test_try_cached_stale_small_change_incremental(self):
        """缓存过期但变化量 < 30 时做增量更新"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100,
                                parent_id="R", domain=1)
        self.meta.set_state("last_cloud_version", "500")

        self.api._recent = [
            _fake_entry("F1", "a.md", version=501, mtime=200),
            _fake_entry("F2", "old.md", version=400),
        ]

        result = self.manager._try_cached_cloud_scan("ROOT", "")
        self.assertIsNotNone(result)
        self.assertIn("a.md", result)
        self.assertEqual(result["a.md"]["mtime"], 200)
        self.assertEqual(self.meta.get_state_int("last_cloud_version"), 501)

    def test_try_cached_stale_all_changed_full_scan(self):
        """所有 listRecent 条目都比缓存新 → 无法确定完整变更集 → 返回 None"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100,
                                parent_id="R", domain=1)
        self.meta.set_state("last_cloud_version", "100")

        self.api._recent = [
            _fake_entry("F1", "a.md", version=501),
            _fake_entry("F2", "b.md", version=502),
            _fake_entry("F3", "c.md", version=503),
        ]

        result = self.manager._try_cached_cloud_scan("ROOT", "")
        self.assertIsNone(result)

    def test_try_cached_api_fail_uses_stale_cache(self):
        """listRecent 失败时使用旧缓存"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100,
                                parent_id="R", domain=1)
        self.meta.set_state("last_cloud_version", "500")
        self.api._recent_error = True

        result = self.manager._try_cached_cloud_scan("ROOT", "")
        self.assertIsNotNone(result)
        self.assertIn("a.md", result)


class IncrementalUpdateTest(unittest.TestCase):
    """_apply_incremental_changes 增量更新逻辑"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))
        self.api = _FakeApi()
        self.manager = _make_manager(self.api,
                                     os.path.join(self.tmpdir, "notes"),
                                     self.meta)

    def tearDown(self):
        self.meta.close()

    def test_update_existing_file(self):
        """已有文件的 mtime 被更新"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100,
                                parent_id="R", domain=1)
        cloud_files = self.manager._load_cloud_files_from_cache()

        changed = [_fake_entry("F1", "a.md", version=600, mtime=999)]
        self.manager._apply_incremental_changes(cloud_files, changed)

        self.assertEqual(cloud_files["a.md"]["mtime"], 999)

    def test_update_existing_dir(self):
        """已有目录被更新"""
        self.meta.set_dir_info("docs", dir_id="D1", parent_id="ROOT")
        cloud_files = self.manager._load_cloud_files_from_cache()

        changed = [_fake_entry("D1", "docs", version=600, is_dir=True,
                               parent_id="ROOT2")]
        self.manager._apply_incremental_changes(cloud_files, changed)

        self.assertEqual(cloud_files["docs"]["parent_id"], "ROOT2")

    def test_new_file_not_in_cache_logged(self):
        """新文件（缓存中没有对应 file_id）不会崩溃"""
        cloud_files = {}
        changed = [_fake_entry("FNEW", "brand_new.md", version=700)]
        self.manager._apply_incremental_changes(cloud_files, changed)

    def test_skip_empty_entries(self):
        """空 id 或空 name 的条目被跳过"""
        cloud_files = {}
        changed = [
            {"fileEntry": {"id": "", "name": "x.md", "version": 1}},
            {"fileEntry": {"id": "F1", "name": "", "version": 1}},
        ]
        self.manager._apply_incremental_changes(cloud_files, changed)
        self.assertEqual(cloud_files, {})


class ListRecentApiTest(unittest.TestCase):
    """api.list_recent 和 _safe_json_list"""

    def test_safe_json_list_with_list(self):
        """正常列表响应"""
        from src.api import YoudaoNoteApi
        import unittest.mock as mock
        resp = mock.Mock()
        resp.json.return_value = [{"a": 1}, {"b": 2}]
        result = YoudaoNoteApi._safe_json_list(resp)
        self.assertEqual(len(result), 2)

    def test_safe_json_list_with_dict(self):
        """非列表响应返回空列表"""
        from src.api import YoudaoNoteApi
        import unittest.mock as mock
        resp = mock.Mock()
        resp.json.return_value = {"error": "bad"}
        result = YoudaoNoteApi._safe_json_list(resp)
        self.assertEqual(result, [])

    def test_safe_json_list_with_exception(self):
        """解析异常返回空列表"""
        from src.api import YoudaoNoteApi
        import unittest.mock as mock
        resp = mock.Mock()
        resp.json.side_effect = ValueError("bad json")
        result = YoudaoNoteApi._safe_json_list(resp)
        self.assertEqual(result, [])


class FetchCurrentVersionTest(unittest.TestCase):
    """_fetch_current_version"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))
        self.api = _FakeApi()
        self.manager = _make_manager(self.api,
                                     os.path.join(self.tmpdir, "notes"),
                                     self.meta)

    def tearDown(self):
        self.meta.close()

    def test_returns_max_version(self):
        """返回 listRecent 第一条的 version"""
        self.api._recent = [_fake_entry("F1", "a.md", version=888)]
        self.assertEqual(self.manager._fetch_current_version(), 888)

    def test_returns_zero_on_empty(self):
        """listRecent 空时返回 0"""
        self.api._recent = []
        self.assertEqual(self.manager._fetch_current_version(), 0)

    def test_returns_zero_on_error(self):
        """listRecent 报错时返回 0"""
        self.api._recent_error = True
        self.assertEqual(self.manager._fetch_current_version(), 0)


# ========== Phase 3: original_domain 测试 ==========

class OriginalDomainTest(unittest.TestCase):
    """original_domain 记录与查询"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()

    def test_set_and_get_original_domain(self):
        """设置后能读回 original_domain"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100)
        self.meta.set_original_domain("a.md", 0)
        self.assertEqual(self.meta.get_original_domain("a.md"), 0)

    def test_original_domain_not_overwritten(self):
        """set_original_domain 只在值为 NULL 时写入"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100)
        self.meta.set_original_domain("a.md", 0)
        self.meta.set_original_domain("a.md", 1)
        self.assertEqual(self.meta.get_original_domain("a.md"), 0)

    def test_original_domain_none_when_unset(self):
        """未设置时返回 None"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100)
        self.assertIsNone(self.meta.get_original_domain("a.md"))

    def test_original_domain_in_get_file_info(self):
        """get_file_info 返回 original_domain"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100)
        self.meta.set_original_domain("a.md", 0)
        info = self.meta.get_file_info("a.md")
        self.assertEqual(info["original_domain"], 0)

    def test_original_domain_absent_in_get_file_info_when_unset(self):
        """get_file_info 不含 original_domain 当未设置时"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100)
        info = self.meta.get_file_info("a.md")
        self.assertNotIn("original_domain", info)

    def test_original_domain_survives_save_reload(self):
        """保存后重新打开仍保留"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100)
        self.meta.set_original_domain("a.md", 0)
        self.meta.save()
        self.meta.close()
        meta2 = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))
        self.assertEqual(meta2.get_original_domain("a.md"), 0)
        meta2.close()

    def test_original_domain_in_get_all_files(self):
        """get_all_files 包含 original_domain"""
        self.meta.set_file_info("a.md", file_id="F1", cloud_mtime=100)
        self.meta.set_original_domain("a.md", 0)
        files = self.meta.get_all_files()
        self.assertEqual(files["a.md"]["original_domain"], 0)

    def test_nonexistent_path_returns_none(self):
        """查询不存在的路径返回 None"""
        self.assertIsNone(self.meta.get_original_domain("no/such/file.md"))


# ========== 测试辅助 ==========

def _fake_entry(fid, name, version=0, mtime=0, ctime=0, domain=0,
                is_dir=False, parent_id="ROOT"):
    """构造一个 listRecent 风格的条目"""
    return {
        "fileEntry": {
            "id": fid,
            "name": name,
            "version": version,
            "modifyTimeForSort": mtime,
            "createTimeForSort": ctime,
            "domain": domain,
            "dir": is_dir,
            "parentId": parent_id,
        }
    }


class _FakeApi:
    """最小化的 API mock，用于扫描缓存测试"""

    def __init__(self):
        self._recent = []
        self._recent_error = False
        self.cstk = "fake_cstk"
        self.DIR_MES_URL = "http://fake/{dir_id}"
        self.DIR_PAGE_SIZE = 100

    def list_recent(self, limit=30):
        if self._recent_error:
            raise ConnectionError("API unavailable")
        return self._recent[:limit]

    def create_async_client(self):
        raise NotImplementedError("Should not be called when cache is used")


def _make_manager(api, local_dir, metadata):
    """构造一个用于测试的 SyncManager（不需要 downloader/uploader）"""
    from src.sync.engine import SyncManager
    os.makedirs(local_dir, exist_ok=True)
    return SyncManager(
        api=api,
        local_dir=local_dir,
        metadata=metadata,
        downloader=None,
        uploader=None,
    )


# ========== metadata rename_path 测试 ==========

class MetadataRenamePathTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_rename_preserves_all_fields(self):
        """rename_path 保留 file_id、content_hash 等所有字段"""
        self.meta.set_file_info("old/doc.md", file_id="F1", cloud_mtime=1000,
                                local_mtime=900, content_hash="h123")
        self.meta.set_original_domain("old/doc.md", 0)

        result = self.meta.rename_path("old/doc.md", "new/doc.md")
        self.assertTrue(result)

        self.assertIsNone(self.meta.get_file_info("old/doc.md"))
        info = self.meta.get_file_info("new/doc.md")
        self.assertIsNotNone(info)
        self.assertEqual(info["file_id"], "F1")
        self.assertEqual(info["cloud_mtime"], 1000)
        self.assertEqual(info["local_mtime"], 900)
        self.assertEqual(info["content_hash"], "h123")
        self.assertEqual(info["original_domain"], 0)

    def test_rename_nonexistent_returns_false(self):
        """重命名不存在的路径返回 False"""
        result = self.meta.rename_path("no/such.md", "new.md")
        self.assertFalse(result)

    def test_rename_with_conflict_removes_old(self):
        """目标路径已存在时：删除旧路径记录（不崩溃）"""
        self.meta.set_file_info("old.md", file_id="F1", cloud_mtime=100)
        self.meta.set_file_info("new.md", file_id="F2", cloud_mtime=200)

        result = self.meta.rename_path("old.md", "new.md")
        self.assertFalse(result)
        self.assertIsNone(self.meta.get_file_info("old.md"))


# ========== _execute_cloud_moves 测试 ==========

class ExecuteCloudMovesTest(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.local_dir = os.path.join(self.tmpdir, "notes")
        os.makedirs(self.local_dir)
        self.meta = SyncMetadata(os.path.join(self.tmpdir, "meta.json"))

    def tearDown(self):
        self.meta.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _make_manager(self):
        from src.sync.engine import SyncManager
        from unittest.mock import MagicMock

        api = MagicMock()
        api.move_file.return_value = {"responseCode": 0}
        api.rename_file.return_value = {"responseCode": 0}

        uploader = MagicMock()
        uploader.ensure_parent_dir.return_value = "NEW_PARENT_ID"

        mgr = SyncManager(
            api=api, local_dir=self.local_dir, metadata=self.meta,
            downloader=None, uploader=uploader)
        return mgr, api, uploader

    def test_move_calls_api_and_updates_metadata(self):
        """成功移动: 调用 move_file API + metadata 从旧路径迁移到新路径"""
        mgr, api, _ = self._make_manager()

        self.meta.set_file_info("old_dir/doc.md", file_id="F1",
                                cloud_mtime=1000, content_hash="abc")

        local_file = os.path.join(self.local_dir, "new_dir", "doc.md")
        os.makedirs(os.path.dirname(local_file), exist_ok=True)
        with open(local_file, "w") as f:
            f.write("content")

        from src.sync.moves import PendingMove
        mgr._pending_moves = [PendingMove("F1", "old_dir/doc.md", "new_dir/doc.md", 1)]
        moved = mgr._execute_cloud_moves()

        self.assertEqual(moved, {"new_dir/doc.md"})
        api.move_file.assert_called_once_with("F1", "NEW_PARENT_ID", 1)
        api.rename_file.assert_not_called()

        self.assertIsNone(self.meta.get_file_info("old_dir/doc.md"))
        info = self.meta.get_file_info("new_dir/doc.md")
        self.assertEqual(info["file_id"], "F1")
        self.assertEqual(info["content_hash"], "abc")

    def test_move_with_rename(self):
        """文件名也变了时，同时调用 rename_file"""
        mgr, api, _ = self._make_manager()

        self.meta.set_file_info("old/a.md", file_id="F2", cloud_mtime=500)

        local_file = os.path.join(self.local_dir, "new", "b.md")
        os.makedirs(os.path.dirname(local_file), exist_ok=True)
        with open(local_file, "w") as f:
            f.write("x")

        from src.sync.moves import PendingMove
        mgr._pending_moves = [PendingMove("F2", "old/a.md", "new/b.md", 1)]
        moved = mgr._execute_cloud_moves()

        self.assertEqual(moved, {"new/b.md"})
        api.move_file.assert_called_once()
        api.rename_file.assert_called_once_with("F2", "b.md", 1)

    def test_move_failure_falls_back(self):
        """move_file API 抛异常 → 存入 _failed_moves"""
        mgr, api, _ = self._make_manager()
        api.move_file.side_effect = Exception("API error")

        self.meta.set_file_info("old/f.md", file_id="F3", cloud_mtime=100)

        from src.sync.moves import PendingMove
        mgr._pending_moves = [PendingMove("F3", "old/f.md", "new/f.md", 1)]
        moved = mgr._execute_cloud_moves()

        self.assertEqual(moved, set())
        self.assertEqual(len(mgr._failed_moves), 1)
        self.assertIsNotNone(self.meta.get_file_info("old/f.md"))

    def test_ensure_parent_failure_falls_back(self):
        """ensure_parent_dir 返回 None → 存入 _failed_moves"""
        mgr, api, uploader = self._make_manager()
        uploader.ensure_parent_dir.return_value = None

        self.meta.set_file_info("old/g.md", file_id="F4", cloud_mtime=100)

        from src.sync.moves import PendingMove
        mgr._pending_moves = [PendingMove("F4", "old/g.md", "new/g.md", 0)]
        moved = mgr._execute_cloud_moves()

        self.assertEqual(moved, set())
        self.assertEqual(len(mgr._failed_moves), 1)
        api.move_file.assert_not_called()


if __name__ == "__main__":
    unittest.main()
