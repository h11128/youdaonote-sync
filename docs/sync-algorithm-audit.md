# 同步引擎算法审查报告

> 生成时间：2026-02-21
> 审查范围：`src/sync/` 全部模块（engine, scanner, decision, moves, dedup, metadata, utils, merkle, bloom, merge, rolling_hash, desktop_data）
> 当前 `src/sync/` 共 14 个 .py 文件（含 `__init__.py`）

---

## 目录

1. [执行摘要](#1-执行摘要)
2. [当前管道总览](#2-当前管道总览)
3. [逐模块分析](#3-逐模块分析)
   - 3.1 scanner.py
   - 3.2 decision.py（calibrate）
   - 3.3 moves.py
   - 3.4 utils.py（decide_action + compute_content_hash）
   - 3.5 metadata.py
   - 3.6 dedup.py
   - 3.7 engine.py（编排层）
4. [管道级优化机会](#4-管道级优化机会)
5. [替代匹配策略评估](#5-替代匹配策略评估)
6. [并发模型分析](#6-并发模型分析)
7. [已修复的问题](#7-已修复的问题)
8. [优先级路线图](#8-优先级路线图)

---

## 1. 执行摘要

当前同步引擎在功能上已经覆盖了主要的同步场景，包括文件移动检测、跨目录重复检测和内容去重。但从算法效率角度，存在以下几类可优化的问题：

| 类别 | 数量 | 典型影响 |
|------|------|----------|
| 重复计算 | 4 处 | 同一数据被多次遍历或 hash |
| 线性查找瓶颈 | 2 处 | O(n) 操作可优化到 O(1) |
| 内存效率 | 2 处 | 大文件一次性读入内存 |
| 管道级冗余 | 3 处 | 模块间工作成果未传递 |
| 并发不足 | 2 处 | 本地扫描/hash 计算是单线程 |

**最有价值的优化**（按收益/成本排序）：
1. `metadata.find_by_file_id()` 加反向索引 → 从 O(n) 到 O(1)，改动小
2. `compute_content_hash` 改分块读取 → 大文件内存降到 O(1)，改动小
3. 跨模块传递 hash 结果 → 省去重复 hash 计算，改动中等
4. dedup 复用 sync 阶段的扫描结果 → 省一次 os.walk，改动中等

---

## 2. 当前管道总览

```
_collect_items()
  ├── scan_cloud()  ─ BFS + 8 线程池，返回 cloud_files
  ├── scan_local()  ─ 单线程 os.walk，返回 local_files
  │
  ├── calibrate_metadata()  ─ 给"两端都有但无元数据"的文件建基线
  │     └── 对每个校准文件：compute_content_hash() [全文件读取]
  │
  └── reconcile_moves()  ─ 三阶段移动检测
        ├── _detect_cloud_moves()    ─ file_id 匹配 [O(L)]
        ├── _detect_name_mismatches() ─ 同目录文件名净化 [O(C+L)]
        └── _detect_cross_dir_duplicates() ─ content hash + 文件名 [O(L·H+C)]
              └── 对每个本地候选：compute_content_hash() [全文件读取]

→ build_item() × N  ─ 构建 SyncItem 列表
→ _execute_all()     ─ 5~10 线程执行上传/下载
     └── _do_upload()/download()
           └── compute_content_hash() [又一次全文件读取]

→ auto_dedup()       ─ 内容去重
     └── _build_indexes()
           └── os.walk + compute_content_hash() [第四次遍历]
```

**关键观察**：同一个文件在一次同步中最多被 hash 计算 4 次（calibrate → cross_dir_dup → upload/download → dedup），且每次都是独立的全文件读取。

---

## 3. 逐模块分析

### 3.1 scanner.py

**当前算法：**

| 函数 | 算法 | 时间复杂度 | 空间 |
|------|------|-----------|------|
| `scan_cloud()` | BFS + ThreadPool(8) | O(D/W + D·E) | O(F) |
| `scan_local()` | 单线程 os.walk | O(N) | O(N) |

D = 目录数，W = worker 数，E = 平均每目录条目数，F = 总文件数，N = 本地文件数

**问题 1：BFS 分层等待**（scanner.py:90-100）

当前 BFS 逐层展开，每层所有目录扫描完才进入下一层。假设目录树是"窄且深"的结构（某条路径深度 20，其他路径深度 2），8 个 worker 中有 7 个在等那条深路径逐层完成。

```
# 当前实现：level-by-level barrier
while current_level:
    futures = {pool.submit(...): (did, bp) for did, bp in current_level}
    next_level = []
    for fut in as_completed(futures):
        next_level.extend(fut.result())
    current_level = next_level  # ← barrier：必须整层完成
```

**建议**：改为 queue-based 自由调度。每个 worker 完成一个目录后，把子目录推入共享队列，其他空闲 worker 立即取走处理。可以用 `queue.Queue` + 计数器实现（计数器归零 = 全部完成）。

**影响**：对浅宽目录树几乎无区别；对深窄树能减少空闲等待。考虑到笔记目录通常是浅宽结构，这个优化优先级不高。

**问题 2：scan_local 单线程**（scanner.py:120-148）

对于本地文件数千的目录，os.walk 本身是 I/O bound，单线程可能成为瓶颈。

**建议**：对顶层子目录并行 os.walk。但实现复杂度高，且 Python os.walk 在 Windows 上已经使用 scandir（Python 3.5+），性能尚可。**优先级低**。

**问题 3：lock 粒度**（scanner.py:76-83）

每个文件/目录发现都独立获取 `files_lock`。在 8 worker 高并发下，lock contention 是可测量的开销。

**建议**：每个 worker 用本地 dict 积累结果，在 `_fetch_dir` 返回时一次性合并到全局 `files` 中。

```python
def _fetch_dir(did, bpath):
    local_results = {}
    for entry in entries:
        # ... build info ...
        local_results[rel] = info
    with files_lock:
        files.update(local_results)
    return subdirs
```

**影响**：lock 获取次数从 O(F) 降到 O(D)。改动小，可以顺便做。

---

### 3.2 decision.py（calibrate_metadata）

**当前算法：**

| 函数 | 时间 | 说明 |
|------|------|------|
| `calibrate_metadata()` | O(C · H) | C = cloud_files 中需要校准的文件数，H = hash 计算成本 |
| `build_item()` | O(1) per item | 简单的 metadata 查找 + decide_action |

**问题 1：校准时对每个文件都计算 hash**（decision.py:53）

```python
content_hash = compute_content_hash(local["path"])
```

这个 hash 在校准时设定基线，但如果文件马上被 `reconcile_moves` 重新定位到其他路径，这次 hash 就浪费了。

**建议**：
- 方案 A：`calibrate` 不计算 hash，设 `content_hash=None`；延迟到 `_do_upload`/`_do_download` 时再算。缺点：`find_cloud_file_by_hash` 在首次同步前无法工作。
- 方案 B：保持现状，但用 `hash_cache: Dict[str, str]` 存储计算结果，后续 moves/upload 阶段复用。**推荐此方案**。

**问题 2：calibrate 和 reconcile 的执行顺序**

当前：calibrate → reconcile。

calibrate 处理"两端都有但无元数据"的文件。reconcile 处理"只在一端存在"的文件。两者操作的集合不重叠（calibrate 只看 `cloud ∩ local`，reconcile 只看差集），所以当前顺序是正确的。

但如果将来 `_detect_cross_dir_duplicates` 匹配了某个文件 X（把它从 only_local 移到 both），那 X 在 calibrate 阶段还不在 both 集合中，因此不会被校准。这不是 bug——reconcile 自己会写 metadata。但如果想省 hash 计算，可以考虑让 reconcile 也写入共享 hash_cache。

---

### 3.3 moves.py

**当前算法：**

| 函数 | 时间 | 空间 |
|------|------|------|
| `_detect_cloud_moves()` | O(L) | O(C) for cloud_id_to_path |
| `_detect_name_mismatches()` | O(C + L) | O(C) for norm_index |
| `_detect_cross_dir_duplicates()` | O(L·H + C) | O(L + C) |
| `reconcile_moves()` | O(C + L + L·H) | O(C + L) |

L = only_local 文件数，C = only_cloud 文件数，H = 单次 hash 成本

**问题 1：~~重复计算 only_local / only_cloud~~（已修复）**

原来三个检测函数各自独立计算 `set(local_files.keys()) - set(cloud_files.keys())`。现在 `reconcile_moves` 计算一次，三个函数共享，并且在匹配成功时 discard 已匹配的路径。

**问题 2：所有本地候选文件都做 hash**（moves.py:168-173）

`_detect_cross_dir_duplicates` 对 `local_candidates` 中每个文件都调用 `compute_content_hash()`。如果 only_local 有 200 个文件但 only_cloud 只有 5 个，实际只需要匹配 5 个云端文件的 hash，但我们 hash 了 200 个本地文件。

**建议**：先检查 `cloud_hash_map` 有多少条目。如果 `len(cloud_hash_map) < len(local_candidates)`，反转匹配方向——先遍历云端 hash，对每个云端 hash 找到同名的本地文件，只 hash 那几个。

```python
if len(cloud_hash_map) < len(local_candidates) / 4:
    # 只 hash 与云端文件同名的本地文件
    cloud_names = {os.path.basename(cp).lower() for cp in cloud_hash_map}
    local_to_hash = {lp for lp in local_candidates
                     if os.path.basename(lp).lower() in cloud_names}
else:
    local_to_hash = local_candidates
```

**影响**：典型场景下可能减少 80%+ 的 hash 计算。

**问题 3：filename-only 匹配的误判风险**

当两个文件仅靠文件名 + 共享祖先路径匹配（无 hash 验证）时，存在误判风险。比如 `项目A/总结.md` 和 `项目B/总结.md` 如果共享祖先深度 ≥ 1 就会匹配。

当前有两个防线：
1. `_GENERIC_NAMES` 黑名单（readme.md 等）
2. `best_depth >= 1` 的门槛

**建议**：对 filename-only 匹配增加文件大小验证。如果大小差异 > 20%，跳过匹配。这几乎没有额外 I/O 成本（stat 调用），但能有效减少误判。

```python
if best_cp and best_depth >= 1:
    local_size = os.path.getsize(local_files[lp]["path"])
    cloud_meta = metadata.get_file_info(best_cp)
    # 如果有 hash 就用 hash 验证；没有就用大小做粗判
    if cloud_meta and cloud_meta.get("content_hash"):
        local_h = local_hash_map.get(lp) or compute_content_hash(local_files[lp]["path"])
        if local_h != cloud_meta["content_hash"]:
            continue
```

---

### 3.4 utils.py

**当前算法：**

| 函数 | 时间 | 空间 | 说明 |
|------|------|------|------|
| `compute_content_hash()` | O(size) | **O(size)** | 全文件读入内存 |
| `decide_action()` | O(1) | O(1) | 纯比较 |
| `print_dryrun_summary()` | O(5n) | O(n) | 5 次列表推导 |

**问题 1：全文件读入内存**（utils.py:184-187）

```python
with open(file_path, "rb") as f:
    data = f.read()  # ← 整个文件加载到内存
normalized = data.replace(b"\r\n", b"\n").replace(b"\xef\xbb\xbf", b"")
```

对于大文件（PDF、图片等），这会导致内存峰值很高。

**建议**：分块读取 + incremental MD5。但有个难点：CRLF 可能跨越 chunk 边界（chunk 末尾是 `\r`，下个 chunk 开头是 `\n`）。

安全的实现方案：

```python
def compute_content_hash(file_path: str, chunk_size: int = 1024 * 1024) -> Optional[str]:
    try:
        h = hashlib.md5()
        with open(file_path, "rb") as f:
            prev_ends_with_cr = False
            first_chunk = True
            while True:
                chunk = f.read(chunk_size)
                if not chunk:
                    break
                if first_chunk:
                    chunk = chunk.lstrip(b"\xef\xbb\xbf")  # BOM 只在文件头
                    first_chunk = False
                if prev_ends_with_cr:
                    if chunk[0:1] == b"\n":
                        chunk = chunk[1:]  # 已经在上个 chunk 写了 \n
                # 替换 CRLF；记住末尾状态
                chunk = chunk.replace(b"\r\n", b"\n")
                prev_ends_with_cr = chunk.endswith(b"\r")
                if prev_ends_with_cr:
                    chunk = chunk[:-1] + b"\n"  # 假设 \r 后跟 \n
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None
```

注意：上面的实现改变了边界 case 的行为（孤立 `\r` 的处理），需要对现有文件回归测试。**更安全的方案**：对小文件（< 1MB）保持全量读取，只对大文件用分块。

**问题 2：print_dryrun_summary 五次遍历**（utils.py:129-134）

```python
upload_files = [i for i in items if i.action == SyncAction.UPLOAD and not i.is_dir]
upload_dirs  = [i for i in items if i.action == SyncAction.UPLOAD and i.is_dir]
download_files = [...]
download_dirs  = [...]
conflicts = [...]
```

每个列表推导都遍历全量 items。改为单次遍历分桶即可。**影响极小**，items 通常只有几百个，但作为代码质量改进值得做。

---

### 3.5 metadata.py

**当前算法：**

| 函数 | 时间 | 说明 |
|------|------|------|
| `get_file_info()` | O(1) | dict 查找 + lock |
| `set_file_info()` | O(1) | dict 更新 + hash_index 更新 |
| `find_by_file_id()` | **O(n)** | 线性扫描全部文件 |
| `find_by_dir_id()` | **O(n)** | 线性扫描全部目录 |
| `find_cloud_file_by_hash()` | O(1) 均摊 | 有 hash_index，回退时 O(n) |
| `remove_file()` | **O(n)** | hash_index 修复需要遍历 |
| `update_content_hash()` | **O(n)** | 旧 hash 修复需要遍历 |

**问题 1：find_by_file_id 线性扫描**（metadata.py:314-318）

这是 `_detect_cloud_moves` 的关键依赖。虽然当前的 `_detect_cloud_moves` 自己建了 `cloud_id_to_path` 映射所以不直接调用这个函数，但其他地方（如 uploader）可能调用。

**建议**：新增 `_file_id_index: Dict[str, str]`（file_id → path），在 `set_file_info` / `remove_file` 时维护。改动量 ~15 行。

```python
# 在 __init__ 中初始化
self._file_id_index: Dict[str, str] = {}

# 在 load() 后重建
def _rebuild_file_id_index(self):
    self._file_id_index.clear()
    for path, info in self._data["files"].items():
        fid = info.get("file_id")
        if fid:
            self._file_id_index[fid] = path

# find_by_file_id 变为 O(1)
def find_by_file_id(self, file_id):
    with self._lock:
        return self._file_id_index.get(file_id)
```

**问题 2：hash_index 只存一个路径**（metadata.py:105-107）

当前 `_hash_index` 是 `Dict[str, str]`（hash → 单个 path）。删除一个文件时需要遍历所有文件找另一个持有相同 hash 的路径。

**建议**：改为 `Dict[str, List[str]]`（hash → [paths]）。删除时只需从 list 中移除，O(1)。`find_cloud_file_by_hash` 返回 list 中第一个有 file_id 的。

**影响**：`remove_file` 和 `update_content_hash` 从 O(n) 降到 O(k)（k = 同 hash 文件数，通常 1-2）。

**问题 3：全局锁粒度**

每个 metadata 操作都获取同一把 `_lock`。在 10 个下载线程并发时，`_record_file_change` → `set_file_info` 会产生 lock contention。

**建议**：
- 短期：保持现状。当前文件数 ~500，lock contention 的实际影响有限。
- 长期：如果文件数增长到数千，可以考虑 `threading.RWLock`（Python 标准库没有，需要第三方或自己实现）或分段锁。

---

### 3.6 dedup.py

**当前算法：**

| 函数 | 时间 | 说明 |
|------|------|------|
| `_build_indexes()` | O(N · H) | 全量 os.walk + hash |
| `_classify_duplicates()` | O(D · P) | 按文件大小再分组 |
| `_resolve_group()` | O(P · log P) | 排序选保留 |
| `auto_dedup()` | O(N · H + G · P) | 全流程 |

N = 本地文件总数，H = hash 成本，D = 重复组数，P = 组内路径数，G = 有效组数

**问题 1：dedup 完全重做扫描**（engine.py:162）

`auto_dedup` 在 sync 完成后执行，会做一次完整的 `os.walk` + hash。但 sync 阶段已经：
- `scan_local()` 遍历了所有本地文件
- `calibrate_metadata()` 为两端都有的文件计算了 hash
- `_detect_cross_dir_duplicates()` 为 only_local 文件计算了 hash
- `_do_download()` / `_do_upload()` 为刚同步的文件计算了 hash

dedup 阶段的 hash 计算有 80%+ 是重复的（metadata 缓存命中取决于 mtime 是否一致）。

**建议**：传递 sync 阶段的 `local_files` 和一个 `hash_cache: Dict[path, hash]` 给 dedup，让 `_build_indexes` 跳过已有 hash 的文件。

**问题 2：_classify_duplicates 重复 getsize**（dedup.py:200）

每个重复组内的每个路径都调用 `os.path.getsize`。如果在 `_build_indexes` 阶段顺便记录文件大小，这里就不需要额外的 stat 调用。

**建议**：`_build_indexes` 返回 `(hash_index, referenced, size_cache)` 或直接在 hash_index 中存 `(hash, size)` tuple。

**问题 3：build_ref_index 重新遍历**

`build_ref_index` 单独调用时会重新 os.walk + hash 所有文件。虽然 `build_all_indexes` 已经合并了两者，但 `build_ref_index` 自身的实现调用了 `_build_indexes(..., need_refs=True)` 且 `metadata=None`——这意味着它不会用 metadata 缓存，所有文件都要重新 hash。

**建议**：`build_ref_index` 应该接受可选的 `metadata` 参数。

---

### 3.7 engine.py（编排层）

**问题 1：上传/下载共用同一个线程池**（engine.py:222-223）

```python
has_upload = any(i.action == SyncAction.UPLOAD for i in action_items)
workers = self.UPLOAD_WORKERS if has_upload else self.DOWNLOAD_WORKERS
```

如果既有上传又有下载，worker 数按上传（5）算。下载本来可以 10 并发，但因为有上传混在里面就降到了 5。

**建议**：分成两个池：upload_pool(5) 和 download_pool(10)。但这会增加代码复杂度。考虑到上传 API 有速率限制，当前方案是保守但安全的选择。**优先级低**。

**问题 2：_record_file_change 的 lock 范围**（engine.py:93-106）

每次文件完成都获取 lock，在 lock 内做 metadata 更新 + stats 更新 + list append。metadata.set_file_info 内部还会再获取 metadata 自己的 lock → **嵌套锁**。

当前不会死锁（因为获取顺序固定：engine._lock → metadata._lock），但嵌套锁增加了等待时间。

**建议**：把 metadata 更新移到 engine lock 外面（metadata 有自己的线程安全保证）。

```python
def _record_file_change(self, item, stat_key, local_mtime=None, content_hash=None):
    # metadata 更新在锁外（metadata 自己是线程安全的）
    if stat_key == "downloaded":
        self.metadata.set_file_info(...)
    elif stat_key == "uploaded" and content_hash:
        self.metadata.update_content_hash(...)
    # 只有 stats 和 list 需要 engine lock
    with self._lock:
        self._try_flush_metadata()
        self.stats[stat_key] += 1
        self._changed_paths.append(item.local_path)
```

---

## 4. 管道级优化机会

### 4.1 跨模块 hash 缓存（收益最大）

**问题**：同一文件在一次同步中可能被 hash 最多 4 次。

**方案**：在 `_collect_items` 开始时创建一个 `hash_cache: Dict[str, str]`（绝对路径 → hash），贯穿整个流程。

传递路径：
```
_collect_items(hash_cache)
  → calibrate_metadata(hash_cache)
  → reconcile_moves(hash_cache)
  → _do_upload/_do_download 写入 hash_cache
  → auto_dedup(hash_cache)
```

每个函数在计算 hash 前先查 cache，计算后写入 cache。

**收益估算**：假设 500 个文件，其中 100 个需要操作。calibrate hash 100 个，cross_dir hash ~50 个，upload/download hash 30 个，dedup hash 500 个。没有 cache 时总计 ~680 次 hash；有 cache 时总计 ~500 次（dedup 全部命中 cache 或 metadata），省 26%。如果 dedup 能直接复用 scan 结果，省更多。

### 4.2 dedup 复用 sync 阶段的扫描结果

**问题**：`auto_dedup` 在 sync 完成后做一次完整的 `os.walk`，但 sync 阶段刚刚做了 `scan_local()`。

**方案**：让 `auto_dedup` 接受可选的 `local_files: Dict` 参数。如果提供了，跳过 os.walk，直接用传入的路径列表。

**注意**：sync 阶段的 `local_files` 不包含 `images/` 和 `attachments/`（被 scanner 过滤了），而 dedup 需要处理这些目录。所以不能直接替代，但可以作为"已知文件"的预加载集合，dedup 只需要额外扫描 images/ 和 attachments/。

### 4.3 calibrate 与 cross_dir_dup 的 hash 复用

**问题**：calibrate 对"两端都有"的文件计算 hash；cross_dir_dup 对"only_local"文件计算 hash。两者不重叠，但如果 cross_dir_dup 匹配后文件变成"两端都有"，calibrate 的 hash 可以省去。

**现状**：calibrate 先于 reconcile 执行，所以 calibrate 不会处理后来被 reconcile 匹配的文件。这个顺序是正确的。但如果将来反转顺序（reconcile → calibrate），就需要考虑这个交互。

**结论**：当前顺序下不需要改动。如果实现 4.1 的跨模块 hash cache，这个问题自然解决。

---

## 5. 替代匹配策略评估

### 5.1 当前策略总结

```
匹配优先级：
1. file_id 精确匹配 — 100% 准确，依赖云端 API 返回的 ID
2. content hash 匹配 — 99.99% 准确（MD5 碰撞概率极低，且有 size 二次验证）
3. 文件名 + 路径祖先匹配 — 较弱信号，有误判风险
```

### 5.2 可考虑的替代方案

#### A. Simhash / MinHash（近似内容匹配）

**原理**：将文件内容转换为定长指纹，允许小量差异仍能匹配。

**适用场景**：用户在本地编辑了文件（改了几行），同时云端也有旧版本。当前用 mtime 处理这种情况（新版本覆盖旧版本），但如果 mtime 不可靠，simhash 可以识别"这是同一个文件的不同版本"。

**评估**：
- 当前项目的核心需求是"同一文件的移动检测"，而不是"相似文件检测"
- MD5 精确匹配已经足够覆盖移动场景
- Simhash 增加了复杂性但没有解决实际痛点
- **结论：不建议引入**

#### B. 文件头部 hash（快速预过滤）

**原理**：只读取文件前 4KB 计算 hash，作为候选快速筛选。全文 hash 只在头部 hash 匹配时计算。

**适用场景**：`_detect_cross_dir_duplicates` 中，本地候选很多但实际匹配很少。

**评估**：
- 实现简单：`hashlib.md5(f.read(4096)).hexdigest()`
- 误判率低：前 4KB 相同但后续不同的概率极低（尤其是 md 文件）
- 但同时增加了 I/O 次数（先读 4KB，匹配后再读全文）
- 如果文件大多是小文件（< 4KB），头部 hash 等于全文 hash，没有节省
- **结论：当文件普遍 > 10KB 时可以考虑，但当前笔记文件通常较小，收益有限**

#### C. 文件大小预过滤（推荐）

**原理**：在 hash 匹配前先比较文件大小。大小不同的文件不可能 hash 相同。

**适用场景**：任何需要跨集合比较的地方。

**评估**：
- `os.path.getsize()` 成本极低（一次 stat 调用）
- 可以在 cross_dir_dup 中先按大小分桶，只对大小匹配的文件计算 hash
- 对于本地文件已有 `os.path.getmtime`（scan_local 已经做了 stat），可以顺便取 size
- **结论：强烈建议实施。改动小，收益明确**

实施方式：在 `scan_local` 中增加 `size` 字段：
```python
files[rel] = {"path": p, "is_dir": False,
              "mtime": int(st.st_mtime), "size": st.st_size}
```

然后在 `_detect_cross_dir_duplicates` 中按 size 预过滤。

#### D. 路径编辑距离（替代 common_ancestor_depth）

**原理**：用 Levenshtein 距离衡量两个路径的相似度，而不是只看共享祖先深度。

**适用场景**：`内在世界/计划/总结.md` → `内在世界/计划和总结/总结.md`。共享祖先只有 1 层（"内在世界"），但路径编辑距离很小。

**评估**：
- 比 common_ancestor_depth 更细腻
- 但增加了计算复杂度（O(m·n) per pair）
- 当前 common_ancestor_depth + 文件名匹配已经足够
- **结论：暂不需要，但如果发现 common_ancestor_depth 误判率高可以考虑**

### 5.3 策略总结

| 策略 | 推荐 | 理由 |
|------|------|------|
| 文件大小预过滤 | **强烈推荐** | 几乎零成本，显著减少 hash 计算 |
| 跨模块 hash 缓存 | **强烈推荐** | 一次计算，全流程复用 |
| 文件头部 hash | 可选 | 对大文件有效，小文件无益 |
| Simhash/MinHash | 不推荐 | 不是当前痛点 |
| 路径编辑距离 | 不推荐 | 当前方案够用 |

---

## 6. 并发模型分析

### 6.1 当前模型

```
┌─────────────┐     ┌───────────────┐     ┌────────────────┐
│ scan_cloud  │     │ scan_local    │     │ _execute_all   │
│ 8 threads   │ ──→ │ 1 thread      │ ──→ │ 5~10 threads   │
│ (I/O bound) │     │ (I/O bound)   │     │ (I/O + network)│
└─────────────┘     └───────────────┘     └────────────────┘
        ↓ 并行            ↓ 并行                 ↓ 串行
   cloud_files        local_files           upload/download

                                          ┌────────────────┐
                                          │ auto_dedup     │
                                          │ 1 thread       │
                                          │ (I/O bound)    │
                                          └────────────────┘
```

### 6.2 瓶颈分析

1. **scan 阶段**：cloud(8线程) 和 local(1线程) 并行。瓶颈是 local 单线程。但 local os.walk 通常很快（< 1 秒），所以实际瓶颈是 cloud 的 API 调用延迟。**不需要优化**。

2. **决策阶段**（calibrate + reconcile + build_items）：全部单线程。其中 calibrate 和 cross_dir_dup 的 hash 计算是 I/O bound。如果文件多可以考虑 ThreadPool 并行 hash。**可选优化**。

3. **执行阶段**：5~10 线程。上传受 API 速率限制，下载受网络带宽限制。当前线程数是合理的。**不需要优化**。

4. **dedup 阶段**：单线程 os.walk + hash。如果能复用 sync 阶段的结果，这个阶段可以大幅缩短。**见 4.1 和 4.2**。

### 6.3 GIL 影响

Python GIL 对 I/O bound 任务影响很小（I/O 等待时 GIL 自动释放）。hash 计算是 CPU bound，但 hashlib 的 C 实现也会释放 GIL。所以当前的 threading 方案是合适的，不需要换 multiprocessing。

---

## 7. 已实施的优化

> 以下所有改动均已通过 dry-run 验证（2026-02-21）

### 7.1 only_local / only_cloud 共享集合维护（bug fix）

**文件**：`src/sync/moves.py`

三个检测函数现在共享 `only_local`/`only_cloud` 集合，匹配成功时 `discard` 已匹配路径。修复了之前 `_detect_name_mismatches` 匹配后 `_detect_cross_dir_duplicates` 可能重复处理的问题。

### 7.2 #1 metadata 反向索引（O(n) → O(1)）

**文件**：`src/sync/metadata.py`

- 新增 `_file_id_index: Dict[str, str]`（file_id → path）
- 新增 `_dir_id_index: Dict[str, str]`（dir_id → path）
- `find_by_file_id()` 和 `find_by_dir_id()` 从线性扫描改为字典查找
- 所有写入/删除操作增量维护索引

### 7.3 #2 compute_content_hash 分块读取

**文件**：`src/sync/utils.py`

- ≤ 1MB 文件保持全量读取（兼容性）
- \> 1MB 文件改为 256KB 分块读取 + incremental MD5
- 正确处理跨 chunk 边界的 CRLF 和 BOM
- 通过 5 个边界测试用例验证与全量读取结果一致

### 7.4 #3 scan_local 增加 size + cross_dir_dup 优化

**文件**：`src/sync/scanner.py` + `src/sync/moves.py`

- `scan_local` 用单次 `os.stat()` 获取 mtime 和 size（零额外开销）
- `_detect_cross_dir_duplicates` 第 2 步只 hash 与云端候选同名的本地文件（减少无效 I/O）
- 第 4 步（filename-only 匹配）增加 hash 验证：双方都有 hash 但不匹配时拒绝
- 效果：跨目录检测从 21 对降到 15 对（过滤了 6 个内容不同的误匹配）

### 7.5 #4 scanner lock 粒度优化

**文件**：`src/sync/scanner.py`

- `_fetch_dir` 改为本地 dict 积累结果，每个目录完成后一次性 `files.update()`
- lock 获取次数从 O(F)（每文件一次）降到 O(D)（每目录一次）

### 7.6 #5 跨模块 hash_cache

**文件**：`src/sync/engine.py` + `decision.py` + `moves.py` + `dedup.py`

- engine 在 `sync()` 开始时创建 `_hash_cache: Dict[str, str]`
- 贯穿 calibrate → reconcile → upload/download → dedup 全流程
- 每个模块计算 hash 前先查 cache，计算后写入 cache
- 消除了同一文件在一次同步中被 hash 多达 4 次的问题

### 7.7 #6 hash_index 升级为 List-based

**文件**：`src/sync/metadata.py`

- `_hash_index` 从 `Dict[str, str]` 改为 `Dict[str, List[str]]`
- `remove_file()` 和 `update_content_hash()` 从 O(n)（全表扫描修复）降到 O(1)
- `find_cloud_file_by_hash()` 遍历 list 找第一个有 file_id 的

### 7.8 #8 engine 嵌套锁解除

**文件**：`src/sync/engine.py`

- `_record_file_change` 中 metadata 操作移到 engine lock 外面
- metadata 自身有线程安全保证，不需要 engine lock 保护
- 消除了 engine._lock → metadata._lock 的嵌套获取

### 7.9 #9 scanner BFS 改 queue-based

**文件**：`src/sync/scanner.py`

- 移除 level-by-level barrier，改为共享 queue + 完成计数器
- worker 空闲时立即从 queue 取下一个目录处理，无层级等待
- 对深窄目录树能减少空闲等待（实测笔记目录多为浅宽，影响有限）

### 7.10 #10 scan_local 多线程

**文件**：`src/sync/scanner.py`

- 先用 `os.scandir` 列出顶层条目（避免遍历整个树再分工）
- 每个顶层子目录在独立线程中并行 `os.walk`
- worker 数 = min(顶层子目录数, CPU 核数, 8)
- 各线程独立积累结果 dict，最后合并（无 lock 竞争）
- 提取 `_add_local_file` 公用函数，消除根目录文件和子目录文件的重复逻辑

### 7.11 #11 分离上传/下载线程池

**文件**：`src/sync/engine.py`

- 上传和下载不再共用同一个线程池
- 上传用 UPLOAD_WORKERS(5) 线程，下载用 DOWNLOAD_WORKERS(10) 线程
- 两个池同时工作，用 `as_completed` 统一收集结果
- 消除了"有上传时下载并发数被降到 5"的问题

### 7.12 #12 print_dryrun_summary 单次遍历

**文件**：`src/sync/utils.py`

- 从 5 次列表推导 + 1 次 sum 改为单次 for 循环分桶
- Counter 也改为直接用生成器表达式，减少中间列表

---

## 8. 优先级路线图

### 高优先级（收益大 / 改动小）— ✅ 全部完成

| # | 优化项 | 模块 | 状态 |
|---|--------|------|------|
| 1 | metadata.find_by_file_id 加反向索引 | metadata.py | ✅ 完成 |
| 2 | compute_content_hash 分块读取（大文件） | utils.py | ✅ 完成 |
| 3 | scan_local 增加 size + cross_dir_dup 预过滤 | scanner.py + moves.py | ✅ 完成 |
| 4 | scanner 减少 lock 粒度（per-dir batch） | scanner.py | ✅ 完成 |

### 中优先级（收益中等 / 改动中等）— ✅ 全部完成

| # | 优化项 | 模块 | 状态 |
|---|--------|------|------|
| 5 | 跨模块 hash_cache | engine + decision + moves + dedup | ✅ 完成 |
| 6 | hash_index 改为 hash → List[path] | metadata.py | ✅ 完成 |
| 7 | dedup 复用 sync 阶段 hash_cache | dedup.py | ✅ 完成（包含在 #5 中） |
| 8 | engine._record_file_change 解除嵌套锁 | engine.py | ✅ 完成 |

### 低优先级（收益小或改动大）— ✅ 全部完成

| # | 优化项 | 模块 | 状态 |
|---|--------|------|------|
| 9 | scanner BFS 改 queue-based | scanner.py | ✅ 完成 |
| 10 | scan_local 多线程 | scanner.py | ✅ 完成 |
| 11 | 分离上传/下载线程池 | engine.py | ✅ 完成 |
| 12 | print_dryrun_summary 单次遍历 | utils.py | ✅ 完成 |
