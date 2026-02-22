import json
import logging
import os
import time
import uuid
from urllib.parse import quote as url_quote

import httpx

from src.common import get_config_directory, NoteDomain


class YoudaoNoteApi(object):
    """
    有道云笔记 API 封装
    原理：https://depp.wang/2020/06/11/how-to-find-the-api-of-a-website-eg-note-youdao-com/
    """

    ROOT_ID_URL = "https://note.youdao.com/yws/api/personal/file?method=getByPath&keyfrom=web&cstk={cstk}"
    DIR_MES_URL = (
        "https://note.youdao.com/yws/api/personal/file/{dir_id}?all=true&f=true&len={page_size}&sort=1"
        "&isReverse=false&method=listPageByParentId&keyfrom=web&cstk={cstk}"
    )
    DIR_PAGE_SIZE = 9999  # 有道云 startIndex 参数不可靠，一次全拉
    FILE_URL = (
        "https://note.youdao.com/yws/api/personal/sync?method=download&_system=macos&_systemVersion=&"
        "_screenWidth=1280&_screenHeight=800&_appName=ynote&_appuser=0123456789abcdeffedcba9876543210&"
        "_vendor=official-website&_launch=16&_firstTime=&_deviceId=0123456789abcdef&_platform=web&"
        "_cityCode=110000&_cityName=&sev=j1&keyfrom=web&cstk={cstk}"
    )
    PUSH_URL = (
        "https://note.youdao.com/yws/api/personal/sync?method=push&_system=windows&_systemVersion=&"
        "_screenWidth=1400&_screenHeight=900&_appName=ynote&_appuser=0123456789abcdeffedcba9876543210&"
        "_vendor=official-website&_launch=1&_firstTime=&_deviceId=0123456789abcdef&_platform=web&"
        "_cityCode=&_cityName=&_product=YNote-Web&_version=&sev=j1&sec=v1&keyfrom=web&cstk={cstk}"
    )
    DELETE_URL = (
        "https://note.youdao.com/yws/api/personal/file/{file_id}?method=delete&keyfrom=web&cstk={cstk}"
    )
    CREATE_DIR_URL = (
        "https://note.youdao.com/yws/api/personal/file?method=create&keyfrom=web&cstk={cstk}"
    )

    POOL_MAXSIZE = 20
    DEFAULT_TIMEOUT = httpx.Timeout(10.0, read=60.0)

    def __init__(self, cookies_path=None):
        """
        初始化
        :param cookies_path:
        """
        transport = httpx.HTTPTransport(retries=3)
        self.session = httpx.Client(
            transport=transport,
            timeout=self.DEFAULT_TIMEOUT,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/100.0.4896.88 Safari/537.36"
                ),
                "Accept": "*/*",
                "Accept-Encoding": "gzip, deflate",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "sec-ch-ua": '" Not A;Brand";v="99", "Chromium";v="100", "Google Chrome";v="100"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"macOS"',
            },
            follow_redirects=True,
        )
        self.cookies_path = (
            cookies_path
            if cookies_path
            else os.path.join(get_config_directory(), "cookies.json")
        )
        self.cstk = None

    def create_async_client(self) -> httpx.AsyncClient:
        """创建共享认证配置的异步 HTTP 客户端（用于 engine 的 async 内循环）。"""
        return httpx.AsyncClient(
            transport=httpx.AsyncHTTPTransport(retries=3),
            timeout=self.DEFAULT_TIMEOUT,
            headers=dict(self.session.headers),
            cookies=self.session.cookies,
            follow_redirects=True,
        )

    def login_by_cookies(self) -> str:
        """
        使用 Cookies 登录，其实就是设置 Session 的 Cookies
        :return: error_msg，成功返回 None
        """
        from src.cookies import CookieManager

        cookies, error = CookieManager.load(self.cookies_path)
        if error:
            return error
        if not cookies:
            return "cookies.json 中 cookies 列表为空"

        for cookie in cookies:
            if not isinstance(cookie, list) or len(cookie) < 4:
                continue
            self.session.cookies.set(
                cookie[0], cookie[1], domain=cookie[2], path=cookie[3]
            )

        # 遍历查找 YNOTE_CSTK（不假设位于第一项）
        self.cstk = None
        for cookie in cookies:
            if isinstance(cookie, list) and len(cookie) >= 2 and cookie[0] == "YNOTE_CSTK":
                self.cstk = cookie[1]
                break
        if not self.cstk:
            return "YNOTE_CSTK 字段为空"

    def http_post(self, url, data=None, files=None):
        """
        封装 post 请求（带超时和状态码检查）
        :param url:
        :param data:
        :param files:
        :return: response
        """
        resp = self.session.post(url, data=data, files=files)
        resp.raise_for_status()
        return resp

    def http_get(self, url):
        """
        封装 get 请求（带超时和状态码检查）
        :param url:
        :return: response
        """
        resp = self.session.get(url)
        resp.raise_for_status()
        return resp

    @staticmethod
    def _safe_json(response) -> dict:
        """安全解析 JSON 响应，失败时抛出明确的异常"""
        try:
            return response.json()
        except (ValueError, json.JSONDecodeError) as e:
            text = response.text[:200] if response.text else "(空)"
            raise RuntimeError(
                f"API 返回非 JSON 内容 (HTTP {response.status_code}): {text}"
            ) from e

    def _require_auth(self) -> None:
        """验证已登录（cstk 不为空），否则抛异常。所有需要认证的 API 方法应先调用此方法。"""
        if not self.cstk:
            raise RuntimeError(
                "未登录：cstk 为空。请先调用 login_by_cookies() 或运行 `python -m src login`"
            )

    def get_root_dir_info_id(self) -> dict:
        """
        获取有道云笔记根目录信息
        :return: {
            'fileEntry': {'id': 'test_root_id', 'name': 'ROOT', ...},
            ...
        }
        """
        self._require_auth()
        data = {"path": "/", "entire": "true", "purge": "false", "cstk": self.cstk}
        return self._safe_json(self.http_post(self.ROOT_ID_URL.format(cstk=self.cstk), data=data))

    def get_root_id(self) -> str:
        """
        获取根目录 ID（带缓存）。

        从 get_root_dir_info_id() 返回值中提取 ID，兼容不同 API 返回格式。
        :return: 根目录 ID 字符串
        :raises RuntimeError: 无法解析根目录 ID
        """
        if not hasattr(self, "_cached_root_id") or self._cached_root_id is None:
            root_info = self.get_root_dir_info_id()
            if "fileEntry" in root_info:
                self._cached_root_id = root_info["fileEntry"]["id"]
            elif "id" in root_info:
                self._cached_root_id = root_info["id"]
            else:
                raise RuntimeError(f"无法从 API 返回中提取根目录 ID: {list(root_info.keys())}")
        return self._cached_root_id

    def get_dir_info_by_id(self, dir_id: str) -> dict:
        """
        根据目录 ID 获取目录下所有文件信息（自动分页 + 去重）。

        有道云 API 在分页时可能返回重复条目，导致 offset 提前超过 total
        而实际有部分条目被遗漏。因此用 seen_ids 去重，并以"连续无新增"
        作为终止条件，而非仅靠 offset >= total。

        :return: {
            'count': 去重后总数,
            'entries': [所有条目（已去重）]
        }
        """
        if not dir_id:
            raise ValueError("dir_id 不能为空")
        self._require_auth()
        all_entries = []
        seen_ids: set = set()
        page_size = self.DIR_PAGE_SIZE
        offset = 0
        max_pages = 50  # 安全上限，防止死循环

        for _ in range(max_pages):
            url = self.DIR_MES_URL.format(
                dir_id=dir_id, page_size=page_size, cstk=self.cstk
            )
            if offset > 0:
                url += f"&startIndex={offset}"
            data = self._safe_json(self.http_get(url))
            entries = data.get("entries", [])
            total = data.get("count", 0)

            if not entries:
                break

            new_count = 0
            for entry in entries:
                eid = entry.get("fileEntry", {}).get("id", "")
                if eid and eid not in seen_ids:
                    seen_ids.add(eid)
                    all_entries.append(entry)
                    new_count += 1

            offset += len(entries)

            # 终止条件：本页无新条目 或 去重后已达到 total 或 返回数 < page_size
            if new_count == 0 or len(all_entries) >= total or len(entries) < page_size:
                break

        return {"count": len(all_entries), "entries": all_entries}

    def get_file_by_id(self, file_id: str):
        """
        根据文件 ID 获取文件内容
        :param file_id:
        :return: response，内容为笔记字节码
        """
        if not file_id:
            raise ValueError("file_id 不能为空")
        self._require_auth()
        data = {
            "fileId": file_id,
            "version": -1,
            "convert": "true",
            "editorType": 1,
            "cstk": self.cstk,
        }
        url = self.FILE_URL.format(cstk=self.cstk)
        return self.http_post(url, data=data)

    @staticmethod
    def generate_file_id() -> str:
        """生成新的文件 ID"""
        return "WEB" + uuid.uuid4().hex

    def push_file(
        self,
        file_id: str,
        parent_id: str,
        name: str,
        domain: int,
        body_string: str,
        create_time: int = None,
        modify_time: int = None,
        is_create: bool = False,
    ) -> dict:
        """
        上传/更新笔记
        
        :param file_id: 笔记 ID
        :param parent_id: 父目录 ID
        :param name: 文件名（如 "test.md" 或 "test.note"）
        :param domain: 笔记类型，0=普通笔记，1=Markdown
        :param body_string: 笔记内容（Markdown 为纯文本，普通笔记为 JSON）
        :param create_time: 创建时间（秒级时间戳），默认为当前时间
        :param modify_time: 修改时间（秒级时间戳），默认为当前时间
        :param is_create: 是否为新建笔记
        :return: API 响应
        """
        if not file_id:
            raise ValueError("file_id 不能为空")
        if not parent_id:
            raise ValueError("parent_id 不能为空")
        if not name:
            raise ValueError("name 不能为空")
        self._require_auth()
        now = int(time.time())
        create_time = create_time or now
        modify_time = modify_time or now

        data = {
            "fileId": file_id,
            "parentId": parent_id,
            "domain": domain,
            "rootVersion": -1,
            "sessionId": "",
            "modifyTime": modify_time,
            "bodyString": body_string,
            "transactionId": file_id,
            "transactionTime": modify_time,
            "cstk": self.cstk,
        }

        if is_create:
            data["name"] = name
            data["dir"] = "false"
            data["createTime"] = create_time
            data["req_from"] = "create"
        else:
            data["req_from"] = "save"

        # Markdown 需要额外字段
        if domain == NoteDomain.MARKDOWN:
            data["tags"] = ""
            data["resources"] = ";"
        else:
            # 普通笔记
            data["editorVersion"] = 1714445486000
            data["orgEditorType"] = 1
            # 摘要（取前 50 个字符）
            summary = body_string[:50] if len(body_string) > 50 else body_string
            data["summary"] = summary
            data["tags"] = ""

        url = self.PUSH_URL.format(cstk=self.cstk)
        response = self.http_post(url, data=data)
        return self._safe_json(response)

    def rename_file(self, file_id: str, new_name: str, domain: int = 1) -> dict:
        """
        重命名笔记
        
        :param file_id: 笔记 ID
        :param new_name: 新文件名
        :param domain: 笔记类型，0=普通笔记，1=Markdown
        :return: API 响应
        """
        if not file_id:
            raise ValueError("file_id 不能为空")
        if not new_name:
            raise ValueError("new_name 不能为空")
        self._require_auth()
        now = int(time.time())
        url = (
            f"https://note.youdao.com/yws/api/personal/sync?method=push"
            f"&name={url_quote(new_name)}"
            f"&fileId={file_id}"
            f"&domain={domain}"
            f"&rootVersion=-1"
            f"&sessionId="
            f"&modifyTime={now}"
            f"&transactionId={file_id}"
            f"&transactionTime={now}"
            f"&editorVersion=1714445486000"
            f"&tags="
            f"&keyfrom=web"
            f"&cstk={self.cstk}"
        )
        data = {"cstk": self.cstk}
        response = self.http_post(url, data=data)
        return self._safe_json(response)

    def delete_file(self, file_id: str) -> dict:
        """
        删除笔记（移到回收站）
        
        :param file_id: 笔记 ID
        :return: API 响应
        """
        if not file_id:
            raise ValueError("file_id 不能为空")
        self._require_auth()
        url = self.DELETE_URL.format(file_id=file_id, cstk=self.cstk)
        data = {"cstk": self.cstk}
        response = self.http_post(url, data=data)
        return self._safe_json(response)

    def create_dir(self, parent_id: str, name: str) -> dict:
        """
        创建目录（通过 push 接口，与创建文件共用同一个端点）
        
        如果同名目录已存在，会返回已有目录的信息而不是报错。
        
        :param parent_id: 父目录 ID
        :param name: 目录名
        :return: API 响应，包含目录的 ID（在 fileEntry.id 中）
        """
        if not parent_id:
            raise ValueError("parent_id 不能为空")
        if not name:
            raise ValueError("name 不能为空")
        self._require_auth()
        now = int(time.time())
        file_id = self.generate_file_id()
        
        data = {
            "fileId": file_id,
            "parentId": parent_id,
            "name": name,
            "dir": "true",
            "domain": 0,
            "rootVersion": -1,
            "sessionId": "",
            "createTime": now,
            "modifyTime": now,
            "transactionId": file_id,
            "transactionTime": now,
            "cstk": self.cstk,
        }
        
        url = self.PUSH_URL.format(cstk=self.cstk)
        response = self.http_post(url, data=data)
        result = self._safe_json(response)
        
        # 处理重复目录名：API 返回 error=20108 并提供已有目录的 ID
        if "error" in result and result.get("error") == "20108":
            dup_id = result.get("duplicateFileId")
            if dup_id:
                logging.info(f"目录已存在，复用: {name} (ID={dup_id})")
                return {"fileEntry": {"id": dup_id, "name": name, "dir": True}}
        
        # push 接口返回的目录信息在 entry 字段，做一层适配
        if "entry" in result and "fileEntry" not in result:
            result["fileEntry"] = result["entry"]
        
        return result

    def get_file_info(self, file_id: str) -> dict:
        """
        获取文件详细信息
        
        :param file_id: 文件 ID
        :return: 文件信息
        """
        if not file_id:
            raise ValueError("file_id 不能为空")
        self._require_auth()
        url = (
            f"https://note.youdao.com/yws/api/personal/file/{file_id}"
            f"?method=getById&keyfrom=web&cstk={self.cstk}"
        )
        data = {
            "fileId": file_id,
            "entire": "true",
            "purge": "false",
            "cstk": self.cstk,
        }
        response = self.http_post(url, data=data)
        return self._safe_json(response)
