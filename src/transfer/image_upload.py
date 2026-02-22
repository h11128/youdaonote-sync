"""
图片上传到外部图床（SM.MS）

从 image.py 提取而来，保持单一职责。
"""

import logging
from typing import Tuple

import httpx


class ImageUpload:
    """图片上传到指定图床"""

    @staticmethod
    def upload_to_smms(youdaonote_api, image_url, smms_secret_token) -> Tuple[str, str]:
        """
        上传图片到 sm.ms

        :param youdaonote_api: API 实例（用于下载原图）
        :param image_url: 图片 URL（不能为空）
        :param smms_secret_token: SM.MS API token（不能为空）
        :return: (新 url, error_msg)
        """
        if not image_url:
            raise ValueError("image_url 不能为空")
        if not smms_secret_token:
            raise ValueError("smms_secret_token 不能为空")
        try:
            smfile = youdaonote_api.http_get(image_url).content
        except Exception as e:
            error_msg = "下载「{}」失败！图片可能已失效: {}".format(image_url, e)
            return "", error_msg
        files = {"smfile": smfile}
        upload_api_url = "https://sm.ms/api/v2/upload"
        headers = {"Authorization": smms_secret_token}

        error_msg = (
            "SM.MS 免费版每分钟限额 20 张图片，每小时限额 100 张图片，大小限制 5 M，上传失败！「{}」未转换，"
            "将下载图片到本地".format(image_url)
        )
        try:
            res_json = httpx.post(
                upload_api_url, headers=headers, files=files,
                timeout=5.0, follow_redirects=True,
            ).json()
        except httpx.ProxyError as err:
            error_msg = "网络错误，上传「{}」到 SM.MS 失败！将下载图片到本地。错误提示：{}".format(
                image_url, format(err)
            )
            return "", error_msg
        except Exception:
            return "", error_msg

        if res_json.get("success"):
            url = res_json["data"]["url"]
            logging.info("已将图片「{}」转换为「{}」".format(image_url, url))
            return url, ""
        if res_json.get("code") == "image_repeated":
            url = res_json["images"]
            logging.info("已将图片「{}」转换为「{}」".format(image_url, url))
            return url, ""
        if res_json.get("code") == "flood":
            return "", error_msg

        error_msg = (
            "上传「{}」到 SM.MS 失败，请检查图片 url 或 smms_secret_token（{}）是否正确！将下载图片到本地".format(
                image_url, smms_secret_token
            )
        )
        return "", error_msg
