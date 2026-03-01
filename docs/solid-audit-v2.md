# SOLID & Dev Practices 审核报告 (v2)

> 审核日期: 2026-02-16
> 审核范围: `src/` 全部模块 + `test/` 测试覆盖
> 前序报告: `docs/solid-audit.md` (2026-02-02，22 个问题中 20 个已修复)
> **状态：v2 发现的所有 P0~P3 问题已全部修复（见 §八）**

---

## 总体评价

相比 v1 审核时的状态，项目已有很大改善：`protocols.py` 接口隔离、`sync/` 子模块拆分、纯函数提取、注入式构造等问题全部已修复。本次审核发现的是**上一轮未覆盖的维度**（线程安全、测试覆盖、DRY、可变性）以及**修复不彻底的残留**。

| 维度 | 评价 |
|------|------|
| S — 单一职责 | ✅ ImagePull 拆分为 AssetDownloader + MarkdownUrlRewriter；note_convert.py 拆为 3 文件 |
| O — 开闭 | 🟢 良好 |
| L — 里氏替换 | 🟢 良好 |
| I — 接口隔离 | ✅ DownloadApi 收窄为 DownloadFileApi（下载器用）+ DownloadApi（拉取引擎用） |
| D — 依赖倒置 | ✅ scanner/watcher/upload 全部改用 Protocol 类型标注；generate_file_id 移至 common.py |
| 线程安全 | ✅ SyncMetadata 所有读写方法均已加锁 |
| 测试覆盖 | ✅ P0 + P1 共 60 个新测试，总计 131 个测试全部通过 |
| DRY | ✅ MARKDOWN_SUFFIX / normalize_sep / generate_file_id 统一到 common.py |
| 可变性 | ✅ SyncItem frozen=True；domain 魔法数字已替换为 NoteDomain 枚举 |

---

## 一、SOLID 残留问题

### S-残留-1: `ImagePull` 仍然身兼两职 — 🟡

**位置**: `transfer/image.py`

v1 的 S-5 修复了 ImageUpload 独立出去的问题，但 `ImagePull` 自身仍然同时负责：
1. **下载**图片/附件到本地 (`_download_ydnote_url`)
2. **改写** Markdown 文件中的 URL (`migration_ydnote_url`)

这两个操作的变更原因不同：下载逻辑跟网络/存储相关，URL 改写跟 Markdown 格式相关。

**建议**: 拆为 `AssetDownloader`（只负责下载返回本地路径）和 `MarkdownUrlRewriter`（负责正则匹配 + 替换），下载器可独立复用。

---

### S-残留-2: `note_convert.py` 仍是 473 行的大文件 — 🟡

**位置**: `convert/note_convert.py`

v1 的 S-4 修复了纯函数提取（`xml_bytes_to_markdown` 等），但三种转换规则类（`XmlElementConvert`、`JsonConvert`、`YoudaoNoteConvert` 文件 I/O 层）仍在同一个文件中。

**建议**: 拆为 `xml_convert.py`、`json_convert.py`、`note_convert.py`（只保留文件 I/O 适配层和纯函数入口）。

---

### D-残留-1: `scanner.py` 依赖具体类 — 🟡

**位置**: `sync/scanner.py:15`

```python
from src.api import YoudaoNoteApi
# ...
def scan_cloud(api: YoudaoNoteApi, dir_id: str, ...):
```

应改为：
```python
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from src.protocols import DirBrowser
def scan_cloud(api: "DirBrowser", dir_id: str, ...):
```

---

### D-残留-2: `watcher.py` 依赖具体类 — 🟡

**位置**: `watcher.py:16`

```python
from src.api import YoudaoNoteApi
# ...
def __init__(self, api: YoudaoNoteApi, ...):
```

v1 的 D-4 修复了 SyncManager 注入，但 `api` 参数本身的类型标注仍是具体类。

---

### D-残留-3: `upload.py` 为了 `generate_file_id()` 导入具体类 — 🟡

**位置**: `transfer/upload.py:16`

```python
from src.api import YoudaoNoteApi
```

构造函数已正确使用 `FilePusher` Protocol，但 `_push_and_record()` 中调用了 `YoudaoNoteApi.generate_file_id()` 这个静态方法，导致运行期仍依赖具体类。

**修复**: 将 `generate_file_id()` 移到 `common.py` 作为独立函数。

---

### I-改进-1: `DownloadApi` Protocol 偏宽 — 🟢 低优先级

**位置**: `protocols.py:63-68`

`DownloadApi` 包含 `get_dir_info_by_id()`，但 `YoudaoNoteDownload` 自身不调用此方法（是 `PullEngine` 用的）。可以拆为更窄的 `DownloadFileApi = FileReader + HttpClient`。

---

## 二、新发现：线程安全 — 🔴

**位置**: `sync/metadata.py`

`SyncMetadata` 在 `__init__` 中创建了 `self._lock = threading.Lock()`，但**所有公开的读写方法都没有使用这把锁**：

| 方法 | 访问模式 | 加锁? |
|------|----------|-------|
| `set_file_info()` | 写 `_data` + 写 `_hash_index` | ❌ |
| `get_file_info()` | 读 `_data` | ❌ |
| `remove_file()` | 写 `_data` + 写 `_hash_index` | ❌ |
| `find_cloud_file_by_hash()` | 读写 `_hash_index` | ❌ |
| `save()` | 读 `_data` → 写文件 | ❌ |
| `update_content_hash()` | 写 `_data` + 写 `_hash_index` | ❌ |

`SyncManager` 在多线程环境下（`ThreadPoolExecutor` 并发下载/上传）调用这些方法。虽然 `SyncManager._record_file_change()` 持有自己的 `_lock`，但只保证了 SyncManager 级别的互斥——如果 dedup 或其他路径也写 metadata，就会数据竞争。

**修复方案（选一）**:
- **方案 A**: `SyncMetadata` 所有写方法加 `with self._lock:` 保护
- **方案 B**: 文档约定"SyncMetadata 非线程安全，调用方必须自行加锁"，并删掉无用的 `_lock` 字段避免误导

---

## 三、新发现：测试覆盖 — 🔴

已有测试覆盖了核心逻辑（59 个测试），但以下纯函数/可测试逻辑**完全没有测试**：

### P0 — 纯函数，零 I/O，无需 mock

| 函数 | 所在文件 |
|------|----------|
| `map_cloud_name()` | `sync/scanner.py` |
| `normalize_filename()` | `sync/moves.py` |
| `filter_by_direction()` | `sync/utils.py` |
| `format_file_size()` | `common.py` |
| `_optimize_file_name()` | `transfer/download.py` |

这些函数逻辑简单但容易出边界错误（如空字符串、特殊字符、`.note` vs `.clip` vs 无扩展名），加几个测试用例成本极低。

### P1 — 需要临时文件/目录，但不需要网络 mock

| 函数 | 所在文件 |
|------|----------|
| `scan_local()` | `sync/scanner.py` |
| `calibrate_metadata()` | `sync/decision.py` |
| `build_item()` | `sync/decision.py` |
| `_get_file_action()` | `transfer/download.py` |
| `load_config()` | `common.py` |
| `validate()` | `cookies.py` |
| `convert_playwright_cookies()` | `cookies.py` |
| `backup_file()` | `sync/utils.py` |

---

## 四、新发现：DRY — 🟡

### 4.1 常量重复

`MARKDOWN_SUFFIX = ".md"` 分别定义在：
- `transfer/download.py:32`
- `convert/note_convert.py:7`

**修复**: 移到 `common.py`，其他模块 import。

### 4.2 路径分隔符归一化散落

`.replace("\\", "/")` 出现在至少 15 处（`scanner.py`、`upload.py`、`moves.py`、`download.py`、`pull.py`、`metadata.py`、`dedup.py` 等）。

**修复**: 提取为 `common.py` 中的 `normalize_sep(path: str) -> str`。

### 4.3 `load_config()` + 默认值处理重复

`cli.py:177-188` 和 `cmd_sync:269-273` 中几乎相同的 config 加载 + fallback 逻辑。

**修复**: 可以让 `load_config()` 直接返回一个带默认值的 Config dataclass。

---

## 五、新发现：可变性 — 🟡

### 5.1 `SyncItem` 未 frozen

**位置**: `sync/utils.py:36`

```python
@dataclass
class SyncItem:
```

`SyncItem` 创建后不应被修改（它代表一个决策快照）。改为 `@dataclass(frozen=True)` 可防止意外修改。

### 5.2 `domain` 魔法数字

`domain: int` 其中 0=普通笔记、1=Markdown，在 `api.py`、`upload.py`、`scanner.py`、`decision.py`、`utils.py` 等处以裸整数出现。

**修复**: 提取为枚举：
```python
class NoteDomain(IntEnum):
    NOTE = 0
    MARKDOWN = 1
```

---

## 六、新发现：错误处理 — 🟡

### 6.1 `except Exception` 范围过广

以下位置捕获了过于宽泛的异常：
- `download.py:133` — `download_file` 外层
- `pull.py:66` — `pull_all` 外层
- `upload.py:168` — `_push_and_record` 内部

应尽量缩窄为 `OSError`、`requests.RequestException` 等具体类型。

### 6.2 `image.py` 的日志级别不准确

`image.py:63,81,136,143` 使用 `logging.info()` 记录下载失败/错误场景。失败应该用 `logging.warning` 或 `logging.error`。

### 6.3 `\r\n` 硬编码

`note_convert.py` 中 XML/JSON 转换后的 Markdown 使用 `\r\n\r\n` 作为段落分隔（第 379、411 行），而 `compute_content_hash` 会 normalize 掉 `\r\n`。逻辑上不影响正确性，但换行约定不一致容易造成困惑。

---

## 七、向后兼容包袱 — 🟢 低优先级

- `image.py:200` — `from src.transfer.image_upload import ImageUpload  # noqa: F401`（向后兼容 re-export）
- `SyncMetadata.compute_content_hash()` — deprecated 委托方法

建议加 `# deprecated: 计划在 v4.0 移除` 注释，设定移除时间线。

---

## 八、优先级排序（全部已修复 — 2026-02-16）

| 优先级 | ID | 问题 | 状态 |
|--------|----|------|------|
| **P0** | 线程安全 | SyncMetadata 的锁未生效 | ✅ 所有读写方法已加 `with self._lock` |
| **P0** | 测试-P0 | 5 个纯函数无测试 | ✅ 30 个 P0 测试已添加 |
| **P1** | D-残留-1~3 | scanner/watcher/upload 类型标注依赖具体类 | ✅ 改用 Protocol 类型标注 |
| **P1** | 测试-P1 | 8 个可测试函数无测试 | ✅ 30 个 P1 测试已添加 |
| **P2** | DRY | MARKDOWN_SUFFIX 重复、路径归一化散落 | ✅ 统一到 common.py |
| **P2** | 可变性 | SyncItem 未 frozen、domain 魔法数字 | ✅ frozen=True + NoteDomain 枚举 |
| **P2** | S-残留-1~2 | ImagePull 双职责、note_convert.py 过长 | ✅ 拆分完成 |
| **P3** | 错误处理 | except 过广、日志级别不准确 | ✅ 已收窄 + logging.warning |
| **P3** | 向后兼容 | deprecated 方法无移除时间线 | ✅ 已添加 v4.0 移除注释 |

---

## 九、做得好的地方（延续 v1 改进后）

1. **protocols.py 接口隔离** — 从 v1 时的零 Protocol 到现在 9 个角色接口，改善巨大
2. **sync/ 子模块拆分** — engine / scanner / decision / moves / utils / dedup 职责清晰
3. **纯函数提取** — `xml_bytes_to_markdown()`、`decide_action()`、`compute_content_hash()` 等
4. **注入式设计** — `SyncManager`、`SyncWatcher`、`YoudaoNoteDownload` 都支持依赖注入
5. **原子写入** — metadata 和 download 都用 tempfile + `os.replace()` 防崩溃
6. **扩展点设计** — `_UPLOAD_HANDLERS`、`_CONTENT_DETECTORS`、`score_func` 参数
7. **前置条件校验** — `_require_auth()`、各处 `ValueError` 检查
8. **测试质量** — 已有的 59 个测试遵循 Given/When/Then，覆盖了正常路径和边界情况
