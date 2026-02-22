import logging
import os
import re
from typing import Tuple, TYPE_CHECKING
from urllib import parse
from urllib.parse import urlparse

import httpx

if TYPE_CHECKING:
    from src.protocols import HttpClient

from src.common import safe_long_path, normalize_sep

REGEX_IMAGE_URL = re.compile(r"!\[.*?\]\((.*?note\.youdao\.com.*?)\)")
REGEX_ATTACH = re.compile(r"\[(.*?)\]\(((http|https)://note\.youdao\.com.*?)\)")
# 有道云笔记的图片地址
IMAGES = "images"
# 有道云笔记的附件地址
ATTACH = "attachments"


def _url_encode(file_path: str) -> str:
    """对一些特殊字符url编码"""
    return file_path.replace(" ", "%20")


class AssetDownloader:
    """从有道云下载图片/附件到本地文件"""

    def __init__(self, api: "HttpClient"):
        self.api = api

    def download(self, file_path: str, url: str, attach_name: str = None) -> str:
        """下载 URL 到本地，返回本地路径。失败返回空字符串。"""
        try:
            response = self.api.http_get(url)
        except (httpx.ProxyError, httpx.ConnectError) as err:
            error_msg = "网络错误，「{}」下载失败。错误提示：{}".format(url, format(err))
            logging.warning(error_msg)
            return ""

        content_type = response.headers.get("Content-Type")
        file_type = "附件" if attach_name else "图片"
        if response.status_code != 200 or not content_type:
            error_msg = "下载「{}」失败！{}可能已失效，可浏览器登录有道云笔记后，查看{}是否能正常加载".format(
                url, file_type, file_type
            )
            logging.warning(error_msg)
            return ""

        if attach_name:
            file_dirname = ATTACH
            file_suffix = attach_name
        else:
            file_dirname = IMAGES
            content_type_arr = content_type.split("/")
            file_suffix = (
                "." + content_type_arr[1].replace(";", "")
                if len(content_type_arr) == 2
                else "jpg"
            )

        file_dir = os.path.dirname(file_path)
        if not file_dir:
            file_dir = "."
        local_file_dir = normalize_sep(os.path.join(file_dir, file_dirname))

        if not os.path.exists(local_file_dir):
            os.mkdir(local_file_dir)
        file_basename = os.path.basename(urlparse(url).path)

        realUrl = parse.parse_qs(urlparse(response.url).query)
        if realUrl:
            fn_list = realUrl.get("filename") or realUrl.get("download") or []
            filename = fn_list[0] if fn_list else ""
            file_name = file_basename + filename
        else:
            file_name = "".join([file_basename, file_suffix])
        local_file_path = normalize_sep(os.path.join(local_file_dir, file_name))
        local_file_path = safe_long_path(local_file_path)

        try:
            with open(local_file_path, "wb") as f:
                f.write(response.content)
            logging.info("已将{}「{}」转换为「{}」".format(file_type, url, local_file_path))
        except Exception as e:
            error_msg = "{} {}有误！错误: {}".format(url, file_type, e)
            logging.warning(error_msg)
            return ""

        return local_file_path


class MarkdownUrlRewriter:
    """改写 Markdown 文件中的有道云图片/附件 URL"""

    def __init__(
        self,
        asset_downloader: AssetDownloader,
        smms_secret_token: str = "",
        is_relative_path: bool = True,
    ):
        self.downloader = asset_downloader
        self.smms_secret_token = smms_secret_token
        self.is_relative_path = is_relative_path

    def rewrite(self, file_path: str) -> None:
        """改写文件中的有道云 URL。"""
        if not file_path:
            raise ValueError("file_path 不能为空")

        with open(file_path, "rb") as f:
            content = f.read().decode("utf-8")

        # 图片
        image_urls = REGEX_IMAGE_URL.findall(content)
        if len(image_urls) > 0:
            logging.info("正在转换有道云笔记「{}」中的有道云图片链接...".format(file_path))
        for image_url in image_urls:
            try:
                image_path = self._get_new_image_path(file_path, image_url)
            except Exception as error:
                logging.warning(
                    "下载图片「{}」可能失败！请检查图片！错误提示：{}".format(
                        image_url, format(error)
                    )
                )
                continue
            if image_url == image_path:
                continue
            if self.is_relative_path and not self.smms_secret_token:
                idx = image_path.find(IMAGES)
                if idx >= 0:
                    image_path = image_path[idx:]
            image_path = _url_encode(image_path)
            content = content.replace(image_url, image_path)

        # 附件
        attach_name_and_url_list = REGEX_ATTACH.findall(content)
        if len(attach_name_and_url_list) > 0:
            logging.info("正在转换有道云笔记「{}」中的有道云附件链接...".format(file_path))
        for attach_name_and_url in attach_name_and_url_list:
            attach_url = attach_name_and_url[1]
            attach_path = self.downloader.download(
                file_path, attach_url, attach_name_and_url[0]
            )
            if not attach_path:
                continue
            if self.is_relative_path:
                idx = attach_path.find(ATTACH)
                if idx >= 0:
                    attach_path = attach_path[idx:]
            content = content.replace(attach_url, attach_path)

        with open(file_path, "wb") as f:
            f.write(content.encode())

    def _get_new_image_path(self, file_path: str, image_url: str) -> str:
        """将图片链接转换为新的链接（SM.MS 或本地路径）"""
        if not self.smms_secret_token:
            image_path = self.downloader.download(file_path, image_url)
            return image_path or image_url

        from src.transfer.image_upload import ImageUpload

        new_file_url, error_msg = ImageUpload.upload_to_smms(
            youdaonote_api=self.downloader.api,
            image_url=image_url,
            smms_secret_token=self.smms_secret_token,
        )
        if not error_msg:
            return new_file_url
        logging.warning(error_msg)
        image_path = self.downloader.download(file_path, image_url)
        return image_path or image_url


class ImagePull:
    """向后兼容的 facade，组合 AssetDownloader + MarkdownUrlRewriter。

    deprecated: 计划在 v4.0 移除，请直接使用 AssetDownloader / MarkdownUrlRewriter
    """

    def __init__(
        self,
        youdaonote_api: "HttpClient",
        smms_secret_token: str,
        is_relative_path: bool,
    ):
        self._downloader = AssetDownloader(youdaonote_api)
        self._rewriter = MarkdownUrlRewriter(
            self._downloader, smms_secret_token, is_relative_path
        )

    def migration_ydnote_url(self, file_path: str) -> None:
        self._rewriter.rewrite(file_path)


# deprecated: 计划在 v4.0 移除，请直接 import src.transfer.image_upload
from src.transfer.image_upload import ImageUpload  # noqa: F401
