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
import json
import os
import logging
import threading
import time
from typing import List, Dict, Optional

from typing import TYPE_CHECKING

from src.sync.metadata import SyncMetadata
from src.sync.git_helper import GitHelper

if TYPE_CHECKING:
    from src.protocols import SyncApi, SingleFileDownloader, Uploader

from dataclasses import replace as dc_replace

from src.sync.utils import (
    SyncDirection, SyncAction, SyncItem,          # noqa: F401 — re-exported
    filter_by_direction, empty_stats,
    print_preview, print_dryrun_summary, backup_file,
    compute_content_hash, compute_hash_from_bytes,
    retry_with_backoff, decide_action,
)
from src.sync.scanner import async_scan_cloud, scan_local, matches_selective
from src.sync.decision import calibrate_metadata, build_item
from src.sync.moves import reconcile_moves


class _SyncLock:
    """基于 PID 的跨进程同步锁，防止多个同步实例同时运行。"""

    STALE_THRESHOLD = 3600  # 锁超过 1 小时视为过期

    def __init__(self, local_dir: str):
        self._lock_path = os.path.join(local_dir, ".sync.lock")

    def acquire(self) -> bool:
        """尝试获取锁。返回 True 表示成功，False 表示已有活跃同步。

        使用 O_CREAT|O_EXCL 原子创建避免竞态；已有锁时检查 PID 存活性和过期。
        """
        # 先尝试原子创建（无竞态）
        try:
            fd = os.open(self._lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w") as f:
                json.dump({"pid": os.getpid(), "started": time.time()}, f)
            return True
        except FileExistsError:
            pass
        except OSError as e:
            logging.error(f"无法创建锁文件: {e}")
            return False

        # 锁文件已存在 — 检查是否可以接管
        try:
            with open(self._lock_path, "r") as f:
                info = json.load(f)
            pid = info.get("pid", 0)
            started = info.get("started", 0)
            if self._is_pid_alive(pid) and (time.time() - started) < self.STALE_THRESHOLD:
                logging.error(f"另一个同步进程正在运行 (PID={pid})")
                return False
            logging.warning(f"发现过期锁 (PID={pid})，接管")
        except (json.JSONDecodeError, OSError):
            logging.warning("锁文件损坏，覆盖")

        # 接管：删除旧锁后重新原子创建
        try:
            os.remove(self._lock_path)
        except OSError:
            pass
        try:
            fd = os.open(self._lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "w") as f:
                json.dump({"pid": os.getpid(), "started": time.time()}, f)
            return True
        except (FileExistsError, OSError) as e:
            logging.error(f"接管锁失败（可能另一进程已抢占）: {e}")
            return False

    def release(self) -> None:
        try:
            if os.path.exists(self._lock_path):
                os.remove(self._lock_path)
        except OSError:
            pass

    @staticmethod
    def _is_pid_alive(pid: int) -> bool:
        if pid <= 0:
            return False
        if os.name == "nt":
            import ctypes
            kernel32 = ctypes.windll.kernel32
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if handle:
                kernel32.CloseHandle(handle)
                return True
            return False
        try:
            os.kill(pid, 0)
            return True
        except PermissionError:
            return True
        except OSError:
            return False


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
                 git: GitHelper = None,
                 sync_include: List[str] = None,
                 sync_exclude: List[str] = None):
        self.api = api
        self.local_dir = os.path.abspath(local_dir)
        self._sync_include = sync_include or []
        self._sync_exclude = sync_exclude or []
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
        self._pending_deletes: List[tuple] = []  # [(file_id, old_cloud_path, new_local_path), ...]
        self._uploaded_paths: set = set()  # 成功上传的 rel_path 集合

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
        """累计脏计数，达到批次阈值时落盘。必须在 self._lock 内调用。"""
        self._meta_dirty += 1
        if self._meta_dirty >= self.METADATA_SAVE_BATCH:
            self.metadata.save()
            self._meta_dirty = 0

    def _record_file_change(self, item: SyncItem, stat_key: str,
                            local_mtime: int = None,
                            content_hash: str = None) -> None:
        """记录一次文件同步成功：更新元数据 + 统计 + 变动列表 + 操作日志。"""
        old_hash = None
        meta = self.metadata.get_file_info(item.relative_path)
        if meta:
            old_hash = meta.get("content_hash")

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

        # Phase 2b: cache cloud hash on successful sync
        if content_hash:
            self.metadata.set_cloud_content_hash(item.relative_path, content_hash)

        self.metadata.mark_synced(item.relative_path)

        # Phase 2d: sync operation log
        direction = "pull" if stat_key == "downloaded" else "push"
        self.metadata.log_sync_action(
            path=item.relative_path,
            action=stat_key,
            direction=direction,
            old_hash=old_hash,
            new_hash=content_hash,
            cloud_id=item.cloud_id,
        )

        with self._lock:
            if stat_key == "uploaded":
                self._uploaded_paths.add(item.relative_path)
            self._try_flush_metadata()
            self.stats[stat_key] += 1
            if item.local_path:
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

        lock = _SyncLock(self.local_dir)
        if not dry_run and not lock.acquire():
            logging.error("无法获取同步锁，退出")
            return empty_stats()

        try:
            return self._sync_inner(cloud_dir_id, cloud_path, direction,
                                    dry_run, auto_git, auto_dedup)
        finally:
            if not dry_run:
                lock.release()

    def _sync_inner(self, cloud_dir_id: str, cloud_path: str,
                    direction: SyncDirection, dry_run: bool,
                    auto_git: bool, auto_dedup: bool) -> Dict:
        logging.info(f"开始同步: 方向={direction.value}, 本地={self.local_dir}")
        self.stats = empty_stats()
        self._changed_paths = []
        self._hash_cache = {}
        self._local_files = None
        self._uploaded_paths = set()

        try:
            asyncio.run(self._async_main(cloud_dir_id, cloud_path, direction, dry_run))
        finally:
            if self._meta_dirty > 0:
                self.metadata.save()
                self._meta_dirty = 0

        logging.info(
            f"同步完成: 下载={self.stats['downloaded']}, 上传={self.stats['uploaded']}, "
            f"跳过={self.stats['skipped']}, 冲突={self.stats['conflicts']}, "
            f"错误={self.stats['errors']}"
        )

        if not dry_run and self._pending_deletes:
            self._cleanup_old_cloud_files()

        has_file_changes = self.stats["downloaded"] > 0 or self.stats["uploaded"] > 0
        dedup_deleted_paths: List[str] = []
        if auto_dedup and not dry_run and has_file_changes:
            dedup_stats = self._run_dedup(dry_run)
            self.stats["dedup_deleted"] = dedup_stats.get("deleted", 0)
            dedup_deleted_paths = dedup_stats.get("deleted_paths", [])

        if auto_git and not dry_run and self._git.has_changes(self._changed_paths):
            self._git.commit_sync(self._changed_paths, self.stats,
                                  dedup_deleted_paths=dedup_deleted_paths)

        return self.stats

    async def _async_main(self, cloud_dir_id: str, cloud_path: str,
                          direction: SyncDirection, dry_run: bool) -> None:
        """asyncio 主流程：扫描 → 决策 → 冲突精炼 → 执行。"""
        all_items = await self._async_collect_items(cloud_dir_id, cloud_path, dry_run)
        all_items = await self._refine_conflicts(all_items)
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
            return stats
        except (OSError, ValueError) as e:
            logging.error(f"去重扫描失败: {e}")
            return {}

    def _cleanup_old_cloud_files(self) -> None:
        """删除跨目录移动后遗留的旧云端文件。

        只有对应的新路径上传成功后才删除旧云端文件，否则跳过以防止数据丢失。
        """
        for file_id, old_cloud_path, new_local_path in self._pending_deletes:
            if new_local_path not in self._uploaded_paths:
                logging.warning(
                    f"跳过删除旧云端文件(对应上传未成功): "
                    f"{old_cloud_path} ({file_id}), 期望上传={new_local_path}")
                continue
            try:
                self.api.delete_file(file_id)
                self.metadata.remove_file_info(old_cloud_path)
                logging.info(f"已删除旧云端文件: {old_cloud_path} ({file_id})")
            except Exception as e:
                logging.error(f"删除旧云端文件失败: {old_cloud_path} ({file_id}) - {e}")
        self._pending_deletes = []

    def collect_items(self, cloud_dir_id: str, cloud_path: str = "",
                      dry_run: bool = False) -> List[SyncItem]:
        """同步版收集差异项（供 dry-run 报告等外部工具使用）"""
        self._hash_cache = {}
        self._local_files = None
        self._pending_deletes = []
        return asyncio.run(self._async_collect_items(
            cloud_dir_id, cloud_path, dry_run))

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
            local_task = asyncio.to_thread(
                scan_local, self.local_dir, cloud_path,
                self._sync_include, self._sync_exclude)
            cloud_files, local_files = await asyncio.gather(cloud_task, local_task)

        if self._sync_include or self._sync_exclude:
            cloud_files = {k: v for k, v in cloud_files.items()
                          if matches_selective(k, self._sync_include,
                                               self._sync_exclude)}

        calibrate_metadata(self.metadata, cloud_files, local_files,
                           hash_cache=self._hash_cache)
        pre_move_keys = set(cloud_files.keys()) | set(local_files.keys())
        pending_deletes = reconcile_moves(
            cloud_files, local_files, self.metadata,
            self.local_dir, dry_run=dry_run,
            hash_cache=self._hash_cache)
        post_move_keys = set(cloud_files.keys()) | set(local_files.keys())
        changed_keys = post_move_keys - pre_move_keys
        if changed_keys:
            affected_cloud = {k: v for k, v in cloud_files.items() if k in changed_keys}
            affected_local = {k: v for k, v in local_files.items() if k in changed_keys}
            calibrate_metadata(self.metadata, affected_cloud, affected_local,
                               hash_cache=self._hash_cache)
        self._pending_deletes = pending_deletes
        self._local_files = local_files

        # Phase 2a: parallel hash warmup for files that need comparison
        await self._warmup_hash_cache(cloud_files, local_files)

        all_paths = set(cloud_files.keys()) | set(local_files.keys())
        return [
            build_item(p, cloud_files.get(p), local_files.get(p),
                       self.metadata, self.local_dir,
                       hash_cache=self._hash_cache)
            for p in all_paths
        ]

    async def _warmup_hash_cache(self, cloud_files: Dict, local_files: Dict) -> None:
        """并行预计算两端都有的文件的 content hash，后续 build_item 直接命中缓存。"""
        both = set(cloud_files.keys()) & set(local_files.keys())
        need_hash = []
        for rel in both:
            info = local_files[rel]
            if info.get("is_dir"):
                continue
            abs_path = info["path"]
            if abs_path not in self._hash_cache:
                need_hash.append(abs_path)

        if not need_hash:
            return

        max_parallel = min(len(need_hash), os.cpu_count() or 4, 16)
        sem = asyncio.Semaphore(max_parallel)

        async def _compute(path: str) -> None:
            async with sem:
                h = await asyncio.to_thread(compute_content_hash, path)
                if h:
                    with self._lock:
                        self._hash_cache[path] = h

        await asyncio.gather(*[_compute(p) for p in need_hash])
        logging.debug(f"Hash 预热: {len(need_hash)} 个文件")

    # ========== 冲突精炼 ==========

    _HASHABLE_EXTS = frozenset({".md", ".txt", ".html", ".css", ".js", ".json", ".xml", ".csv"})

    async def _refine_conflicts(self, items: List[SyncItem]) -> List[SyncItem]:
        """下载 CONFLICT 项的云端内容，用三方 hash 比较尝试降级。

        只处理文本文件（.md 等），因为 .note/.clip 云端格式与本地不同，hash 不可比。

        降级规则：
        - cloud_hash == local_hash → SKIP（双方改成了相同内容）
        - cloud_hash == meta_hash → UPLOAD（云端没真正变，只有本地变了）
        - local_hash == meta_hash → DOWNLOAD（本地没真正变，只有云端变了）
        """
        candidates = [
            (idx, item) for idx, item in enumerate(items)
            if item.action == SyncAction.CONFLICT
            and item.cloud_id
            and os.path.splitext(item.relative_path)[1].lower() in self._HASHABLE_EXTS
        ]
        if not candidates:
            return items

        sem = asyncio.Semaphore(self.DOWNLOAD_WORKERS)

        async def fetch_cloud_hash(item: SyncItem) -> Optional[str]:
            # Phase 2b: try cached cloud hash first
            meta = self.metadata.get_file_info(item.relative_path)
            if meta and meta.get("cloud_content_hash"):
                cached_cloud_mtime = meta.get("cloud_mtime", 0)
                if cached_cloud_mtime == item.cloud_mtime:
                    return meta["cloud_content_hash"]

            async with sem:
                try:
                    resp = await asyncio.to_thread(
                        self.api.get_file_by_id, item.cloud_id)
                    cloud_hash = compute_hash_from_bytes(resp.content, item.relative_path)
                    if cloud_hash:
                        self.metadata.set_cloud_content_hash(
                            item.relative_path, cloud_hash)
                    return cloud_hash
                except Exception as e:
                    logging.warning(f"获取云端 hash 失败: {item.relative_path} - {e}")
                    return None

        cloud_hashes = await asyncio.gather(
            *(fetch_cloud_hash(item) for _, item in candidates))

        result = list(items)
        refined = 0
        for (idx, item), cloud_hash in zip(candidates, cloud_hashes):
            if not cloud_hash:
                continue

            meta = self.metadata.get_file_info(item.relative_path)
            with self._lock:
                local_hash = self._hash_cache.get(item.local_path) if item.local_path else None
            meta_hash = meta.get("content_hash") if meta else None

            previously_synced = (
                meta is not None
                and bool(meta.get("file_id"))
                and meta.get("last_sync_at", 0) > 0
            )
            new_action = decide_action(
                local_exists=True,
                cloud_exists=True,
                local_mtime=item.local_mtime,
                cloud_mtime=item.cloud_mtime,
                meta_local_mtime=meta.get("local_mtime") if meta else None,
                meta_cloud_mtime=meta.get("cloud_mtime") if meta else None,
                local_hash=local_hash,
                cloud_hash=cloud_hash,
                meta_hash=meta_hash,
                previously_synced=previously_synced,
            )

            if new_action != item.action:
                logging.info(
                    f"冲突精炼: {item.relative_path} "
                    f"{item.action.value} → {new_action.value}")
                result[idx] = dc_replace(item, action=new_action)
                refined += 1

        if refined > 0:
            logging.info(f"冲突精炼: {refined}/{len(candidates)} 项降级")
        return result

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
            ok = retry_with_backoff(lambda: self.downloader.download_file(
                file_id=item.cloud_id,
                file_name=item.cloud_name or os.path.basename(item.relative_path),
                local_dir=os.path.dirname(item.local_path),
                modify_time=item.cloud_mtime * 1000 if item.cloud_mtime else 0,
                skip_action_check=True,
            ))
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

        ok, err = retry_with_backoff(lambda: self.uploader.upload_file(
            item.local_path, parent_id, item.relative_path, force=True))
        if ok:
            self._record_file_change(
                item, "uploaded", content_hash=content_hash)
            logging.info(f"上传完成: {item.relative_path}")
        else:
            self._record_error(item.relative_path, f"上传失败 - {err}")

    def _do_conflict(self, item: SyncItem,
                     direction: SyncDirection) -> None:
        """冲突处理：先尝试 diff3 自动合并，失败则备份+下载。"""
        logging.warning(f"冲突: {item.relative_path}")
        self._inc_stat("conflicts")

        # Phase 3d: try diff3 merge for markdown files
        if (direction == SyncDirection.BOTH
                and item.cloud_id
                and os.path.splitext(item.relative_path)[1].lower() in (".md", ".txt")
                and os.path.exists(item.local_path)):
            merged = self._try_diff3_merge(item)
            if merged:
                return

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

    def _try_diff3_merge(self, item: SyncItem) -> bool:
        """尝试 diff3 三路合并，写入本地并上传到云端。成功返回 True。"""
        try:
            from src.sync.merge import three_way_merge
        except ImportError:
            return False

        base_bytes = self._git.get_file_content(item.relative_path)
        if base_bytes is None:
            base_bytes = self.metadata.get_base_content(item.relative_path)
        if base_bytes is None:
            return False

        try:
            resp = self.api.get_file_by_id(item.cloud_id)
            theirs_bytes = resp.content
        except Exception:
            return False

        try:
            with open(item.local_path, "rb") as f:
                ours_bytes = f.read()
        except OSError:
            return False

        base = base_bytes.decode("utf-8", errors="replace")
        ours = ours_bytes.decode("utf-8", errors="replace")
        theirs = theirs_bytes.decode("utf-8", errors="replace")

        result = three_way_merge(base, ours, theirs)

        if result.has_conflicts:
            logging.info(
                f"diff3 合并失败({result.conflict_count} 个冲突): "
                f"{item.relative_path}，回退到备份+下载")
            return False

        backup_file(item.local_path)
        with open(item.local_path, "w", encoding="utf-8") as f:
            f.write(result.merged_text)

        content_hash = compute_content_hash(item.local_path)
        if content_hash:
            with self._lock:
                self._hash_cache[item.local_path] = content_hash

        merged_bytes = result.merged_text.encode("utf-8")
        self.metadata.save_base_content(
            item.relative_path, merged_bytes, content_hash or "")

        # 合并结果必须上传到云端，否则云端仍是旧版本导致永久分歧
        parent_id = (item.cloud_parent_id
                     or self.uploader.ensure_parent_dir(item.relative_path))
        if parent_id:
            ok, err = retry_with_backoff(lambda: self.uploader.upload_file(
                item.local_path, parent_id, item.relative_path, force=True))
            if ok:
                self._record_file_change(
                    item, "uploaded", content_hash=content_hash)
                logging.info(f"diff3 合并+上传完成: {item.relative_path}")
                return True
            else:
                logging.error(f"diff3 合并后上传失败: {item.relative_path} - {err}")
                return False
        else:
            logging.error(f"diff3 合并后无法确定云端父目录: {item.relative_path}")
            return False
