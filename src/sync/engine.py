"""
有道云笔记双向同步引擎

只负责：收集差异 → 决定操作 → 分发给 uploader / downloader 执行
支持：冲突备份、Git 自动提交

扫描、决策、移动检测、工具函数分别位于同包的：
- scanner.py  — scan_cloud / async_scan_cloud / scan_local / map_cloud_name
- decision.py — calibrate_metadata / build_item
- moves.py    — normalize_filename / reconcile_moves
- utils.py    — SyncDirection / SyncAction / SyncItem / decide_action 等
"""

import asyncio
import os
import logging
import threading
from typing import List, Dict

from typing import TYPE_CHECKING

from src.sync.metadata import SyncMetadata
from src.sync.git_helper import GitHelper

if TYPE_CHECKING:
    from src.protocols import SyncApi, SingleFileDownloader, Uploader

from src.sync.utils import (
    SyncDirection, SyncAction, SyncItem,          # noqa: F401 — re-exported
    filter_by_direction, empty_stats,
    print_preview, print_dryrun_summary, backup_file,
    compute_content_hash,
)
from src.sync.scanner import async_scan_cloud, scan_local
from src.sync.decision import calibrate_metadata, build_item
from src.sync.moves import reconcile_moves


class SyncManager:
    """双向同步管理器"""

    # 并发配置
    SCAN_WORKERS = 8          # 云端目录扫描并发数
    DOWNLOAD_WORKERS = 10     # 文件下载并发数
    UPLOAD_WORKERS = 5        # 文件上传并发数
    METADATA_SAVE_BATCH = 200 # 每操作 N 个文件保存一次元数据

    def __init__(self, api: "SyncApi", local_dir: str,
                 metadata: SyncMetadata = None,
                 downloader: "SingleFileDownloader" = None,
                 uploader: "Uploader" = None,
                 git: GitHelper = None):
        self.api = api
        self.local_dir = os.path.abspath(local_dir)
        self.metadata = metadata or SyncMetadata()
        if downloader is None:
            from src.transfer.download import YoudaoNoteDownload
            downloader = YoudaoNoteDownload(api)
        if uploader is None:
            from src.transfer.upload import YoudaoNoteUpload
            uploader = YoudaoNoteUpload(api, self.metadata)
        self.downloader = downloader
        self.uploader = uploader
        self.stats = empty_stats()
        self._changed_paths: List[str] = []
        self._lock = threading.Lock()
        self._meta_dirty = 0
        self._git = git or GitHelper(local_dir)
        self._hash_cache: Dict[str, str] = {}  # abs_path → content_hash

    # ========== 内部辅助 ==========

    def _inc_stat(self, key: str, count: int = 1) -> None:
        """线程安全地增加统计计数。"""
        with self._lock:
            self.stats[key] += count

    def _record_error(self, path: str, msg: str) -> None:
        """记录错误日志并增加错误计数。"""
        logging.error(f"{msg}: {path}")
        self._inc_stat("errors")

    def _try_flush_metadata(self) -> None:
        """在锁内调用：累计脏计数，达到批次阈值时落盘。"""
        self._meta_dirty += 1
        if self._meta_dirty >= self.METADATA_SAVE_BATCH:
            self.metadata.save()
            self._meta_dirty = 0

    def _record_file_change(self, item: SyncItem, stat_key: str,
                            local_mtime: int = None,
                            content_hash: str = None) -> None:
        """记录一次文件同步成功：更新元数据 + 统计 + 变动列表。"""
        # metadata 自身是线程安全的，不需要 engine lock
        if stat_key == "downloaded":
            self.metadata.set_file_info(
                item.relative_path, item.cloud_id, item.cloud_mtime,
                local_mtime, item.cloud_parent_id, item.domain,
                content_hash=content_hash,
                create_time=item.cloud_ctime,
            )
        elif stat_key == "uploaded" and content_hash:
            self.metadata.update_content_hash(
                item.relative_path, content_hash)
        with self._lock:
            self._try_flush_metadata()
            self.stats[stat_key] += 1
            self._changed_paths.append(item.local_path)

    # ========== 公开入口 ==========

    def sync(
        self,
        direction: SyncDirection = SyncDirection.BOTH,
        cloud_dir_id: str = None,
        cloud_path: str = "",
        dry_run: bool = False,
        auto_git: bool = True,
        auto_dedup: bool = True,
    ) -> Dict:
        """执行同步，返回统计信息。

        内部使用 asyncio 调度：
        - 云端扫描：真正 async（httpx.AsyncClient）
        - 本地扫描：asyncio.to_thread
        - 下载/上传：asyncio.to_thread + Semaphore 控制并发
        """
        if not cloud_dir_id:
            cloud_dir_id = self.api.get_root_id()

        logging.info(f"开始同步: 方向={direction.value}, 本地={self.local_dir}")
        self.stats = empty_stats()
        self._changed_paths = []
        self._hash_cache = {}
        self._local_files = None

        asyncio.run(self._async_main(cloud_dir_id, cloud_path, direction, dry_run))

        # 保存残余的未保存元数据
        if self._meta_dirty > 0:
            self.metadata.save()
            self._meta_dirty = 0

        logging.info(
            f"同步完成: 下载={self.stats['downloaded']}, 上传={self.stats['uploaded']}, "
            f"跳过={self.stats['skipped']}, 冲突={self.stats['conflicts']}, "
            f"错误={self.stats['errors']}"
        )

        has_file_changes = self.stats["downloaded"] > 0 or self.stats["uploaded"] > 0
        if auto_dedup and not dry_run and has_file_changes:
            dedup_stats = self._run_dedup(dry_run)
            self.stats["dedup_deleted"] = dedup_stats.get("deleted", 0)

        if auto_git and not dry_run and self._git.has_changes(self._changed_paths):
            self._git.commit_sync(self._changed_paths, self.stats)

        return self.stats

    async def _async_main(self, cloud_dir_id: str, cloud_path: str,
                          direction: SyncDirection, dry_run: bool) -> None:
        """asyncio 主流程：扫描 → 决策 → 执行。"""
        all_items = await self._async_collect_items(cloud_dir_id, cloud_path, dry_run)
        items, skip_count = filter_by_direction(all_items, direction)
        self.stats["skipped"] += skip_count

        if dry_run:
            for item in items:
                print_preview(item)
            print_dryrun_summary(all_items)
        else:
            await self._async_execute_all(items, direction)

    def _run_dedup(self, dry_run: bool = False) -> Dict:
        """执行基于内容 hash 的去重扫描（复用 scan_local 结果避免重复遍历）"""
        from src.sync.dedup import auto_dedup
        try:
            stats = auto_dedup(self.local_dir, metadata=self.metadata,
                               api=self.api, dry_run=dry_run,
                               hash_cache=self._hash_cache,
                               local_files=self._local_files)
            deleted = stats.get("deleted", 0)
            if deleted > 0:
                logging.info(f"去重: 删除了 {deleted} 个重复文件")
                self._changed_paths.append(self.local_dir)
            return stats
        except Exception as e:
            logging.error(f"去重扫描失败: {e}")
            return {}

    # ========== 收集差异 ==========

    async def _async_collect_items(self, cloud_dir_id: str,
                                   cloud_path: str,
                                   dry_run: bool = False) -> List[SyncItem]:
        """并发扫描云端（async）和本地（线程），然后做决策。"""
        async with self.api.create_async_client() as aclient:
            cloud_task = async_scan_cloud(
                aclient, self.api.DIR_MES_URL, self.api.DIR_PAGE_SIZE,
                self.api.cstk, cloud_dir_id, cloud_path, self.SCAN_WORKERS,
            )
            local_task = asyncio.to_thread(scan_local, self.local_dir, cloud_path)
            cloud_files, local_files = await asyncio.gather(cloud_task, local_task)

        calibrate_metadata(self.metadata, cloud_files, local_files,
                           hash_cache=self._hash_cache)
        reconcile_moves(cloud_files, local_files, self.metadata,
                        self.local_dir, dry_run=dry_run,
                        hash_cache=self._hash_cache)

        self._local_files = local_files

        all_paths = set(cloud_files.keys()) | set(local_files.keys())
        return [
            build_item(p, cloud_files.get(p), local_files.get(p),
                       self.metadata, self.local_dir)
            for p in all_paths
        ]

    # ========== 执行 ==========

    async def _async_execute_all(self, items: List[SyncItem],
                                 direction: SyncDirection) -> None:
        """异步并发执行同步操作（items 已不含 SKIP 项）。

        下载/上传通过 asyncio.to_thread 在线程中运行，Semaphore 控制并发。
        """
        dir_items = [i for i in items if i.is_dir]
        file_items = [i for i in items if not i.is_dir]

        for item in dir_items:
            self._execute_dir(item)

        if not file_items:
            return

        uploads = [i for i in file_items
                   if i.action == SyncAction.UPLOAD]
        downloads = [i for i in file_items
                     if i.action in (SyncAction.DOWNLOAD, SyncAction.CONFLICT)]

        dl_sem = asyncio.Semaphore(self.DOWNLOAD_WORKERS)
        ul_sem = asyncio.Semaphore(self.UPLOAD_WORKERS)

        async def _run_download(item: SyncItem) -> None:
            async with dl_sem:
                await asyncio.to_thread(self._execute_file, item, direction)

        async def _run_upload(item: SyncItem) -> None:
            async with ul_sem:
                await asyncio.to_thread(self._execute_file, item, direction)

        tasks = []
        tasks.extend(_run_download(i) for i in downloads)
        tasks.extend(_run_upload(i) for i in uploads)
        results = await asyncio.gather(*tasks, return_exceptions=True)

        for i, result in enumerate(results):
            if isinstance(result, Exception):
                item = (downloads + uploads)[i]
                self._record_error(item.relative_path, f"执行异常 - {result}")

    def _execute_file(self, item: SyncItem, direction: SyncDirection) -> None:
        """分发单个文件的同步操作（在线程池内调用）。"""
        if item.action == SyncAction.DOWNLOAD:
            self._do_download(item)
        elif item.action == SyncAction.UPLOAD:
            self._do_upload(item)
        elif item.action == SyncAction.CONFLICT:
            self._do_conflict(item, direction)
        else:
            self._inc_stat("skipped")

    def _execute_dir(self, item: SyncItem) -> None:
        if item.action == SyncAction.DOWNLOAD:
            os.makedirs(item.local_path, exist_ok=True)
            self._inc_stat("downloaded")
        elif item.action == SyncAction.UPLOAD and item.cloud_parent_id:
            self.uploader.ensure_cloud_dir(
                os.path.basename(item.relative_path),
                item.cloud_parent_id,
                item.relative_path,
                defer_save=True,
            )
            self._inc_stat("uploaded")
        else:
            self._inc_stat("skipped")

    def _do_download(self, item: SyncItem) -> None:
        if not item.cloud_id:
            self._record_error(item.relative_path, "缺少云端 ID，跳过下载")
            return

        os.makedirs(os.path.dirname(item.local_path), exist_ok=True)
        try:
            ok = self.downloader.download_file(
                file_id=item.cloud_id,
                file_name=item.cloud_name or os.path.basename(item.relative_path),
                local_dir=os.path.dirname(item.local_path),
                modify_time=item.cloud_mtime * 1000 if item.cloud_mtime else 0,
                skip_action_check=True,
            )
        except Exception as e:
            self._record_error(item.relative_path, f"下载异常 - {e}")
            return

        if ok:
            try:
                local_mtime = int(os.stat(item.local_path).st_mtime)
            except OSError:
                local_mtime = item.cloud_mtime
            content_hash = compute_content_hash(item.local_path)
            if content_hash:
                with self._lock:
                    self._hash_cache[item.local_path] = content_hash
            self._record_file_change(
                item, "downloaded",
                local_mtime=local_mtime, content_hash=content_hash)
            logging.info(f"下载完成: {item.relative_path}")
        else:
            self._inc_stat("errors")

    def _do_upload(self, item: SyncItem) -> None:
        if not os.path.exists(item.local_path):
            self._record_error(item.relative_path, "本地文件不存在")
            return

        with self._lock:
            cached_hash = self._hash_cache.get(item.local_path)
        content_hash = cached_hash or compute_content_hash(item.local_path)
        if content_hash:
            with self._lock:
                existing = self.metadata.find_cloud_file_by_hash(
                    content_hash, exclude_path=item.relative_path)
            if existing:
                logging.info(f"跳过上传(内容已在云端): "
                             f"{item.relative_path} ↔ {existing}")
                self._inc_stat("skipped")
                return

        parent_id = (item.cloud_parent_id
                     or self.uploader.ensure_parent_dir(item.relative_path))
        if not parent_id:
            self._record_error(item.relative_path, "无法确定云端父目录")
            return

        ok, err = self.uploader.upload_file(
            item.local_path, parent_id, item.relative_path, force=True)
        if ok:
            self._record_file_change(
                item, "uploaded", content_hash=content_hash)
            logging.info(f"上传完成: {item.relative_path}")
        else:
            self._record_error(item.relative_path, f"上传失败 - {err}")

    def _do_conflict(self, item: SyncItem,
                     direction: SyncDirection) -> None:
        """冲突处理：先备份被覆盖的版本，再按策略同步。"""
        logging.warning(f"冲突: {item.relative_path}")
        self._inc_stat("conflicts")

        if direction == SyncDirection.PULL:
            backup_file(item.local_path)
            self._do_download(item)
        elif direction == SyncDirection.PUSH:
            if item.cloud_id and item.local_path:
                backup_file(item.local_path)
            self._do_upload(item)
        else:
            if item.local_path and os.path.exists(item.local_path):
                backup_file(item.local_path)
                self._do_download(item)
                logging.info(f"冲突已保留两个版本: {item.relative_path}")
            else:
                self._do_download(item)
