# SOLID 原则审查报告

> **Historical (2026-03).** For current usage see the root [README](../../README.md); docs index at [docs/README.md](../README.md).


> 审查范围：`src/` 全部源码（不含 `tools/`、`test/`）
> 日期：2026-02-02
> **状态：22 个问题中 20 个已修复（见底部修复记录），2 个标为低优先级。v2 跟进审核见 `solid-audit-v2.md`。**

---

## 一、S — 单一职责原则 (Single Responsibility Principle)

> 每个类/模块应该只有一个引起它变化的原因。

### 🔴 S-1: `__main__.py` 混入浏览器登录实现

**位置**: `__main__.py` 第 249-411 行

`_refresh_cookies_if_needed`、`_try_cookie_login`、`_wait_for_browser_login`、`cmd_login` 四个函数总共 160 行，实现了完整的 Playwright 浏览器登录流程（启动浏览器、等待用户扫码、提取 Cookie、保存）。这些逻辑直接写在 CLI 入口模块中。

**问题**: CLI 入口应该只做命令分发和参数解析。浏览器登录是独立的认证策略，它的变化原因（Playwright API 升级、登录页面 URL 变更、Cookie 提取方式调整）跟 CLI 命令结构无关。

**建议**: 抽取为 `src/auth/playwright_login.py`，`cmd_login` 只调用它。

---

### 🔴 S-2: `YoudaoNoteApi` 同时负责 Cookie 解析和 HTTP 传输

**位置**: `api.py` 第 82-131 行

`login_by_cookies()` 内部调用 `_convert_cookies()` 来解析 cookies.json —— 但项目里已有独立的 `CookieManager.load()` 做同样的事。`YoudaoNoteApi` 同时承担了：

1. HTTP 会话管理（连接池、超时、线程锁）
2. Cookie 文件解析
3. 所有业务 API 调用（10+ 个端点）

**问题**: Cookie 解析逻辑重复且分散在两处（`api.py` 和 `cookies.py`）。如果 Cookie 文件格式变了，需要改两个地方。

**建议**: 删除 `_convert_cookies`，让 `login_by_cookies` 直接调用 `CookieManager.load()`。

---

### 🔴 S-3: `YoudaoNoteDownload` 是下载方向的"万能类"

**位置**: `transfer/download.py`

这个类同时负责：

| 职责 | 方法 |
|------|------|
| 单文件下载编排 | `download_file` |
| 文件类型检测 | `_download_and_detect` |
| 格式转换调度 | `_save_and_convert` → 调用 `YoudaoNoteConvert` |
| 原子写入 + 临时文件管理 | `_atomic_write` |
| 图片链接迁移 | `_migrate_images` → 创建 `ImagePull` |
| 文件时间设置 | `_set_file_time` |
| 递归下载文件夹 | `download_folder`, `_download_dir_recursively` |
| 全量导出编排 | `pull_all` |
| 文件名净化 | `_optimize_file_name` |

至少有 5 个独立的变化原因：API 下载协议变更、格式转换规则变更、文件写入策略变更、图片迁移策略变更、全量导出流程变更。

**建议**: 拆分为：
- `FileWriter` — 原子写入 + 临时文件管理
- `TypeDetector` — 下载 + 类型检测
- `PullEngine` — `pull_all` / `_download_dir_recursively`
- `YoudaoNoteDownload` — 只保留单文件下载编排

---

### 🟡 S-4: `YoudaoNoteConvert` 混合了文件 I/O 和格式转换

**位置**: `convert/note_convert.py` 第 356-482 行

三个 `convert_*_to_markdown` 静态方法都自己读文件、写文件、重命名文件。格式转换算法和磁盘操作耦合在一起。

**问题**: 如果要在内存中转换（比如给测试用），没办法不经过文件系统。

**建议**: 转换方法应该接收字符串/字节、返回字符串。文件 I/O 由调用方处理。

---

### 🟡 S-5: `image.py` 中 `ImagePull` 和 `ImageUpload` 合在一个文件

**位置**: `transfer/image.py`

`ImagePull`（从有道云下载图片到本地、改写 Markdown 链接）和 `ImageUpload`（上传到 SM.MS 图床）是完全不同的功能。一个是拉取，一个是推送，变化原因完全不同。

---

### 🟡 S-6: `SyncMetadata.compute_content_hash` 不属于元数据管理

**位置**: `sync/metadata.py` 第 321-338 行

`compute_content_hash` 是文件内容的 MD5 计算，是一个纯工具函数。它和"元数据的读/写/查询"这个职责无关。

**建议**: 移到 `sync/utils.py` 或 `common.py` 作为独立函数。

---

### 🟡 S-7: `CookieManager` 包含浏览器提取功能

**位置**: `cookies.py` 第 178-223 行

`extract_from_browser()` 导入 `browser_cookie3` 并遍历 Chrome/Edge/Firefox 提取 Cookie。这是一种独立的"获取策略"，和 Cookie 的 CRUD 管理是不同的职责。

---

### 🟡 S-8: `GUIController._search_recursively` 重复了 `YoudaoNoteSearch._search_recursively`

**位置**: `gui/controller.py` 第 141-169 行 vs `transfer/search.py` 第 102-162 行

两处实现了几乎相同的递归搜索逻辑（BFS 遍历目录树、按名称匹配、按类型过滤）。`GUIController` 有自己的 `MAX_SEARCH_DEPTH=50`，`YoudaoNoteSearch` 也有。

**问题**: 相同逻辑两份代码，一处修了 bug 另一处不会自动修复。

**建议**: `GUIController.search()` 应该委托给 `YoudaoNoteSearch`。

---

## 二、O — 开闭原则 (Open/Closed Principle)

> 对扩展开放，对修改关闭。

### 🔴 O-1: `_download_and_detect` 用 if/elif 判断文件类型

**位置**: `transfer/download.py` 第 271-294 行

```python
if youdao_file_suffix == MARKDOWN_SUFFIX:
    return FileType.MARKDOWN, None
if youdao_file_suffix in [".note", ".clip", ""]:
    # ...下载内容检测
    if content[:5] == b"<?xml":
        return FileType.XML, content
    elif content.startswith(b'{"'):
        return FileType.JSON, content
    return FileType.OTHER, content
return FileType.OTHER, None
```

如果未来有道云新增一种文件格式（比如 `.docx`），必须修改这个方法。

**建议**: 用策略字典或注册表模式：
```python
_DETECTORS: Dict[str, Callable] = {
    ".md": lambda fid, api: (FileType.MARKDOWN, None),
    ".note": _detect_note_type,
    ".clip": _detect_note_type,
    ...
}
```

---

### 🔴 O-2: `upload_file` 硬编码文件类型路由

**位置**: `transfer/upload.py` 第 63-98 行

```python
if suffix == self.MARKDOWN_SUFFIX:
    return self._upload_markdown(...)
elif suffix == self.NOTE_SUFFIX:
    logging.warning(f"跳过 .note 文件: {local_path}")
    return True, None
else:
    return self._upload_markdown(...)
```

添加对 `.note` 上传的支持或添加新类型（如 `.html`）都需要修改此方法。

---

### 🟡 O-3: `_cloud_score` 评分策略不可扩展

**位置**: `sync/dedup.py` 第 152-180 行

去重评分的三个维度（路径深度、文件名干净度、创建时间）硬编码在函数内部。如果用户想自定义保留策略（比如优先保留某个目录的文件），无法不修改源码。

**建议**: 接受一个 `score_func` 参数，默认值为当前实现。

---

### 🟡 O-4: `note_convert.py` 的 `getattr` 分发是好的 OCP 示例

**位置**: `convert/note_convert.py` 第 397-405 行

```python
convert_func = getattr(XmlElementConvert, "convert_{}_func".format(name), None)
```

这个模式允许添加新的 `convert_xxx_func` 方法而不修改分发逻辑。✅ 符合 OCP。

---

## 三、L — 里氏替换原则 (Liskov Substitution Principle)

> 子类型应该能替换父类型而不改变程序行为。

### 🟢 无继承体系，基本不适用

项目没有使用类继承层级。所有类直接继承 `object`，没有定义抽象基类或接口。

### 🟡 L-1: 隐式接口不一致

虽然没有显式继承，但多个模块通过 duck typing 依赖 `api` 参数。例如：

- `dedup.py` 的 `auto_dedup(api=...)` 只用 `api.delete_file()`
- `engine.py` 的 `SyncManager(api=...)` 用 `api.get_root_dir_info_id()`, `api.get_dir_info_by_id()`, `api.get_file_by_id()`

如果有人传入一个只实现了部分方法的 mock 对象，会在运行时报 `AttributeError` 而非在类型层面被发现。

**建议**: 使用 `typing.Protocol` 定义最小接口（见 DIP 部分）。

---

## 四、I — 接口隔离原则 (Interface Segregation Principle)

> 客户端不应该被迫依赖它不使用的接口。

### 🔴 I-1: `YoudaoNoteApi` 是一个胖接口

**位置**: `api.py` 整个类（456 行）

所有消费者都依赖整个 `YoudaoNoteApi`，但各自只需要其中一小部分：

| 消费者 | 实际用到的方法 |
|--------|---------------|
| `YoudaoNoteDownload` | `get_file_by_id`, `get_dir_info_by_id`, `http_get` |
| `YoudaoNoteUpload` | `push_file`, `create_dir`, `get_root_dir_info_id`, `generate_file_id` |
| `dedup.auto_dedup` | `delete_file` |
| `YoudaoNoteSearch` | `get_root_dir_info_id`, `get_dir_info_by_id` |
| `scanner.scan_cloud` | `get_dir_info_by_id` |
| `ImagePull` | `http_get` |

每个消费者都能看到（并可能误用）其他 9 个方法。

**建议**: 用 `Protocol` 定义角色接口：
```python
class FileReader(Protocol):
    def get_file_by_id(self, file_id: str) -> ...: ...

class DirBrowser(Protocol):
    def get_dir_info_by_id(self, dir_id: str) -> dict: ...

class FileWriter(Protocol):
    def push_file(self, ...) -> dict: ...
    def create_dir(self, ...) -> dict: ...
```

---

### 🔴 I-2: `YoudaoNoteDownload` 对 `SyncManager` 来说过于庞大

**位置**: `transfer/download.py`

`SyncManager` 只调用 `download_file(file_id, file_name, local_dir, modify_time, skip_action_check=True)`。但它依赖的 `YoudaoNoteDownload` 还包含 `pull_all`、`download_folder`、`download_by_search_result` 等 CLI 专用方法。

---

### 🟡 I-3: `SyncMetadata` 对不同消费者暴露了过多方法

各消费者的实际依赖：

| 消费者 | 用到的方法 |
|--------|-----------|
| `dedup.py` | `get_file_info`, `remove_file`, `save`, `update_content_hash` |
| `upload.py` | `get_file_info`, `set_file_info`, `get_dir_id`, `set_dir_info`, `save` |
| `decision.py` | `get_file_info`, `set_file_info`, `get_dir_id`, `set_dir_info`, `save`, `compute_content_hash` |
| `moves.py` | `get_file_info`, `set_file_info`, `remove_file_info`, `save` |

`find_duplicates_by_hash`、`find_by_file_id`、`find_by_dir_id` 等查询方法只在少数场景使用。

---

## 五、D — 依赖倒置原则 (Dependency Inversion Principle)

> 高层模块不应该依赖低层模块，两者都应该依赖抽象。

### 🔴 D-1: `SyncManager` 在构造函数中直接创建下载器和上传器

**位置**: `sync/engine.py` 第 45-56 行

```python
def __init__(self, api: YoudaoNoteApi, local_dir: str, metadata: SyncMetadata = None):
    # ...
    self.downloader = YoudaoNoteDownload(api)          # ← 直接实例化
    self.uploader = YoudaoNoteUpload(api, self.metadata) # ← 直接实例化
    self._git = GitHelper(local_dir)                     # ← 直接实例化
```

高层策略（"如何同步"）直接依赖低层实现（"怎么下载/上传/Git提交"）。要换一个不同的下载实现（如测试用的 mock），必须修改构造函数或使用 monkey-patch。

**建议**: 通过构造函数注入：
```python
def __init__(self, api, local_dir, metadata=None,
             downloader=None, uploader=None, git=None):
    self.downloader = downloader or YoudaoNoteDownload(api)
    self.uploader = uploader or YoudaoNoteUpload(api, metadata)
    self._git = git or GitHelper(local_dir)
```

---

### 🔴 D-2: 整个项目没有定义任何抽象（Protocol / ABC）

项目中所有类型提示都使用具体类名：

```python
def __init__(self, api: YoudaoNoteApi, ...):           # engine.py
def scan_cloud(api: YoudaoNoteApi, ...):               # scanner.py
def __init__(self, api: YoudaoNoteApi, metadata: SyncMetadata): # upload.py
```

没有任何 `Protocol`、`ABC`、`@abstractmethod`。这意味着：
1. 无法在不修改源码的情况下替换实现
2. 单元测试需要 mock 完整的具体类，而非轻量级的接口
3. 模块间的依赖关系是向下的（高层 → 低层），而非向抽象的

---

### 🔴 D-3: `_migrate_images` 直接实例化 `ImagePull`

**位置**: `transfer/download.py` 第 192-200 行

```python
def _migrate_images(self, ...):
    if file_type != FileType.OTHER or suffix == MARKDOWN_SUFFIX:
        image_pull = ImagePull(self.api, self.smms_secret_token, self.is_relative_path)
        image_pull.migration_ydnote_url(local_path)
```

在方法内部创建依赖对象，无法注入替代实现。

---

### 🟡 D-4: `SyncWatcher` 直接创建 `SyncManager`

**位置**: `watcher.py` 第 47 行

```python
self._sync_manager = SyncManager(api, local_dir)
```

如果想用自定义配置的 `SyncManager`（比如不同的并发数），需要修改 `SyncWatcher`。

**建议**: 接受 `sync_manager` 参数。

---

### 🟡 D-5: `dedup.py` 硬依赖 `SyncMetadata.compute_content_hash`

**位置**: `sync/dedup.py` 第 109 行

```python
h = SyncMetadata.compute_content_hash(full)
```

去重模块直接调用元数据类的静态方法来计算 hash。如果换一种 hash 算法（如 SHA-256），需要同时修改 `SyncMetadata` 和所有调用处。

**建议**: 将 hash 计算抽取为独立函数，通过参数传入或使用配置。

---

## 汇总

| 原则 | 🔴 严重 | 🟡 中等 | 🟢 良好 | 总计 |
|------|---------|---------|---------|------|
| **S** — 单一职责 | 3 | 5 | 0 | 8 |
| **O** — 开闭 | 2 | 1 | 1 | 4 |
| **L** — 里氏替换 | 0 | 1 | 1 | 2 |
| **I** — 接口隔离 | 2 | 1 | 0 | 3 |
| **D** — 依赖倒置 | 3 | 2 | 0 | 5 |
| **合计** | **10** | **10** | **2** | **22** |

### 优先修复建议

1. **S-2 + D-2**: `api.py` 删除 `_convert_cookies`，改用 `CookieManager.load()`；同时为 API 方法定义 `Protocol` 接口
2. **D-1**: `SyncManager` 支持注入 downloader/uploader/git
3. **S-3**: 拆分 `YoudaoNoteDownload` 的全量导出和单文件下载
4. **I-1**: 为 `YoudaoNoteApi` 的不同使用场景定义窄接口
5. **S-8**: 消除 `GUIController` 和 `YoudaoNoteSearch` 的搜索重复代码
6. **S-4**: `YoudaoNoteConvert` 的转换方法改为接收/返回字符串，不做文件 I/O

---

## 修复记录

> 以下修复于 2026-02-02 完成

| ID | 状态 | 修复方式 |
|----|------|----------|
| S-1 | ✅ 已修复 | 提取 `auth.py`，`cmd_login` 仅调用 `browser_login()` |
| S-2 | ✅ 已修复 | 删除 `_convert_cookies`，`login_by_cookies` 改用 `CookieManager.load()` |
| S-3 | ✅ 已修复 | 提取 `transfer/pull.py: PullEngine`；删除 `download.py` 中废弃的 `pull_all` 包装 |
| S-4 | ✅ 已修复 | 新增纯函数 `xml_bytes_to_markdown`/`json_bytes_to_markdown`/`html_string_to_markdown` |
| S-5 | ✅ 已修复 | `ImageUpload` 移至 `transfer/image_upload.py`，`image.py` 保留 re-export |
| S-6 | ✅ 已修复 | `compute_content_hash` 移至 `sync/utils.py`，`SyncMetadata` 保留委托 |
| S-7 | ✅ 已修复 | `extract_from_browser` 移至 `auth.py`，`CookieManager` 保留委托 |
| S-8 | ✅ 已修复 | `GUIController` 的重复搜索逻辑在此前已移除 |
| D-1 | ✅ 已修复 | `SyncManager.__init__` 接受可选 `downloader`/`uploader`/`git` |
| D-2 | ✅ 已修复 | 新建 `protocols.py`，定义 6 个 Protocol 接口 |
| D-3 | ✅ 已修复 | `YoudaoNoteDownload.__init__` 接受可选 `image_puller` |
| D-4 | ✅ 已修复 | `SyncWatcher.__init__` 接受可选 `sync_manager` |
| O-1 | ✅ 已修复 | `_download_and_detect` 改用 `_NEED_DOWNLOAD_EXTS` + `_CONTENT_DETECTORS` 注册表 |
| O-2 | ✅ 已修复 | `upload_file` 改用 `_UPLOAD_HANDLERS` 注册表 |
| O-3 | ✅ 已修复 | `auto_dedup`/`_resolve_group`/`_resolve_cloud_group` 接受可选 `score_func` |
| I-1 | ✅ 已修复 | `protocols.py` 中定义了 `FileReader`/`DirBrowser`/`FilePusher`/`FileDeleter`/`HttpClient`/`DownloadApi` |
| I-2 | ✅ 已修复 | `protocols.py` 新增 `SingleFileDownloader`/`Uploader`/`SyncApi`；`SyncManager` 改用窄接口 |
| I-3 | 🟡 低优先级 | `SyncMetadata` 方法虽多，但各消费者按需使用，拆分收益不大 |
| D-5 | ✅ 已修复 | `dedup.py` 已改用 `src.sync.utils.compute_content_hash`，不再直接调用 `SyncMetadata` 静态方法 |
| L-1 | 🟡 低优先级 | 保持现状，无运行时问题 |

---

## 二次审核 (2026-02-16)

> 详见 `docs/solid-audit-v2.md`

### v1 问题状态核实

v1 报告的 22 个问题，**20 个已确认修复**，2 个标记为低优先级的保持不变：

| ID | v1 状态 | 二次核实 | 备注 |
|----|---------|----------|------|
| S-1 ~ S-8 | ✅ 已修复 | ✅ 确认关闭 | |
| O-1 ~ O-3 | ✅ 已修复 | ✅ 确认关闭 | |
| D-1 ~ D-5 | ✅ 已修复 | ✅ 确认关闭 | |
| I-1, I-2 | ✅ 已修复 | ✅ 确认关闭 | |
| I-3 | 🟡 低优先级 | 🟡 维持 | 拆分收益不大 |
| L-1 | 🟡 低优先级 | ✅ 实际已被 `protocols.py` 解决 | Protocol 定义后隐式接口一致性问题消失 |

### 残留 / 修复不彻底

以下是 v1 修复中**做了但没做完**的部分：

| 关联 v1 | 残留问题 | 详见 v2 |
|---------|----------|---------|
| S-5 | `ImagePull` 自身仍身兼下载+URL 改写两个职责 | S-残留-1 |
| S-4 | `note_convert.py` 纯函数已提取，但 3 个类仍在同一个 473 行文件中 | S-残留-2 |
| D-2 | `protocols.py` 已建立，但 `scanner.py`、`watcher.py`、`upload.py` 的类型标注仍直接依赖 `YoudaoNoteApi` | D-残留-1~3 |

### v2 新增发现（v1 未覆盖的维度）

| 维度 | 严重度 | 概要 |
|------|--------|------|
| 线程安全 | 🔴 | `SyncMetadata._lock` 存在但未使用，并发写入有数据竞争风险 |
| 测试覆盖 | 🔴 | 13 个纯函数/可测试逻辑无测试（其中 5 个 P0 零 I/O 纯函数） |
| DRY | 🟡 | `MARKDOWN_SUFFIX` 重复定义；`.replace("\\", "/")` 散落 15+ 处 |
| 可变性 | 🟡 | `SyncItem` 未 frozen；`domain` 魔法数字 |
| 错误处理 | 🟡 | `except Exception` 过广；`image.py` 日志级别不准确 |
