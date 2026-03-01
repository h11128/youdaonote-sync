# 有道云笔记私有 API 分析

> 分析日期：2026-02-14
> 当前状态：项目已基于此分析完成完整的双向同步实现，HTTP 客户端从 requests 迁移到 httpx

通过 Playwright 抓包分析得出的有道云笔记私有 API 接口文档。

## 认证方式

**不需要 OAuth**，使用 Cookie + CSRF Token (cstk) 认证：
- Cookie: 从浏览器登录状态获取
- cstk: CSRF token，从 cookie 中的 `YNOTE_CSTK` 字段获取

## 核心 API

### 1. 创建/保存笔记 (Push)

**Endpoint:** `POST https://note.youdao.com/yws/api/personal/sync?method=push`

**Content-Type:** `application/x-www-form-urlencoded;charset=UTF-8`

#### 参数说明

| 参数 | 类型 | 必填 | 说明 |
|-----|------|-----|------|
| fileId | string | 是 | 笔记 ID，新建时格式为 `WEB` + 32位随机hex |
| parentId | string | 是 | 父目录 ID |
| name | string | 是 | 文件名（URL 编码），如 `测试.note` 或 `测试.md` |
| domain | int | 是 | 笔记类型：`0` = 普通笔记(.note)，`1` = Markdown(.md) |
| rootVersion | int | 是 | 根版本，新建时为 `-1` |
| sessionId | string | 否 | 会话 ID，可为空 |
| dir | bool | 否 | 是否为目录，默认 false |
| createTime | timestamp | 是 | 创建时间（秒级时间戳） |
| modifyTime | timestamp | 是 | 修改时间（秒级时间戳） |
| bodyString | string | 是 | 笔记内容（见下文格式说明） |
| transactionId | string | 是 | 事务 ID，通常与 fileId 相同 |
| transactionTime | timestamp | 是 | 事务时间 |
| cstk | string | 是 | CSRF token |
| req_from | string | 否 | 请求来源：`create`（新建）或 `save`（保存） |
| editorVersion | timestamp | 否 | 编辑器版本 |
| orgEditorType | int | 否 | 原始编辑器类型 |
| summary | string | 否 | 摘要（普通笔记） |
| tags | string | 否 | 标签 |
| resources | string | 否 | 资源列表（Markdown），格式如 `;` |

#### bodyString 格式

**Markdown 笔记 (domain=1):**
直接是 Markdown 纯文本内容（URL 编码）

```
bodyString=阿迪斯发斯蒂芬%0A
```

**普通笔记 (domain=0):**
JSON 格式的富文本结构（URL 编码）

```json
{
  "2": "1",
  "3": "Ju9C-1621846617594",  // 文档 ID
  "4": {
    "version": 1,
    "incompatibleVersion": 0,
    "fv": "0"
  },
  "5": [  // 段落数组
    {
      "3": "3060-1621846615933",  // 段落 ID
      "5": [  // 内容块数组
        {
          "2": "2",  // 类型
          "3": "p5PQ-1621846617594",  // 块 ID
          "7": [  // 文本内容
            {"8": "文本内容"}
          ]
        }
      ]
    }
  ],
  "title": "",
  "__compress__": true
}
```

### 2. 重命名笔记

**Endpoint:** `POST https://note.youdao.com/yws/api/personal/sync?method=push&name=新名称.note&fileId=xxx`

只在 URL 参数中传 `name` 和 `fileId`，POST body 只需要 `cstk`。

### 3. 下载笔记 (已有)

**Endpoint:** `POST https://note.youdao.com/yws/api/personal/sync?method=download`

#### 参数
| 参数 | 类型 | 必填 | 说明 |
|-----|------|-----|------|
| fileId | string | 是 | 笔记 ID |
| version | int | 是 | 版本号，`-1` 表示最新 |
| convert | bool | 否 | 是否转换格式 |
| editorVersion | timestamp | 否 | 编辑器版本 |
| editorType | int | 否 | 编辑器类型 |
| read | bool | 否 | Markdown 用 |
| cstk | string | 是 | CSRF token |

### 4. 获取文件信息

**Endpoint:** `POST https://note.youdao.com/yws/api/personal/file/{fileId}?method=getById`

#### 参数
| 参数 | 类型 | 必填 | 说明 |
|-----|------|-----|------|
| fileId | string | 是 | 笔记 ID |
| entire | bool | 是 | 是否获取完整信息 |
| purge | bool | 是 | 是否清除缓存 |
| cstk | string | 是 | CSRF token |

### 5. 获取目录列表

**Endpoint:** `POST https://note.youdao.com/yws/api/personal/file?method=getByPath`

#### 参数
| 参数 | 类型 | 必填 | 说明 |
|-----|------|-----|------|
| path | string | 是 | 路径，根目录为 `/` |
| entire | bool | 是 | 是否获取完整信息 |
| purge | bool | 是 | 是否清除缓存 |
| cstk | string | 是 | CSRF token |

## 公共 URL 参数

大部分请求都带有以下 URL 参数（可选，用于统计）：

```
_system=windows
_systemVersion=
_screenWidth=1400
_screenHeight=900
_appName=ynote
_appuser=2a432cca707eed888b67c7b024e352d1
_vendor=official-website
_launch=57
_firstTime=2026/02/14%2000:47:16
_deviceId=2a432cca707eed88
_platform=web
_cityCode=
_cityName=
_product=YNote-Web
_version=
sev=j1
sec=v1
keyfrom=web
```

## 关键发现

1. **Markdown 上传很简单**：`bodyString` 直接是纯文本内容
2. **普通笔记复杂**：需要构造 JSON 富文本结构
3. **不需要 OAuth**：Cookie + cstk 即可认证
4. **fileId 生成规则**：`WEB` + 32位小写hex（如 `WEB1802560508b3cc057ffce159594cc0e6`）

## 实现状态

> 以下建议在项目迭代过程中已全部实现。

| 建议 | 状态 | 说明 |
|------|------|------|
| Markdown 同步 | ✅ 已实现 | `transfer/upload.py` — bodyString 直接传纯文本 |
| 普通笔记上传 | ✅ 已实现 | `convert/md_to_note.py` — Markdown → 有道 JSON 格式转换 |
| 双向同步 | ✅ 已实现 | `sync/engine.py` — 完整的双向同步引擎 |
| 二进制文件上传 | ✅ 已实现 | `api.py` — `push_binary_file()` multipart 上传 |

## 示例代码

```python
import httpx
import time
import uuid

def create_markdown_note(client: httpx.Client, cstk, parent_id, name, content):
    """创建 Markdown 笔记"""
    file_id = 'WEB' + uuid.uuid4().hex
    now = int(time.time())

    url = f"https://note.youdao.com/yws/api/personal/sync?method=push&cstk={cstk}"

    data = {
        'fileId': file_id,
        'parentId': parent_id,
        'name': f'{name}.md',
        'domain': 1,  # Markdown
        'rootVersion': -1,
        'sessionId': '',
        'dir': 'false',
        'createTime': now,
        'modifyTime': now,
        'bodyString': content,
        'transactionId': file_id,
        'transactionTime': now,
        'cstk': cstk,
    }

    response = client.post(url, data=data)
    return response.json()
```
