"""
同步元数据管理模块

管理本地文件与云端文件 ID 的映射关系，用于双向同步。
每个文件还存储 content_hash（normalized MD5），用于内容级去重。
"""

import json
import os
import logging
import tempfile
import threading
from typing import Optional, Dict, Any, List

from src.common import get_config_directory, normalize_sep


class SyncMetadata:
    """管理本地文件与云端 ID 的映射关系（线程安全）"""

    def __init__(self, metadata_path: str = None):
        """
        初始化元数据管理器
        
        :param metadata_path: 元数据文件路径，默认为 config/sync_metadata.json
        """
        self.metadata_path = metadata_path or os.path.join(
            get_config_directory(), "sync_metadata.json"
        )
        self._data: Dict[str, Any] = {"files": {}, "directories": {}}
        # 反向索引（全部在 load 时重建，写操作时增量维护）
        self._hash_index: Dict[str, List[str]] = {}   # content_hash → [paths with file_id]
        self._file_id_index: Dict[str, str] = {}      # file_id → path
        self._dir_id_index: Dict[str, str] = {}       # dir_id → path
        self._lock = threading.Lock()
        self.load()

    def load(self) -> None:
        """从文件加载元数据"""
        if os.path.exists(self.metadata_path):
            try:
                with open(self.metadata_path, "r", encoding="utf-8") as f:
                    self._data = json.load(f)
                # 确保必要的键存在
                if "files" not in self._data:
                    self._data["files"] = {}
                if "directories" not in self._data:
                    self._data["directories"] = {}
            except (json.JSONDecodeError, IOError) as e:
                logging.warning(f"加载元数据文件失败: {e}，使用空数据")
                self._data = {"files": {}, "directories": {}}
        else:
            self._data = {"files": {}, "directories": {}}
        self._rebuild_indexes()

    def save(self) -> bool:
        """
        原子保存元数据到文件（先写临时文件再 rename，防止崩溃导致文件截断）
        
        :return: 是否保存成功
        """
        with self._lock:
            try:
                dir_path = os.path.dirname(self.metadata_path)
                os.makedirs(dir_path, exist_ok=True)
                fd, tmp_path = tempfile.mkstemp(dir=dir_path, suffix=".tmp", prefix=".sync_meta_")
                try:
                    with os.fdopen(fd, "w", encoding="utf-8") as f:
                        json.dump(self._data, f, ensure_ascii=False, indent=2)
                    os.replace(tmp_path, self.metadata_path)
                except BaseException:
                    # 清理临时文件
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass
                    raise
                return True
            except IOError as e:
                logging.error(f"保存元数据文件失败: {e}")
                return False

    def _normalize_path(self, local_path: str, base_dir: str = None) -> str:
        """
        规范化路径，转换为相对路径
        
        :param local_path: 本地文件路径
        :param base_dir: 基准目录，如果提供则计算相对路径
        :return: 规范化后的路径
        """
        # 统一使用正斜杠
        path = normalize_sep(local_path)
        
        if base_dir:
            base = normalize_sep(base_dir)
            if path.startswith(base):
                path = path[len(base):].lstrip("/")
        
        return path

    def _rebuild_indexes(self) -> None:
        """从 _data 重建所有反向索引"""
        self._hash_index.clear()
        self._file_id_index.clear()
        self._dir_id_index.clear()
        for path, info in self._data.get("files", {}).items():
            fid = info.get("file_id")
            if fid:
                self._file_id_index[fid] = path
            h = info.get("content_hash")
            if h and fid:
                self._hash_index.setdefault(h, []).append(path)
        for path, info in self._data.get("directories", {}).items():
            did = info.get("dir_id")
            if did:
                self._dir_id_index[did] = path

    # ========== 文件相关方法 ==========

    def get_file_id(self, local_path: str) -> Optional[str]:
        """
        获取本地文件对应的云端 ID
        
        :param local_path: 本地文件的相对路径
        :return: 云端文件 ID，不存在则返回 None
        """
        with self._lock:
            path = self._normalize_path(local_path)
            file_info = self._data["files"].get(path)
            return file_info["file_id"] if file_info else None

    def get_file_info(self, local_path: str) -> Optional[Dict[str, Any]]:
        """
        获取本地文件的完整元数据
        
        :param local_path: 本地文件的相对路径
        :return: 文件元数据字典，不存在则返回 None
        """
        with self._lock:
            path = self._normalize_path(local_path)
            return self._data["files"].get(path)

    def set_file_info(
        self,
        local_path: str,
        file_id: str,
        cloud_mtime: int,
        local_mtime: int = None,
        parent_id: str = None,
        domain: int = None,
        content_hash: str = None,
        create_time: int = None,
        base_dir: str = None,
    ) -> None:
        """
        设置本地文件的元数据
        
        :param local_path: 本地文件的相对路径（或绝对路径）
        :param file_id: 云端文件 ID
        :param cloud_mtime: 云端修改时间（秒级时间戳）
        :param local_mtime: 本地修改时间（秒级时间戳），默认使用当前文件时间
        :param parent_id: 父目录 ID
        :param domain: 笔记类型（0=普通笔记，1=Markdown）
        :param content_hash: 文件内容的 normalized MD5
        :param create_time: 云端创建时间（秒级时间戳）
        :param base_dir: 基准目录，用于将相对路径转绝对路径以读取 mtime
        """
        if not local_path:
            raise ValueError("local_path 不能为空")
        with self._lock:
            path = self._normalize_path(local_path)
            
            # 如果没有提供本地修改时间，尝试从文件获取
            if local_mtime is None:
                if os.path.isabs(local_path):
                    full_path = local_path
                elif base_dir:
                    full_path = os.path.join(base_dir, local_path)
                else:
                    full_path = local_path
                if os.path.exists(full_path):
                    local_mtime = int(os.path.getmtime(full_path))
                else:
                    local_mtime = cloud_mtime

            old_info = self._data["files"].get(path)
            old_fid = old_info.get("file_id") if old_info else None
            old_hash = old_info.get("content_hash") if old_info else None

            self._data["files"][path] = {
                "file_id": file_id,
                "cloud_mtime": cloud_mtime,
                "local_mtime": local_mtime,
            }
            
            if parent_id is not None:
                self._data["files"][path]["parent_id"] = parent_id
            if domain is not None:
                self._data["files"][path]["domain"] = domain
            if content_hash is not None:
                self._data["files"][path]["content_hash"] = content_hash
            if create_time is not None and create_time > 0:
                self._data["files"][path]["create_time"] = create_time

            # 维护 file_id 反向索引
            if old_fid and old_fid != file_id:
                self._file_id_index.pop(old_fid, None)
            if file_id:
                self._file_id_index[file_id] = path

            # 维护 hash 反向索引
            if old_hash and old_hash != content_hash:
                lst = self._hash_index.get(old_hash)
                if lst:
                    try:
                        lst.remove(path)
                    except ValueError:
                        pass
                    if not lst:
                        del self._hash_index[old_hash]
            if content_hash and file_id:
                self._hash_index.setdefault(content_hash, [])
                if path not in self._hash_index[content_hash]:
                    self._hash_index[content_hash].append(path)

    def remove_file_info(self, local_path: str) -> None:
        """删除指定路径的文件元数据（用于文件移动后清理旧记录）。"""
        with self._lock:
            path = self._normalize_path(local_path)
            removed = self._data["files"].pop(path, None)
            if removed:
                self._remove_from_indexes(path, removed)

    def update_local_mtime(self, local_path: str, mtime: int) -> None:
        """
        更新本地文件的修改时间记录
        
        :param local_path: 本地文件的相对路径
        :param mtime: 新的修改时间
        """
        with self._lock:
            path = self._normalize_path(local_path)
            if path in self._data["files"]:
                self._data["files"][path]["local_mtime"] = mtime

    def update_cloud_mtime(self, local_path: str, mtime: int) -> None:
        """
        更新云端文件的修改时间记录
        
        :param local_path: 本地文件的相对路径
        :param mtime: 新的修改时间
        """
        with self._lock:
            path = self._normalize_path(local_path)
            if path in self._data["files"]:
                self._data["files"][path]["cloud_mtime"] = mtime

    def remove_file(self, local_path: str) -> None:
        """
        删除文件的元数据记录
        
        :param local_path: 本地文件的相对路径
        """
        with self._lock:
            path = self._normalize_path(local_path)
            removed = self._data["files"].pop(path, None)
            if removed:
                self._remove_from_indexes(path, removed)

    def _remove_from_indexes(self, path: str, info: Dict) -> None:
        """从所有反向索引中移除一个文件条目（在 _lock 内调用）。"""
        fid = info.get("file_id")
        if fid and self._file_id_index.get(fid) == path:
            del self._file_id_index[fid]
        h = info.get("content_hash")
        if h:
            lst = self._hash_index.get(h)
            if lst:
                try:
                    lst.remove(path)
                except ValueError:
                    pass
                if not lst:
                    del self._hash_index[h]

    def get_all_files(self) -> Dict[str, Dict[str, Any]]:
        """
        获取所有文件的元数据
        
        :return: 文件路径到元数据的映射
        """
        with self._lock:
            return self._data["files"].copy()

    # ========== 目录相关方法 ==========

    def get_dir_id(self, local_path: str) -> Optional[str]:
        """
        获取本地目录对应的云端 ID
        
        :param local_path: 本地目录的相对路径
        :return: 云端目录 ID，不存在则返回 None
        """
        with self._lock:
            path = self._normalize_path(local_path)
            dir_info = self._data["directories"].get(path)
            return dir_info["dir_id"] if dir_info else None

    def set_dir_info(self, local_path: str, dir_id: str, parent_id: str = None) -> None:
        """
        设置本地目录的元数据
        
        :param local_path: 本地目录的相对路径
        :param dir_id: 云端目录 ID
        :param parent_id: 父目录 ID
        """
        with self._lock:
            path = self._normalize_path(local_path)
            old_info = self._data["directories"].get(path)
            old_did = old_info.get("dir_id") if old_info else None
            if old_did and old_did != dir_id:
                self._dir_id_index.pop(old_did, None)
            self._data["directories"][path] = {"dir_id": dir_id}
            if parent_id is not None:
                self._data["directories"][path]["parent_id"] = parent_id
            self._dir_id_index[dir_id] = path

    def remove_dir(self, local_path: str) -> None:
        """
        删除目录的元数据记录
        
        :param local_path: 本地目录的相对路径
        """
        with self._lock:
            path = self._normalize_path(local_path)
            removed = self._data["directories"].pop(path, None)
            if removed:
                did = removed.get("dir_id")
                if did and self._dir_id_index.get(did) == path:
                    del self._dir_id_index[did]

    def get_all_dirs(self) -> Dict[str, Dict[str, Any]]:
        """
        获取所有目录的元数据
        
        :return: 目录路径到元数据的映射
        """
        with self._lock:
            return self._data["directories"].copy()

    # ========== 查询方法 ==========

    def find_by_file_id(self, file_id: str) -> Optional[str]:
        """
        根据云端文件 ID 查找本地路径（O(1) 反向索引）
        
        :param file_id: 云端文件 ID
        :return: 本地文件路径，不存在则返回 None
        """
        with self._lock:
            return self._file_id_index.get(file_id)

    def find_by_dir_id(self, dir_id: str) -> Optional[str]:
        """
        根据云端目录 ID 查找本地路径（O(1) 反向索引）
        
        :param dir_id: 云端目录 ID
        :return: 本地目录路径，不存在则返回 None
        """
        with self._lock:
            return self._dir_id_index.get(dir_id)

    # ========== 内容 Hash 相关 ==========

    @staticmethod
    def compute_content_hash(file_path: str) -> Optional[str]:
        """deprecated: 计划在 v4.0 移除，请使用 src.sync.utils.compute_content_hash"""
        from src.sync.utils import compute_content_hash
        return compute_content_hash(file_path)

    def update_content_hash(self, local_path: str, content_hash: str) -> None:
        """更新文件的 content_hash"""
        with self._lock:
            path = self._normalize_path(local_path)
            info = self._data["files"].get(path)
            if not info:
                return
            old_hash = info.get("content_hash")
            info["content_hash"] = content_hash
            has_fid = bool(info.get("file_id"))
            if old_hash and old_hash != content_hash:
                lst = self._hash_index.get(old_hash)
                if lst:
                    try:
                        lst.remove(path)
                    except ValueError:
                        pass
                    if not lst:
                        del self._hash_index[old_hash]
            if content_hash and has_fid:
                self._hash_index.setdefault(content_hash, [])
                if path not in self._hash_index[content_hash]:
                    self._hash_index[content_hash].append(path)

    def get_content_hash(self, local_path: str) -> Optional[str]:
        """获取文件的 content_hash"""
        with self._lock:
            path = self._normalize_path(local_path)
            info = self._data["files"].get(path)
            return info.get("content_hash") if info else None

    def find_cloud_file_by_hash(self, content_hash: str, exclude_path: str = None) -> Optional[str]:
        """
        查找是否已有相同 content_hash 的云端文件（有 file_id 的）。
        使用反向索引 hash → [paths] 实现快速查找。

        :param content_hash: 要查找的 hash
        :param exclude_path: 排除的路径（避免匹配自己）
        :return: 已存在的云端文件相对路径，没找到返回 None
        """
        with self._lock:
            if not content_hash:
                return None
            paths = self._hash_index.get(content_hash)
            if not paths:
                return None
            exclude = self._normalize_path(exclude_path) if exclude_path else None
            for p in paths:
                if exclude and p == exclude:
                    continue
                info = self._data["files"].get(p)
                if info and info.get("file_id"):
                    return p
            return None

    def find_duplicates_by_hash(self) -> Dict[str, List[str]]:
        """
        按 content_hash 分组，找出内容完全一致的文件。
        
        :return: {hash: [path1, path2, ...]} 只包含 2 个以上路径的组
        """
        with self._lock:
            hash_groups: Dict[str, List[str]] = {}
            for path, info in self._data["files"].items():
                h = info.get("content_hash")
                if h:
                    hash_groups.setdefault(h, []).append(path)
            return {h: paths for h, paths in hash_groups.items() if len(paths) > 1}
