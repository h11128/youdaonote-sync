# 重构设计：同步扫描缓存 + 云端格式保持

> 版本: v2.0 | 日期: 2026-02-22  
> v1→v2 变更: 发现 `sync_metadata.db` 已缓存完整目录树但未被 scanner 复用，重新设计架构
>
> **实施状态：Phase 1~4 全部完成（2026-02-28）**

## 1. 背景与动机

当前同步引擎每次运行都从零开始做完整的 HTTP 扫描：

| 操作 | API 调用 | 耗时占比 | 失败风险 |
|------|----------|----------|----------|
| 扫描云端目录树 | 递归 `list_dir` (163 个目录，每个 1 次 HTTP) | ~60% | session 过期、限流 |
| 下载 .note 文件内容 | `get_file_by_id` + XML→MD 转换 | ~30% | 同上 |
| 上传/删除/创建目录 | POST 各接口 | ~10% | 同上 |

**但 `sync_metadata.db` 已经在每次同步后缓存了完整的 files + directories 表。** Scanner 完全没有利用这个缓存，每次都重新扫描。

此外还有两个扩展目标：
- 有道桌面客户端的本地数据可作为可选的额外加速层
- domain=0 (XML) 笔记编辑后上传应保持云端 XML 格式不变

## 2. 收益评估

### 缓存命中时（最常见场景：没有变化或少量变化）

| 场景 | 当前 | 重构后 | 改善 |
|------|------|--------|------|
| 扫描 3225 文件 + 163 目录 | 163 次 HTTP | 1 次 `listRecent` 检查 + 读 SQLite | **API 调用 -99%** |
| 无变化时的总耗时 | ~30-60 秒 (全量扫描) | <1 秒 (缓存命中) | **速度 30-60x** |

### 缓存过期时（有变化）

| 变化量 | 策略 | API 调用 |
|--------|------|----------|
| ≤30 个文件变化 | `listRecent` 增量更新缓存 | 1 次 HTTP |
| >30 个文件变化 | 全量 HTTP 重扫 | 163 次（与当前相同） |

### 桌面客户端数据（可选加速）

| 场景 | 改善 |
|------|------|
| 首次运行（sync_metadata.db 为空） | 桌面客户端 SQLite 可作为冷启动种子 |
| domain=0 文件下载 | 桌面客户端 file/ 缓存可替代 HTTP 下载 |

## 3. 架构设计

### 3.1 当前架构（问题所在）

```
_async_collect_items():
  async_scan_cloud() ──── 163 次 HTTP ──── 构建 cloud_files
  scan_local()       ──── 本地磁盘    ──── 构建 local_files
  calibrate_metadata() ← 读 sync_metadata.db
  reconcile_moves()
  build_item() → decide_action()

_async_execute_all():
  _do_download() / _do_upload() → 更新 sync_metadata.db
                                          ↑
                              下次同步完全不复用这个结果
```

### 3.2 重构后架构

```
_async_collect_items():
  ┌─ cloud_files = _get_cloud_files():
  │    1. 读 sync_metadata.db 缓存的 files + directories
  │    2. 调 listRecent (1 次 HTTP) 获取云端最新 version
  │    3. 缓存新鲜？
  │       ├── YES → 直接用缓存
  │       ├── ≤30 变化 → 增量更新缓存
  │       └── >30 变化或首次运行 → 全量 HTTP 扫描 → 写入缓存
  │    4. (可选) 桌面客户端数据作为冷启动种子
  │
  ├─ scan_local() ──── 不变
  ├─ calibrate_metadata()
  ├─ reconcile_moves()
  └─ build_item() → decide_action()

_async_execute_all():
  _do_download():
    ├─ [可选] 桌面客户端 file/ 缓存 (domain=0)
    └─ [fallback] HTTP get_file_by_id
  _do_upload():
    ├─ domain=0 且 original_domain=0 → MD→XML 转换 → HTTP upload
    └─ domain=1 或新建 → 原样 HTTP upload
```

### 3.3 缓存失效与增量更新

这是整个重构的核心机制，当前完全缺失。

#### sync_metadata.db 新增字段

```sql
-- 在 _migrations 中追加
ALTER TABLE files ADD COLUMN cloud_version INTEGER DEFAULT 0;

-- 新增 sync_state 表：存储全局同步状态
CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- 存储：last_cloud_version, last_scan_time, scan_mode
```

#### 版本检查流程

```python
def _get_cloud_files(self) -> Dict[str, Dict]:
    """获取云端文件列表，优先使用缓存。"""
    cached_version = self.metadata.get_state("last_cloud_version") or 0
    cached_time = self.metadata.get_state("last_scan_time") or 0

    # 1. 用 listRecent 探测云端最新状态 (1 次 HTTP)
    recent = self.api.list_recent(limit=30)
    cloud_max_version = max(e["version"] for e in recent) if recent else 0

    # 2. 判断缓存是否新鲜
    if cached_version >= cloud_max_version and cached_version > 0:
        return self._load_cloud_files_from_cache()

    # 3. 增量更新：recent 中 version > cached_version 的条目
    changed = [e for e in recent if e["version"] > cached_version]
    if len(changed) < len(recent):
        # recent 包含了所有变化 → 增量更新缓存
        self._apply_incremental_changes(changed)
        self.metadata.set_state("last_cloud_version", cloud_max_version)
        return self._load_cloud_files_from_cache()

    # 4. 变化量超过 recent 上限 → 全量重扫
    cloud_files = await async_scan_cloud(...)
    self._save_cloud_files_to_cache(cloud_files, cloud_max_version)
    return cloud_files
```

#### 增量更新的处理

```python
def _apply_incremental_changes(self, changed_entries: list):
    """将变更条目应用到缓存。"""
    for entry in changed_entries:
        fe = entry["fileEntry"]
        # 更新或新增文件记录
        # 注意：deleted 的文件需要从缓存中移除
        if fe.get("del") or fe.get("entryStatus") == "delete":
            self.metadata.remove_file_info(...)
        else:
            self.metadata.set_file_info(...)
```

**关键限制**：`listRecent` 最多返回 30 条。如果两次同步之间有超过 30 个文件变化，就无法确定完整的变更集，必须做全量重扫。实际使用中，日常变化通常 <10 个文件，30 的上限足够。

## 4. 关键设计细节

### 4.1 缓存→cloud_files 格式转换

`sync_metadata.db` 的 `files` 表和 scanner 返回的 `cloud_files` 字典格式不同，需要一个转换层：

```python
def _load_cloud_files_from_cache(self) -> Dict[str, Dict]:
    """从 sync_metadata.db 重建 cloud_files 字典。"""
    all_files = self.metadata.get_all_files()
    all_dirs = self.metadata.get_all_dirs()
    cloud_files = {}
    for path, info in all_files.items():
        if not info.get("file_id"):
            continue  # 纯本地文件，无 cloud_id
        cloud_files[path] = {
            "id": info["file_id"],
            "parent_id": info.get("parent_id", ""),
            "name": os.path.basename(path),
            "is_dir": False,
            "mtime": info.get("cloud_mtime", 0),
            "ctime": info.get("create_time", 0),
            "domain": info.get("domain", 0),
        }
    for path, info in all_dirs.items():
        cloud_files[path] = {
            "id": info["dir_id"],
            "parent_id": info.get("parent_id", ""),
            "name": os.path.basename(path),
            "is_dir": True,
            "mtime": 0,
            "ctime": 0,
            "domain": 0,
        }
    return cloud_files
```

### 4.2 listRecent 的局限与应对

| 局限 | 影响 | 应对 |
|------|------|------|
| 最多 30 条 | 大批量变化时无法增量 | Fallback 全量扫描 |
| 只返回文件，不含目录变化 | 新建目录时缓存不完整 | 全量扫描时同步更新目录缓存 |
| 不含删除信息 | 云端删除的文件缓存中仍存在 | 每次全量扫描时清理孤立记录 |
| limit>30 返回 500 | 无法扩大上限 | 只用 limit=30 |

### 4.3 桌面客户端数据（可选加速层）

桌面客户端数据不再是核心依赖，但仍有两个有价值的用途：

**用途 1：冷启动种子**

首次运行时 `sync_metadata.db` 为空，必须全量 HTTP 扫描。如果桌面客户端有数据，可以直接导入：

```python
def _try_seed_from_desktop(self):
    """首次运行时从桌面客户端导入元数据（可选）。"""
    if self.metadata.get_all_files():
        return  # 已有数据，不需要种子
    desktop_db = _find_desktop_db()
    if not desktop_db:
        return
    # 从 note + note_book 表重建路径树
    # 写入 sync_metadata.db
```

**用途 2：domain=0 文件本地读取**

桌面客户端 `file/<bucket>/<fileId>` 缓存了 domain=0 文件的原始 XML。下载时可以优先读本地，省一次 HTTP：

```python
def _try_read_from_desktop(self, file_id: str) -> Optional[bytes]:
    """尝试从桌面客户端缓存读取文件内容。"""
    desktop_file = _find_desktop_file(file_id)
    if desktop_file and os.path.exists(desktop_file):
        with open(desktop_file, "rb") as f:
            return f.read()
    return None  # fallback 到 HTTP
```

**不再需要版本校验和自动启动**：桌面客户端数据只用于"有就用、没有就跳过"的场景，不需要保证新鲜度。

### 4.4 .note XML → Markdown 转换

#### 当前转换流程（不变）

```
HTTP/本地 → .note bytes → _save_and_convert()
  ├── XML (<?xml) → xml_bytes_to_markdown()
  ├── JSON ({"...) → json_bytes_to_markdown()
  └── Other       → 原样保存
```

桌面客户端 `file/` 目录存储的 XML 和 HTTP 下载的字节流格式一致，转换函数完全复用。

#### XML→MD 已知格式差异

| 差异 | 影响 |
|------|------|
| 转义字符 `\_` `\*` `\#` | `normalize_md_formatting` 已处理 |
| 列表标记 `- ` vs `* ` | 同上 |
| 表格 padding | 同上 |

## 5. XML ↔ MD 转换与云端格式保持

### 5.1 核心原则

| 场景 | 云端原始格式 | 本地存储 | 上传时 |
|------|-------------|---------|--------|
| domain=0 笔记 | XML (.note) | MD (转换后) | **XML** (反向转换) |
| domain=1 笔记 | MD (.md) | MD (原样) | **MD** (原样) |
| 本地新建 .md | — | MD | **MD** (domain=1) |

### 5.2 MD → XML 反向转换

#### 实现前需要确认的前提

**关键问题：你是否会在本地编辑 domain=0 笔记并上传回云端？**

- 如果答案是"很少/从不" → MD→XML 转换可以推迟或不做，domain=0 标记为只读即可
- 如果答案是"经常" → 需要实现完整的 MD→XML 转换器

#### 转换映射（如果实现）

| Markdown 元素 | XML 元素 | 难度 |
|---------------|----------|------|
| `# 标题` | `<para>` + `<heading level="N"/>` | 低 |
| 普通段落 | `<para>` + `<text>` | 低 |
| `**粗体**` `*斜体*` `~~删除线~~` | `<inline-styles>` + from/to 偏移 | 中 |
| `[text](url)` | `<inline-styles><link>` | 中 |
| `![alt](url)` / 代码块 / 引用 / 分割线 / todo | 各对应 XML 元素 | 低 |
| `- 列表` / `1. 列表` | `<list-item>` + list-id + list-type | 中 |
| 表格 | `<table>` + JSON `<content>` | 高 |

#### 往返退化问题

**每次 XML→MD→XML 循环都会丢失信息。** 这是不可避免的：

| 丢失的内容 | 说明 |
|-----------|------|
| `<coId>` | 协作段落 ID，MD 中没有对应概念 |
| `inline-styles` 精确偏移 | 重建时的偏移计算可能和原始不完全一致 |
| 嵌套样式的优先级 | 粗体+斜体+链接叠加时顺序可能变 |

**应对方案：用 `file_base` 表存原始 XML**

`sync_metadata.db` 已有 `file_base` 表（`path, content, hash, saved_at`），原本用于 diff3 合并。可以复用：

```python
# 下载 domain=0 笔记时
original_xml = api.get_file_by_id(file_id).content
metadata.save_base_content(rel_path, original_xml, hash)
# 转 MD 保存到本地...

# 上传时
original_xml = metadata.get_base_content(rel_path)
if original_xml:
    # 策略 1: diff-patch（保真度高，复杂）
    new_xml = patch_xml_with_md_changes(original_xml, current_md)
    # 策略 2: 全量重建 + 从原始 XML 复用 coId（简单）
    new_xml = rebuild_xml_from_md(current_md, coId_source=original_xml)
```

### 5.3 转换验证

```python
def _verify_roundtrip(original_xml: bytes) -> bool:
    """XML→MD→XML 往返后语义是否一致。"""
    md = xml_bytes_to_markdown(original_xml)
    rebuilt_xml = markdown_to_xml_bytes(md)
    md_from_rebuilt = xml_bytes_to_markdown(rebuilt_xml)
    return normalize_md_formatting(md) == normalize_md_formatting(md_from_rebuilt)
```

## 6. 实现计划

### Phase 1：扫描缓存复用（核心收益，零新模块） — ✅ 已完成

**工作量**: ~2-3 小时  
**收益**: 无变化时扫描从 163 次 HTTP → 1 次 HTTP

| 步骤 | 文件 | 内容 | 状态 |
|------|------|------|------|
| 1 | `src/sync/metadata.py` | 新增 `sync_state` 表 + `get_state/set_state` 方法 | ✅ |
| 2 | `src/api.py` | 新增 `list_recent(limit=30)` 方法 | ✅ |
| 3 | `src/sync/engine.py` | `_async_collect_items` 增加缓存分支 | ✅ |
| 4 | `src/sync/engine.py` | `_load_cloud_files_from_cache()` + `_apply_incremental_changes()` | ✅ |
| 5 | `test/test_sync.py` | 缓存命中、增量更新、全量 fallback 三种路径的测试 | ✅ |

### Phase 2：桌面客户端数据集成（可选加速） — ✅ 已完成

**工作量**: ~2-3 小时  
**收益**: 冷启动加速 + domain=0 文件本地读取

| 步骤 | 文件 | 内容 | 状态 |
|------|------|------|------|
| 1 | `src/sync/desktop_data.py` | `find_desktop_db()`, `seed_metadata_from_desktop()`, `read_desktop_file()` | ✅ |
| 2 | `src/sync/engine.py` | 首次运行时调用 `seed_metadata_from_desktop()` | ✅ |
| 3 | `src/transfer/download.py` | `_download_and_detect` 增加桌面缓存优先路径 | ✅ |
| 4 | `test/` | 路径重建、文件读取测试 | ✅ |

### Phase 3：云端格式保持 — original_domain 记录 — ✅ 已完成

**工作量**: ~1 小时  
**收益**: 为 Phase 4 (MD→XML) 做准备；即使不做 Phase 4，也能在上传时警告用户

| 步骤 | 文件 | 内容 | 状态 |
|------|------|------|------|
| 1 | `src/sync/metadata.py` | files 表新增 `original_domain` 字段 | ✅ |
| 2 | `src/sync/engine.py` | 下载 domain=0 文件时记录 `original_domain=0` + 保存原始内容到 `file_base` | ✅ |
| 3 | `src/sync/engine.py` | 上传时检测 `original_domain=0` → Markdown 反向转换为有道 JSON | ✅ |

### Phase 4：MD → 有道 JSON 反向转换 — ✅ 已完成

**工作量**: ~4-6 小时  
**说明**: 实际实现为 Markdown → 有道 JSON 格式（而非 XML），因为新版有道云笔记使用 JSON 格式

| 步骤 | 文件 | 内容 | 状态 |
|------|------|------|------|
| 1 | `src/convert/md_to_note.py` | `markdown_to_note_json()` — Markdown 解析为有道 JSON 格式 | ✅ |
| 2 | `src/transfer/upload.py` | `original_domain=0` → MD→JSON 转换 → domain=0 上传 | ✅ |
| 3 | `test/` | 各元素测试 + 往返一致性 | ✅ |

### Phase 5：离线模式 + 资源文件（远期）

| 步骤 | 内容 |
|------|------|
| 1 | 完全离线扫描（API 不可用时用缓存 + 桌面数据） |
| 2 | 资源文件本地读取（替换图片 URL） |

## 7. 风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| listRecent 返回 500 | 无法判断缓存新鲜度 | Fallback 全量扫描 |
| 缓存中有云端已删除的文件 | 产生虚假的"cloud-only"记录 | 全量扫描时做差集清理；增量模式下检查 `del` 标记 |
| 两次同步间 >30 文件变化 | listRecent 无法覆盖全部变更 | 自动触发全量扫描 |
| 桌面客户端未安装 | Phase 2 不可用 | Phase 1 完全不依赖桌面客户端 |
| MD→XML 往返退化 | 多次循环后格式漂移 | 存原始 XML 到 file_base，尽量 patch 而非重建 |
| sync_metadata.db 损坏 | 缓存不可用 | 自动检测 → 清空缓存 → 全量重扫 |

## 附录 A：桌面客户端本地数据结构

```
%APPDATA%/ynote-desktop/<user>/ynote-data/
├── <user>.db                 # SQLite: note + note_book 表
├── <user>-content.db         # SQLite: contenttable (含 MD 格式)
├── file/<bucket>/<fileId>    # domain=0 XML 缓存 (99% 覆盖率)
├── resource/<bucket>/<resId> # 图片/附件 (2425 个)
└── backupNote/<fileId>/      # 压缩二进制备份
```

### note 表关键字段

```sql
SELECT fileId, title, parentId, modifyTime, createTime,
       size, version, domain, dir, del, entryType
FROM note WHERE del = 0
-- 3225 文件 + 163 目录, domain: 0=XML 1=MD
```

### domain=1 在 content.db 中的覆盖率

- 77/89 (86%) 有内容，保留了完整 Markdown 格式
- 归一化后与 API 下载 93% 一致（差异主要是 CRLF vs LF）
- 总量仅占 2.8%，即使全走 HTTP 影响很小

## 附录 B：.note XML 结构

```xml
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<note xmlns="http://note.youdao.com" file-version="0" schema-version="1.0.3">
  <head/>
  <body>
    <para>
      <coId>2390-1639436740287</coId>
      <text>正文内容</text>
      <inline-styles>
        <bold><from>0</from><to>4</to><value>true</value></bold>
      </inline-styles>
      <styles><heading level="1"/></styles>
    </para>
    <image><source>https://...</source><text>描述</text></image>
    <code><language>python</language><text>print("hello")</text></code>
    <list-item list-id="xxx" list-type="unordered"><text>列表项</text></list-item>
    <table><content>{"widths":[...],"cells":[...]}</content></table>
  </body>
</note>
```
