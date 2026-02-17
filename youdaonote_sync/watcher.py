"""
自动同步守护进程（Watch 模式）

- 用 watchdog 监听本地文件变化，有改动就触发上传
- 定时轮询云端变化，有改动就拉取到本地
- 每次同步后自动 git commit
"""

import logging
import os
import threading
import time as _time
from datetime import datetime
from typing import Dict

from youdaonote_sync.api import YoudaoNoteApi
from youdaonote_sync.sync.engine import SyncManager
from youdaonote_sync.sync.utils import SyncDirection


class SyncWatcher:
    """
    自动同步守护进程

    - 用 watchdog 监听本地文件变化，有改动就触发上传
    - 定时轮询云端变化，有改动就拉取到本地
    - 每次同步后自动 git commit
    """

    def __init__(
        self,
        api: YoudaoNoteApi,
        local_dir: str,
        poll_interval: int = 60,
        debounce_seconds: int = 5,
        sync_manager: SyncManager = None,
    ):
        """
        :param api: YoudaoNoteApi 实例
        :param local_dir: 本地同步目录
        :param poll_interval: 云端轮询间隔（秒）
        :param debounce_seconds: 本地变更防抖时间（秒）
        :param sync_manager: 注入的 SyncManager 实例（可选，默认自动创建）
        """
        self.api = api
        self.local_dir = os.path.abspath(local_dir)
        self.poll_interval = poll_interval
        self.debounce_seconds = debounce_seconds
        self._sync_manager = sync_manager or SyncManager(api, local_dir)
        self._pending_lock = threading.Lock()
        self._pending_local_changes: Dict[str, float] = {}
        self._syncing = False  # 防止重叠同步
        self._running = False

    def start(self) -> None:
        """启动自动同步（阻塞运行）"""
        try:
            from watchdog.observers import Observer
            from watchdog.events import FileSystemEventHandler
        except ImportError:
            print("需要安装 watchdog: pip install watchdog")
            return

        self._running = True

        # 文件变化处理器
        watcher_self = self

        class _LocalChangeHandler(FileSystemEventHandler):
            def on_any_event(self, event):
                if event.is_directory:
                    return
                src = event.src_path
                if not src.endswith(".md") or "/.git/" in src.replace("\\", "/") or ".conflict." in src:
                    return
                with watcher_self._pending_lock:
                    watcher_self._pending_local_changes[src] = _time.time()

        handler = _LocalChangeHandler()
        observer = Observer()
        observer.schedule(handler, self.local_dir, recursive=True)
        observer.start()

        print(f"自动同步已启动")
        print(f"   本地目录: {self.local_dir}")
        print(f"   云端轮询间隔: {self.poll_interval} 秒")
        print(f"   按 Ctrl+C 停止\n")

        # 启动时先做一次全量同步
        self._do_sync("启动时全量同步")

        last_poll = _time.time()

        try:
            while self._running:
                _time.sleep(1)

                # 检查是否有防抖到期的本地变更
                now = _time.time()
                with self._pending_lock:
                    ready = [
                        p for p, t in self._pending_local_changes.items()
                        if now - t >= self.debounce_seconds
                    ]
                    if ready:
                        self._pending_local_changes = {
                            p: t for p, t in self._pending_local_changes.items()
                            if p not in ready
                        }
                if ready:
                    changed_files = [os.path.relpath(p, self.local_dir).replace("\\", "/") for p in ready]
                    logging.info(f"检测到本地变更: {changed_files}")
                    self._do_sync(f"本地变更: {len(changed_files)} 个文件")

                # 定时轮询云端
                if now - last_poll >= self.poll_interval:
                    last_poll = now
                    self._do_sync("定时轮询")

        except KeyboardInterrupt:
            print("\n正在停止自动同步...")
        finally:
            self._running = False
            observer.stop()
            observer.join()
            print("自动同步已停止")

    def stop(self) -> None:
        """停止自动同步"""
        self._running = False

    def _do_sync(self, reason: str) -> None:
        """执行一次同步（防止重叠）"""
        if self._syncing:
            logging.debug(f"跳过同步（上一次尚未结束）: {reason}")
            return
        self._syncing = True
        now_str = datetime.now().strftime("%H:%M:%S")
        print(f"\n[{now_str}] {reason}")
        try:
            stats = self._sync_manager.sync(
                direction=SyncDirection.BOTH,
                auto_git=True,
            )
            changes = stats["downloaded"] + stats["uploaded"]
            if changes > 0:
                print(f"   下载 {stats['downloaded']}, 上传 {stats['uploaded']}", end="")
                if stats["conflicts"]:
                    print(f", 冲突 {stats['conflicts']}", end="")
                if stats.get("dedup_deleted"):
                    print(f", 去重 {stats['dedup_deleted']}", end="")
                print()
            else:
                print(f"   无变更")
        except Exception as e:
            logging.error(f"同步失败: {e}")
            print(f"   同步失败: {e}")
        finally:
            self._syncing = False
