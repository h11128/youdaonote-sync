"""
角色接口定义（Protocol）

为各模块的不同消费者定义最小化接口，
实现接口隔离（ISP）和依赖倒置（DIP）。

具体类（YoudaoNoteApi / YoudaoNoteDownload / YoudaoNoteUpload）
隐式满足对应的 Protocol，无需显式继承。
"""

from typing import Any, Optional, Protocol, Tuple, runtime_checkable


@runtime_checkable
class FileReader(Protocol):
    """读取文件内容（下载）"""

    def get_file_by_id(self, file_id: str) -> Any: ...


@runtime_checkable
class DirBrowser(Protocol):
    """浏览目录结构"""

    def get_root_dir_info_id(self) -> dict: ...
    def get_dir_info_by_id(self, dir_id: str) -> dict: ...


@runtime_checkable
class FilePusher(Protocol):
    """上传/创建文件和目录"""

    def get_root_id(self) -> str: ...
    def push_file(
        self,
        file_id: str,
        parent_id: str,
        name: str,
        domain: int,
        body_string: str,
        create_time: int = ...,
        modify_time: int = ...,
        is_create: bool = ...,
    ) -> dict: ...
    def push_binary_file(
        self,
        file_id: str,
        parent_id: str,
        name: str,
        file_bytes: bytes,
        create_time: int = ...,
        modify_time: int = ...,
        is_create: bool = ...,
    ) -> dict: ...
    def create_dir(self, parent_id: str, name: str) -> dict: ...


@runtime_checkable
class FileDeleter(Protocol):
    """删除文件"""

    def delete_file(self, file_id: str) -> dict: ...


@runtime_checkable
class HttpClient(Protocol):
    """HTTP 请求（用于图片/附件下载和 API 调用）"""

    def http_get(self, url: str) -> Any: ...
    def http_post(self, url: str, data: Any = ...) -> Any: ...


@runtime_checkable
class DownloadFileApi(Protocol):
    """YoudaoNoteDownload 所需的 API 子集（下载文件 + HTTP 图片拉取）"""

    def get_file_by_id(self, file_id: str) -> Any: ...
    def http_get(self, url: str) -> Any: ...


@runtime_checkable
class DownloadApi(Protocol):
    """PullEngine 所需的 API 子集（DownloadFileApi + 目录浏览）"""

    def get_file_by_id(self, file_id: str) -> Any: ...
    def get_dir_info_by_id(self, dir_id: str) -> dict: ...
    def get_root_dir_info_id(self) -> dict: ...
    def http_get(self, url: str) -> Any: ...


# ---- SyncManager 依赖的窄接口 (I-2) ----

@runtime_checkable
class SingleFileDownloader(Protocol):
    """SyncManager 只需要的下载能力：单文件下载"""

    def download_file(
        self,
        file_id: str,
        file_name: str,
        local_dir: str,
        modify_time: int = ...,
        create_time: int = ...,
        convert_to_md: bool = ...,
        skip_action_check: bool = ...,
    ) -> bool: ...


@runtime_checkable
class Uploader(Protocol):
    """SyncManager 只需要的上传能力"""

    def upload_file(
        self,
        local_path: str,
        parent_id: str,
        rel_path: str = ...,
        force: bool = ...,
    ) -> Tuple[bool, Optional[str]]: ...

    def ensure_cloud_dir(
        self, dir_name: str, parent_id: str, relative_path: str,
        defer_save: bool = ...,
    ) -> Optional[str]: ...

    def ensure_parent_dir(self, rel_path: str) -> Optional[str]: ...


@runtime_checkable
class SyncApi(Protocol):
    """SyncManager 只需要的 API 能力"""

    DIR_MES_URL: str
    DIR_PAGE_SIZE: int
    cstk: Optional[str]

    def get_root_id(self) -> str: ...
    def get_file_by_id(self, file_id: str) -> Any: ...
    def delete_file(self, file_id: str) -> dict: ...
    def move_file(self, file_id: str, new_parent_id: str, domain: int = 1) -> dict: ...
    def rename_file(self, file_id: str, new_name: str, domain: int = 1) -> dict: ...
    def create_async_client(self) -> Any: ...
