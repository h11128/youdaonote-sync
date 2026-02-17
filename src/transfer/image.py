import logging
import os
import re
from typing import Tuple, TYPE_CHECKING
from urllib import parse
from urllib.parse import urlparse

import requests

if TYPE_CHECKING:
    from src.protocols import HttpClient

from src.common import safe_long_path

REGEX_IMAGE_URL = re.compile(r"!\[.*?\]\((.*?note\.youdao\.com.*?)\)")
REGEX_ATTACH = re.compile(r"\[(.*?)\]\(((http|https)://note\.youdao\.com.*?)\)")
# 有道云笔记的图片地址
IMAGES = "images"
# 有道云笔记的附件地址
ATTACH = "attachments"


class ImagePull:
    def __init__(
        self,
        youdaonote_api: "HttpClient",
        smms_secret_token: str,
        is_relative_path: bool,
    ):
        self.youdaonote_api = youdaonote_api
        self.smms_secret_token = smms_secret_token
        self.is_relative_path = is_relative_path

    @classmethod
    def _url_encode(cls, file_path: str):
        """对一些特殊字符url编码
        :param file_path:
        """
        file_path = file_path.replace(" ", "%20")
        return file_path

    def migration_ydnote_url(self, file_path):
        """
        迁移有道云笔记文件 URL
        :param file_path: 本地文件路径（不能为空）
        :return:
        """
        if not file_path:
            raise ValueError("file_path 不能为空")

        # 文件内容为空，也下载到本地
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
                logging.info(
                    "下载图片「{}」可能失败！请检查图片！错误提示：{}".format(image_url, format(error))
                )
            if image_url == image_path:
                continue
            # 将绝对路径替换为相对路径，实现满足 Obsidian 格式要求
            # 将 image_path 路径中 images 之前的路径去掉，只保留以 images 开头的之后的路径
            if self.is_relative_path and not self.smms_secret_token:
                idx = image_path.find(IMAGES)
                if idx >= 0:
                    image_path = image_path[idx:]

            image_path = self._url_encode(image_path)
            content = content.replace(image_url, image_path)

        # 附件
        attach_name_and_url_list = REGEX_ATTACH.findall(content)
        if len(attach_name_and_url_list) > 0:
            logging.info("正在转换有道云笔记「{}」中的有道云附件链接...".format(file_path))
        for attach_name_and_url in attach_name_and_url_list:
            attach_url = attach_name_and_url[1]
            attach_path = self._download_ydnote_url(
                file_path, attach_url, attach_name_and_url[0]
            )
            if not attach_path:
                continue
            # 将 attach_path 路径中 attachments 之前的路径去掉，只保留以 attachments 开头的之后的路径
            if self.is_relative_path:
                idx = attach_path.find(ATTACH)
                if idx >= 0:
                    attach_path = attach_path[idx:]
            content = content.replace(attach_url, attach_path)

        with open(file_path, "wb") as f:
            f.write(content.encode())
        return

    def _get_new_image_path(self, file_path, image_url) -> str:
        """
        将图片链接转换为新的链接
        :param file_path:
        :param image_url:
        :return: new_image_path
        """
        # 当 smms_secret_token 为空（不上传到 SM.MS），下载到图片到本地
        if not self.smms_secret_token:
            image_path = self._download_ydnote_url(file_path, image_url)
            return image_path or image_url

        # smms_secret_token 不为空，上传到 SM.MS
        new_file_url, error_msg = ImageUpload.upload_to_smms(
            youdaonote_api=self.youdaonote_api,
            image_url=image_url,
            smms_secret_token=self.smms_secret_token,
        )
        # 如果上传失败，仍下载到本地
        if not error_msg:
            return new_file_url
        logging.info(error_msg)
        image_path = self._download_ydnote_url(file_path, image_url)
        return image_path or image_url

    def _download_ydnote_url(self, file_path, url, attach_name=None) -> str:
        """
        下载文件到本地，返回本地路径
        :param file_path:
        :param url:
        :param attach_name:
        :return:  path
        """
        try:
            response = self.youdaonote_api.http_get(url)
        except requests.exceptions.ProxyError as err:
            error_msg = "网络错误，「{}」下载失败。错误提示：{}".format(url, format(err))
            logging.info(error_msg)
            return ""

        content_type = response.headers.get("Content-Type")
        file_type = "附件" if attach_name else "图片"
        if response.status_code != 200 or not content_type:
            error_msg = "下载「{}」失败！{}可能已失效，可浏览器登录有道云笔记后，查看{}是否能正常加载".format(
                url, file_type, file_type
            )
            logging.info(error_msg)
            return ""

        if attach_name:
            # 默认下载附件到 attachments 文件夹
            file_dirname = ATTACH
            file_suffix = attach_name
        else:
            # 默认下载图片到 images 文件夹
            file_dirname = IMAGES
            # 后缀 png 和 jpeg 后可能出现 ; `**.png;`, 原因未知
            content_type_arr = content_type.split("/")
            file_suffix = (
                "." + content_type_arr[1].replace(";", "")
                if len(content_type_arr) == 2
                else "jpg"
            )

        # 在笔记文件所在目录下创建图片/附件子目录
        file_dir = os.path.dirname(file_path)
        if not file_dir:
            file_dir = "."
        local_file_dir = os.path.join(file_dir, file_dirname).replace("\\", "/")

        if not os.path.exists(local_file_dir):
            os.mkdir(local_file_dir)
        file_basename = os.path.basename(urlparse(url).path)

        # 请求后的真实的 URL 中才有东西
        realUrl = parse.parse_qs(urlparse(response.url).query)

        if realUrl:
            fn_list = realUrl.get("filename") or realUrl.get("download") or []
            filename = fn_list[0] if fn_list else ""
            file_name = file_basename + filename
        else:
            file_name = "".join([file_basename, file_suffix])
        local_file_path = os.path.join(local_file_dir, file_name).replace("\\", "/")
        local_file_path = safe_long_path(local_file_path)

        try:
            with open(local_file_path, "wb") as f:
                f.write(response.content)  # response.content 本身就为字节类型
            logging.info("已将{}「{}」转换为「{}」".format(file_type, url, local_file_path))
        except Exception as e:
            error_msg = "{} {}有误！错误: {}".format(url, file_type, e)
            logging.warning(error_msg)
            return ""

        return local_file_path



# 向后兼容：ImageUpload 已移至 image_upload.py
from src.transfer.image_upload import ImageUpload  # noqa: F401
