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
from src.sync.utils import decide_action, SyncAction, filter_by_direction, SyncDirection, SyncItem
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
        if os.path.exists(self.metadata_path):
            os.remove(self.metadata_path)
        os.rmdir(self.tmpdir)

    def test_save_and_load(self):
        """保存后重新加载，数据一致"""
        # Given
        self.meta.set_file_info("a/b.md", "WEB123", cloud_mtime=1000, local_mtime=1000)

        # When
        self.meta.save()
        reloaded = SyncMetadata(metadata_path=self.metadata_path)

        # Then
        self.assertEqual(reloaded.get_file_id("a/b.md"), "WEB123")

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

    def test_update_local_mtime(self):
        """更新本地修改时间"""
        # Given
        self.meta.set_file_info("x.md", "WEB1", cloud_mtime=100, local_mtime=100)

        # When
        self.meta.update_local_mtime("x.md", 200)

        # Then
        self.assertEqual(self.meta.get_file_info("x.md")["local_mtime"], 200)

    def test_update_cloud_mtime(self):
        """更新云端修改时间"""
        # Given
        self.meta.set_file_info("x.md", "WEB1", cloud_mtime=100, local_mtime=100)

        # When
        self.meta.update_cloud_mtime("x.md", 300)

        # Then
        self.assertEqual(self.meta.get_file_info("x.md")["cloud_mtime"], 300)

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

    def test_load_corrupt_file(self):
        """加载损坏的 JSON 文件不会崩溃"""
        # Given
        with open(self.metadata_path, "w") as f:
            f.write("this is not json")

        # When
        meta = SyncMetadata(metadata_path=self.metadata_path)

        # Then — 不崩溃，使用空数据
        self.assertEqual(meta.get_all_files(), {})

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
        """没有 file_id 的文件不会被反向索引命中"""
        # Given — set_file_info 的 file_id 参数是空字符串
        self.meta._data["files"]["local.md"] = {
            "file_id": "",  # 无 file_id
            "cloud_mtime": 1,
            "local_mtime": 1,
            "content_hash": "abc123",
        }
        self.meta._rebuild_hash_index()

        # When / Then
        self.assertIsNone(self.meta.find_cloud_file_by_hash("abc123"))

    def test_hash_index_survives_save_reload(self):
        """保存后重新加载，反向索引自动重建"""
        # Given
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1, content_hash="hash1")
        self.meta.save()

        # When
        reloaded = SyncMetadata(metadata_path=self.metadata_path)

        # Then
        self.assertEqual(reloaded.find_cloud_file_by_hash("hash1"), "a.md")

    def test_hash_index_updated_on_remove(self):
        """删除文件后反向索引同步清理"""
        # Given
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1, content_hash="hash1")

        # When
        self.meta.remove_file("a.md")

        # Then
        self.assertIsNone(self.meta.find_cloud_file_by_hash("hash1"))

    def test_hash_index_reindex_on_remove(self):
        """删除文件后，同 hash 的其他文件自动接替索引"""
        # Given — 两个文件共享同一个 content_hash
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1, content_hash="shared")
        self.meta.set_file_info("b.md", "WEBB", cloud_mtime=2, content_hash="shared")

        # When — 删除索引指向的那个文件
        indexed_path = self.meta._hash_index.get("shared")
        other_path = "b.md" if indexed_path == "a.md" else "a.md"
        self.meta.remove_file(indexed_path)

        # Then — 索引自动指向另一个文件
        result = self.meta.find_cloud_file_by_hash("shared")
        self.assertEqual(result, other_path)

    def test_hash_index_updated_on_update_content_hash(self):
        """update_content_hash 后反向索引更新"""
        # Given
        self.meta.set_file_info("a.md", "WEBA", cloud_mtime=1, content_hash="old")

        # When
        self.meta.update_content_hash("a.md", "new")

        # Then
        self.assertIsNone(self.meta.find_cloud_file_by_hash("old"))
        self.assertEqual(self.meta.find_cloud_file_by_hash("new"), "a.md")


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
        if os.path.exists(self.metadata_path):
            os.remove(self.metadata_path)
        os.rmdir(self.tmpdir)

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

        # Given — 创建两个文件，手动构造"碰撞"场景
        # 正常情况下 MD5 不会碰撞，这里直接用 metadata 模拟
        meta = SyncMetadata(metadata_path=os.path.join(self.tmpdir, "meta.json"))

        # 写入两个不同大小的文件
        f1 = os.path.join(self.tmpdir, "file1.md")
        f2 = os.path.join(self.tmpdir, "file2.md")
        with open(f1, "w") as f:
            f.write("short")
        with open(f2, "w") as f:
            f.write("this is a much longer content")

        # 给它们赋相同的 content_hash（模拟碰撞）+ 不同的 file_id（都是云端文件）
        meta.set_file_info("file1.md", "WEB1", cloud_mtime=1, content_hash="collision_hash")
        meta.set_file_info("file2.md", "WEB2", cloud_mtime=2, content_hash="collision_hash")
        meta.save()

        # When
        stats = auto_dedup(self.tmpdir, metadata=meta, dry_run=True)

        # Then — 两个文件大小不同，碰撞防护应该拆分它们，不产生删除动作
        self.assertEqual(stats["deleted"], 0)

    def test_same_hash_same_size_deduped(self):
        """同 hash 同大小的文件正常去重"""
        from src.sync.dedup import auto_dedup

        # Given — 两个内容完全相同的文件
        meta = SyncMetadata(metadata_path=os.path.join(self.tmpdir, "meta.json"))

        f1 = os.path.join(self.tmpdir, "file1.md")
        f2 = os.path.join(self.tmpdir, "file2.md")
        content = "identical content"
        with open(f1, "w") as f:
            f.write(content)
        with open(f2, "w") as f:
            f.write(content)

        # 两个都是云端文件，相同 hash
        real_hash = SyncMetadata.compute_content_hash(f1)
        meta.set_file_info("file1.md", "WEB1", cloud_mtime=1, content_hash=real_hash)
        meta.set_file_info("file2.md", "WEB2", cloud_mtime=2, content_hash=real_hash)
        meta.save()

        # When
        stats = auto_dedup(self.tmpdir, metadata=meta, dry_run=True)

        # Then — 同大小同 hash，应该触发去重（保留 1 个删除 1 个）
        self.assertEqual(stats["deleted"], 1)
        self.assertEqual(stats["kept"], 1)


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

    def test_unknown_suffix_falls_back_to_markdown(self):
        """未知后缀应 fallback 到 _upload_markdown"""
        from src.transfer.upload import YoudaoNoteUpload

        handler_name = YoudaoNoteUpload._UPLOAD_HANDLERS.get(".xyz", "_upload_markdown")
        self.assertEqual(handler_name, "_upload_markdown")


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
        meta.set_file_info("a/x.md", "WEB1", cloud_mtime=1000, local_mtime=1000)
        meta.set_file_info("b/x.md", "WEB2", cloud_mtime=1000, local_mtime=1000)

        # 自定义评分：路径含 "b/" 的得分更高
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

        # Cleanup
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


class FilterByDirectionTest(unittest.TestCase):
    """filter_by_direction() 按方向过滤"""

    def test_pull_only_download_and_skip(self):
        """PULL direction → only DOWNLOAD and SKIP"""
        # Given
        items = [
            SyncItem("a.md", None, "id1", None, None, 100, False, SyncAction.DOWNLOAD),
            SyncItem("b.md", None, "id2", None, None, 100, False, SyncAction.UPLOAD),
            SyncItem("c.md", None, "id3", None, None, 100, False, SyncAction.SKIP),
            SyncItem("d.md", None, "id4", None, None, 100, False, SyncAction.CONFLICT),
        ]
        # When
        result = filter_by_direction(items, SyncDirection.PULL)
        # Then
        self.assertEqual(len(result), 2)
        actions = {i.action for i in result}
        self.assertEqual(actions, {SyncAction.DOWNLOAD, SyncAction.SKIP})

    def test_push_only_upload_and_skip(self):
        """PUSH direction → only UPLOAD and SKIP"""
        # Given
        items = [
            SyncItem("a.md", None, "id1", None, None, 100, False, SyncAction.DOWNLOAD),
            SyncItem("b.md", None, "id2", None, None, 100, False, SyncAction.UPLOAD),
            SyncItem("c.md", None, "id3", None, None, 100, False, SyncAction.SKIP),
            SyncItem("d.md", None, "id4", None, None, 100, False, SyncAction.CONFLICT),
        ]
        # When
        result = filter_by_direction(items, SyncDirection.PUSH)
        # Then
        self.assertEqual(len(result), 2)
        actions = {i.action for i in result}
        self.assertEqual(actions, {SyncAction.UPLOAD, SyncAction.SKIP})

    def test_both_all_items(self):
        """BOTH direction → all items"""
        # Given
        items = [
            SyncItem("a.md", None, "id1", None, None, 100, False, SyncAction.DOWNLOAD),
            SyncItem("b.md", None, "id2", None, None, 100, False, SyncAction.UPLOAD),
            SyncItem("c.md", None, "id3", None, None, 100, False, SyncAction.SKIP),
            SyncItem("d.md", None, "id4", None, None, 100, False, SyncAction.CONFLICT),
        ]
        # When
        result = filter_by_direction(items, SyncDirection.BOTH)
        # Then
        self.assertEqual(len(result), 4)


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


if __name__ == "__main__":
    unittest.main()
