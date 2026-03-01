# 向 Git 学习：同步引擎可借鉴的设计与算法

> 分析 Git 内部机制中哪些设计理念和算法可以应用到有道云笔记同步场景，并评估每项的实用性和实现成本。
>
> **实施状态：Section 二中 6 项全部完成，Section 三~五中 Bloom Filter、Merkle Tree 已实现（2026-03-01）**

## 一、已借鉴并实现的

| Git 概念 | 我们的实现 | 状态 |
|----------|----------|------|
| Content-addressable（按内容 hash 寻址） | `compute_content_hash` + `decide_action` 中 hash 参与决策 | ✅ 已实现 |
| 原子写入（先写对象再更新 ref） | download.py `_atomic_write` (temp + `os.replace`) + SQLite WAL | ✅ 已实现 |
| index.lock（并发保护） | `_SyncLock` PID lock file | ✅ 已实现 |
| 删除追踪 | `last_sync_at` 列区分"删除"和"从未同步" | ✅ 已实现 |
| 三方比较（base/ours/theirs） | 三方 hash 比较（local_hash / cloud_hash / meta_hash） | ✅ 已实现 |

## 二、值得借鉴但尚未实现的

### 2.1 操作日志（对标 Git reflog） — ✅ 已实现

**Git 做法**: reflog 记录每次 HEAD 和分支指针的变动，即使 reset --hard 也能恢复。

**我们的场景**: ~~每次同步的操作记录目前只在 stdout/log 中，同步结束就丢了。~~ 已通过 `sync_log` 表持久化记录。

**实现**:
```sql
CREATE TABLE sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    path TEXT NOT NULL,
    action TEXT NOT NULL,        -- download/upload/skip/conflict/delete
    direction TEXT,              -- pull/push
    old_hash TEXT,               -- 操作前的 content_hash
    new_hash TEXT,               -- 操作后的 content_hash
    cloud_id TEXT,
    detail TEXT                  -- 额外说明（如冲突备份路径）
);
CREATE INDEX idx_sync_log_ts ON sync_log(timestamp);
CREATE INDEX idx_sync_log_path ON sync_log(path);
```

**价值**: 可审计、可回溯、可以支持"撤销上次同步"。

**实现位置**: `metadata.py` — `sync_log` 表 + `_record_file_change` 中写入 + `get_sync_log()` 查询。

---

### 2.2 完整性校验（对标 git fsck） — ✅ 已实现

**Git 做法**: `git fsck` 遍历所有对象，验证 hash 是否与内容一致、引用是否有效。

**实现**: `metadata.verify(local_dir, auto_fix=False)` 方法：
- 遍历 files 表：检查 `content_hash` 是否与本地文件实际 hash 一致
- 遍历 files 表：检查 `file_id` 是否在云端仍然存在
- 遍历 directories 表：检查 `dir_id` 是否有效
- 发现不一致时：报告 + 可选自动修复

**实现位置**: `metadata.py` — `verify()` 方法。

---

### 2.3 行级三路合并（对标 git merge-file） — ✅ 已实现

**Git 做法**: 对文本文件，找到三方共同祖先版本（base），分别 diff base↔ours 和 base↔theirs，自动合并非重叠区域，只有同一行被两边同时修改才标记 `<<<<<<<` 冲突。

**实现**: `sync/merge.py` — `MergeResult` dataclass + diff3 算法：
- base = `meta_hash` 对应的内容（上次同步时的版本，需要额外存储）
- ours = 本地文件内容
- theirs = 云端文件内容
- 用 diff3 算法合并

**价值**: 大幅减少需要手动处理的冲突。

**实现位置**: `sync/merge.py` — base 版本通过 `file_base` 表存储（`metadata.py`）。

---

### 2.4 垃圾回收（对标 git gc） — ✅ 已实现

**Git 做法**: 定期清理不可达对象、压缩 packfile。

**实现**: `metadata.gc(local_dir, max_log_age_days=90)` 方法：
- 扫描 files 表，如果 `last_sync_at` 远早于当前时间（如 >30 天）且本地和云端都不存在 → 删除记录
- 扫描 directories 表，如果对应目录在本地和云端都不存在 → 删除记录
- 清理 sync_log 中超过 90 天的旧记录

**实现位置**: `metadata.py` — `gc()` 方法。

---

### 2.5 选择性同步（对标 git sparse-checkout） — ✅ 已实现

**Git 做法**: 只检出仓库的部分目录，其余文件不下载到工作区。

**实现**: `SyncManager` 接受 `sync_include` / `sync_exclude` 参数，`scanner.py` 中有 `matches_selective()` 和 `compile_selective_filter()` 函数在扫描阶段过滤文件。

**实现位置**: `sync/engine.py` — `sync_include`/`sync_exclude` 参数；`sync/scanner.py` — `matches_selective()` + `compile_selective_filter()`。

---

### 2.6 传输优化（对标 git pack protocol）

**Git 做法**: smart HTTP/SSH 协议只传输本地没有的对象，且用 delta 压缩（只传差异）。

**我们的场景**: 每次下载/上传都是全量文件传输。一个 100KB 的 .md 文件只改了一行，仍然传 100KB。

**受限于 API**: 有道云 API 不支持 delta 传输。但我们可以在客户端做优化：
- **hash 短路**: 上传前检查 `content_hash` 是否与云端相同，相同则跳过（已实现）
- **大文件分块**: 对于大附件，实现断点续传（API 是否支持需要测试）

**价值**: 中等。大部分笔记文件很小（<100KB），delta 优化收益有限。

**成本**: hash 短路已实现；delta 需要 API 支持，不可行。

---

## 三、比对算法分析

### 3.1 当前使用的算法

| 算法 | 用途 | 复杂度 | 说明 |
|------|------|--------|------|
| MD5 全文 hash | 文件变化检测 | O(n) 其中 n=文件大小 | 快速判断"是否变了"，无法说明"变了什么" |
| mtime 比较 | 快速粗筛 | O(1) | 不可靠但极快，用于第一层过滤 |
| 逐文件全量传输 | 同步执行 | O(文件大小) | 无差异传输能力 |

### 3.2 可引入的算法

#### (A) Myers diff 算法 — 文本差异计算

**来源**: Git 的默认 diff 算法（`git diff`），由 Eugene Myers 1986 年提出。

**原理**: 将两个文本序列的差异问题转化为图上最短编辑路径问题。在一个 edit graph 上寻找从 (0,0) 到 (N,M) 的最短路径，每步可以向右（删除）、向下（插入）或对角（保留）。

**复杂度**: O(ND)，其中 N+M 为两文本总行数，D 为最小编辑距离。对相似文本（D 很小）非常快。

**用途**:
- 行级 diff：展示两个版本之间的精确差异
- 三路合并的基础：diff base↔local + diff base↔cloud → merge

**Python 实现**: `difflib.SequenceMatcher`（标准库，Ratcliff/Obershelp 算法）或 `diff-match-patch`（Google 开源，Myers 变体）。

**适用场景**: .md 文本文件冲突时，展示差异并尝试自动合并。

---

#### (B) diff3 三路合并算法

**来源**: Git merge 的核心。由 Sanjeev Khanna 等提出，GNU diff3 实现。

**原理**:
```
      base（共同祖先）
      /          \
   ours         theirs
  (本地)        (云端)
```
1. 计算 diff(base, ours) → 本地的修改集
2. 计算 diff(base, theirs) → 云端的修改集
3. 合并两个修改集：
   - 不重叠的修改 → 自动合并
   - 重叠的修改（同一区域被两边改了）→ 标记冲突

**复杂度**: O(ND1 + ND2)，D1/D2 分别是两端的编辑距离。

**前提条件**: 需要存储 base 版本。这是最大的实现成本 —— 当前我们只存了 base 的 hash 而没有存内容。

**存储 base 版本的方案**:

| 方案 | 存储成本 | 实现复杂度 |
|------|---------|-----------|
| 每次同步后把文件内容存到 SQLite BLOB | 高（每个文件存一份） | 低 |
| 只存 .md 文件的 base（二进制文件不做合并） | 中 | 低 |
| 存 delta（base→current 的差异） | 低 | 高 |
| 利用 Git 仓库本身（我们已经有 auto_git 功能） | 零额外存储 | 中 |

**推荐**: 利用已有的 Git 自动提交功能。每次同步成功后 `auto_git` 已经提交了变更，所以 Git 历史中天然就有 base 版本。三路合并时从 Git 历史取 base：
```python
# 获取上次同步提交时的文件内容（即 base）
base_content = git.show(f"HEAD~1:{relative_path}")
```

**适用场景**: .md 文件双方都编辑了不同段落 → 自动合并成功，无需用户干预。

---

#### (C) Rolling hash (Rabin fingerprint) — 块级变化检测

**来源**: rsync 算法的核心，也用于 Git 的 delta 压缩。

**原理**: 用滑动窗口计算块级 hash。对文件分块，每块算一个 hash 指纹。比较两个版本时，只有 hash 不同的块需要传输。

**算法步骤**:
1. 将文件按固定大小（如 4KB）分块
2. 对每块计算 rolling hash（Rabin 多项式）
3. 发送端发送 block hash 列表
4. 接收端对比自己的 block hash → 只请求不同的块
5. 重组文件

**复杂度**: O(n) 计算 hash，O(b) 传输差异（b = 变化的块数）。

**限制**: 有道云 API 不支持块级传输。但可以用于**本地**优化：
- 大文件变化检测：不需要读完整个文件，只扫描变化的块
- 本地缓存失效判断：检查某个块是否与缓存一致

**适用场景**: 如果未来有自建同步服务器（而非依赖有道云 API），rsync 式块传输能大幅减少网络流量。当前场景下价值有限。

---

#### (D) Bloom filter — 快速集合存在性判断

**来源**: Git 用 bloom filter 加速 `git log --path` 查询（commit-graph 中的 changed-path bloom filter）。

**原理**: 概率数据结构，用极小空间（几 KB）表示一个包含上万元素的集合。查询"元素是否在集合中"：
- 回答"不在" → 100% 准确
- 回答"在" → 可能是误报（假阳性率可控，如 1%）

**适用场景**:
- **快速跳过无变化目录**: 为每个目录维护一个 bloom filter（包含该目录下所有文件的 hash）。同步时先查 bloom filter，如果整个目录的 hash 集合没有变化 → 跳过该目录的详细扫描。
- **去重加速**: 上传前快速判断"云端是否已有相同 hash 的文件"，避免查 SQL。

**复杂度**: O(k) 查询（k = hash 函数个数，通常 3-7）。

**价值**: 对大型笔记库（1000+ 文件）有明显加速。对小型库意义不大。

---

#### (E) Merkle tree — 目录级快速比较

**来源**: Git 的 tree 对象本质就是 Merkle tree。每个目录的 hash 由其子文件/子目录的 hash 决定。

**原理**:
```
       root_hash = hash(dir_a_hash + dir_b_hash)
      /                                       \
dir_a_hash = hash(file1_hash + file2_hash)   dir_b_hash = hash(file3_hash)
    /              \                              |
file1_hash     file2_hash                    file3_hash
```

任何文件变化会向上传播，改变所有祖先目录的 hash。比较两个版本时从根开始：
- 根 hash 相同 → 整棵树没变，完全跳过
- 根 hash 不同 → 递归到子树，只展开 hash 不同的分支

**复杂度**: 比较操作 O(k * log(N))，k = 变化的文件数，N = 总文件数。全量扫描是 O(N)。

**适用场景**: 增量同步。当笔记库很大（几千文件）但只改了几个时，Merkle tree 能快速定位变化，不需要扫描所有文件。

**实现方式**:
```sql
-- 在 directories 表增加
ALTER TABLE directories ADD COLUMN tree_hash TEXT;
```
- 每次同步成功后，自底向上重算每个目录的 tree_hash
- 下次同步开始时，从根目录的 tree_hash 开始比较
- hash 相同的子树整个跳过

**价值**: 对大型笔记库的增量同步有显著加速。

---

## 四、优先级排序

按"价值 / 成本"比排序：

| 排名 | 项目 | 价值 | 成本 | 状态 |
|------|------|------|------|------|
| 1 | 操作日志（reflog） | 高 | 低 | ✅ 已实现 — `sync_log` 表 |
| 2 | 选择性同步（sparse-checkout） | 高 | 低 | ✅ 已实现 — `sync_include`/`sync_exclude` |
| 3 | 垃圾回收（gc） | 中 | 低 | ✅ 已实现 — `metadata.gc()` |
| 4 | 完整性校验（fsck） | 中 | 中 | ✅ 已实现 — `metadata.verify()` |
| 5 | Merkle tree 增量比较 | 高 | 中 | ✅ 已实现 — `sync/merkle.py` |
| 6 | 行级三路合并（diff3） | 高 | 中 | ✅ 已实现 — `sync/merge.py` |
| 7 | Bloom filter 目录跳过 | 中 | 中 | ✅ 已实现 — `sync/bloom.py` |
| 8 | Rolling hash 块传输 | 低 | 高 | ⏸ 暂不实现 — API 不支持（`rolling_hash.py` 已就绪） |

## 五、算法复杂度汇总

| 算法 | 时间复杂度 | 空间复杂度 | 是否使用 | 实现位置 |
|------|-----------|-----------|---------|---------|
| xxHash 全文 hash | O(n) | O(1) | ✅ | `sync/utils.py` |
| mtime 比较 | O(1) | O(1) | ✅ | `sync/utils.py` — `decide_action` |
| Myers diff | O(ND) | O(D²) | ✅ | `sync/merge.py` (via difflib) |
| diff3 三路合并 | O(ND) | O(N) | ✅ | `sync/merge.py` |
| Rabin rolling hash | O(n) | O(块数) | ⏸ 就绪 | `sync/rolling_hash.py` |
| Bloom filter | O(k) 查询 | O(m) bits | ✅ | `sync/bloom.py` |
| Merkle tree 比较 | O(k·logN) | O(N) 节点 | ✅ | `sync/merkle.py` |

其中 n=文件大小, N=文件总数, D=编辑距离, k=变化文件数, m=filter 大小。

---

## 六、现有代码中的算法效率热点分析

通过逐模块审查，以下是当前实现中存在效率问题的具体位置和可优化方案。

### 6.1 扫描阶段：重复的文件系统遍历

**现状**: 一次同步流程中，文件系统被遍历多次：

| 遍历 | 位置 | 目的 |
|------|------|------|
| 第 1 次 | `scan_local()` | 收集本地文件列表 |
| 第 2 次 | `build_item()` → `compute_content_hash()` | 对每个需要决策的文件算 hash |
| 第 3 次 | `_detect_cross_dir_duplicates()` → `compute_content_hash()` | 跨目录匹配候选算 hash |
| 第 4 次 | `auto_dedup()` → `build_all_indexes()` | 去重阶段再次遍历 |

虽然 `hash_cache` 和 `local_files` 缓存避免了部分重复计算，但仍存在效率问题：
- `build_item` 对每个文件单独调用 `compute_content_hash()`，是串行 I/O
- 如果有 2000 个文件需要决策，就是 2000 次独立的文件读取

**优化方案 A — 批量预计算 hash**:
```
scan_local 时同步收集 stat 信息
    ↓
用 mtime 与 metadata 对比，筛出"可能变化"的文件（通常 <10%）
    ↓
只对这批文件并行计算 hash（线程池，复用 scan_local 的 ThreadPoolExecutor）
    ↓
后续所有模块从 hash_cache 直接取，零 I/O
```

**预期收益**: 大型笔记库（2000+ 文件）中，假设 90% 文件没变化，只需读 200 个文件而非 2000 个。且并行读取比串行快 4-8 倍。

**复杂度变化**: O(N) → O(C)，其中 C = 真正变化的文件数。

---

### 6.2 跨目录匹配：O(L × C) 文件名比较

**现状** (`moves.py` 第 231-270 行):

```python
# 第 4 步：按文件名匹配
for lp in list(remaining_local):           # L 个本地文件
    norm = normalize_filename(basename(lp))
    candidates = cloud_name_index.get(norm)  # 查字典 O(1)
    for cp in candidates:                   # 最坏 C 个候选
        depth = _common_ancestor_depth(lp, cp)  # O(路径深度)
```

`cloud_name_index` 已经是 hash 索引（O(1) 查找），但内层循环对每个候选计算 `_common_ancestor_depth` 是 O(路径深度)。加上外层 L 个文件，最坏是 O(L × C × D)。

**当前缓解**: `_MAX_NAME_CANDIDATES = 10` 限制了 C ≤ 10。

**优化方案**: 这部分已经足够高效。如果需要进一步优化：
- 可以用 trie（前缀树）索引路径前缀，把 `_common_ancestor_depth` 从逐字符比较变成 trie 查询
- 但实际场景中 C ≤ 10 且路径深度通常 ≤ 5，优化收益极小

**结论**: 不需要优化。

---

### 6.3 Hash 算法选择：MD5 vs xxHash

**现状**: 使用 MD5（`hashlib.md5`），每个文件完整读取一遍。

**性能对比**（1MB 文件，Python 3.11，单线程）:

| 算法 | 速度 | 安全性 | 我们的用途 |
|------|------|--------|-----------|
| MD5 | ~400 MB/s | 已被攻破（碰撞） | 内容比对（非安全） |
| SHA-256 | ~250 MB/s | 安全 | 无需 |
| xxHash (xxh3_64) | ~10 GB/s | 非密码学 | 内容比对（非安全） |
| BLAKE3 | ~4 GB/s | 安全 + 极快 | 内容比对 + 安全 |

我们用 hash 只是判断"内容是否相同"，不需要密码学安全性（不防攻击者伪造文件）。MD5 碰撞概率在笔记同步场景下可以忽略（去重模块已有 `_classify_duplicates` 用文件大小双重校验）。

**优化方案**: 替换 MD5 为 `xxhash.xxh3_128`：
- 速度提升 ~25 倍（纯计算），I/O 瓶颈下约 2-5 倍实际提升
- 128 bit 输出，碰撞概率与 MD5 相当
- `pip install xxhash`，纯 C 扩展，无额外依赖链

**适用条件**: 新安装可以直接用 xxhash；已有的 content_hash 列存的是 MD5，需要做一次迁移（清空 content_hash 列让下次同步重算）。

**替代方案**: 如果不想加依赖，Python 3.11+ 的 `hashlib` 自带 `blake2b`，速度约 MD5 的 2 倍。

---

### 6.4 calibrate_metadata：逐条 SQL 写入

**现状** (`decision.py` 第 35-79 行):

```python
for rel in cloud_files:           # N 个文件
    meta = metadata.get_file_info(rel)    # 1 次 SELECT
    ...
    metadata.set_file_info(...)           # 1 次 INSERT/UPDATE
    metadata.mark_synced(...)             # 1 次 UPDATE
```

对 N 个文件做 3N 次 SQL 操作，每次都要获取/释放 Python threading lock。

**优化方案 — 批量操作**:

```python
with metadata.batch():
    for rel in cloud_files:
        # 所有操作在同一事务中，退出时一次 commit
        meta = metadata.get_file_info(rel)
        metadata.set_file_info(...)
        metadata.mark_synced(...)
```

`metadata.batch()` 已经存在，但 `calibrate_metadata` 没有使用它。包在 `batch()` 中可以：
- 减少 N 次 `commit()` 到 1 次
- SQLite WAL 下单事务批量写入比逐条写入快 10-50 倍
- 锁获取从 3N 次降到 1 次

**预期收益**: 对 500 个文件的校准从 ~2 秒降到 ~0.1 秒。

---

### 6.5 build_item 中逐文件计算 hash

**现状** (`decision.py` 第 111-116 行):

```python
for p in all_paths:                           # N 个文件
    build_item(p, ..., hash_cache=self._hash_cache)
        # 内部:
        local_hash = hash_cache.get(abs_path) or compute_content_hash(abs_path)
```

cache miss 时串行读文件并算 hash。如果 hash_cache 为空（首次运行），N 个文件全部串行计算。

**优化方案 — 提前并行预热 hash_cache**:

在 `_async_collect_items` 中，`scan_local` 返回后、`build_item` 之前，用线程池对"可能需要 hash"的文件并行计算：

```python
# scan 完成后
need_hash = [
    local_files[rel]["path"]
    for rel in (set(cloud_files) & set(local_files))  # 两端都有的才需要比较
    if not hash_cache.get(local_files[rel]["path"])
]
# 并行计算
await asyncio.gather(*[
    asyncio.to_thread(compute_content_hash, path) for path in need_hash
])
```

**预期收益**: 对 500 个两端都有的文件，从串行 ~5 秒降到并行 ~1 秒。

---

### 6.6 冲突精炼：逐个下载云端内容

**现状** (`engine.py` `_refine_conflicts`):

对每个 CONFLICT 项调用 `api.get_file_by_id` 下载完整文件内容，只为算一个 hash。

**优化方案 A — 只读前 N 字节**:
对于大文件，如果前 4KB 的 hash 就不同，不需要读完整个文件。但 API 不支持 Range 请求，此方案不可行。

**优化方案 B — 缓存云端 hash**:
如果上次同步时记录了当时的 cloud_hash（上传/下载成功后），下次比较时直接用缓存，不需要重新下载。

实现：在 metadata 中增加 `cloud_content_hash` 列，每次下载/上传成功后记录。下次检测冲突时，如果 `cloud_mtime == meta_cloud_mtime`（云端没变），直接用缓存的 `cloud_content_hash`。

**适用条件**: 只有云端真正变了（mtime 不同）才需要下载验证。如果云端没变，缓存的 hash 就是准确的。

---

### 6.7 去重模块：重复构建引用索引

**现状** (`dedup.py` `build_all_indexes`):

每次同步后如果有文件变动，去重模块会读取所有 .md 文件内容来构建引用索引（查找 `![](path)` 和 `src="path"` 链接）。对 1000 个 .md 文件，就是 1000 次文件读取。

**优化方案 — 增量引用索引**:

在 metadata 中缓存每个 .md 文件的引用列表：
```sql
CREATE TABLE file_refs (
    source_path TEXT,
    ref_path TEXT,
    PRIMARY KEY (source_path, ref_path)
);
```

只有当 .md 文件的 content_hash 变化时才重新解析其引用。未变化的文件直接从缓存取。

**预期收益**: 通常只有几个 .md 文件变化，从读 1000 个文件降到读 ~5 个。

---

### 6.8 scan_local 的 stat 调用优化

**现状**: `scan_local` 对每个文件调用 `os.stat()` 获取 mtime。在 Windows 上，`os.scandir()` 返回的 `DirEntry` 对象已经缓存了 stat 结果。

**当前代码** (`scanner.py` 第 253-266 行):
```python
for entry in top_entries:
    if entry.is_dir(follow_symlinks=False):
        rel = ...
        root_files[rel] = {"path": entry.path, "is_dir": True,
                           "mtime": int(entry.stat().st_mtime)}
```

顶层用了 `entry.stat()`（利用 DirEntry 缓存），但 `_walk_subdir` 里的 `os.walk` + `os.path.getmtime` 无法利用此缓存。

**优化方案**: 用 `os.scandir` 替代 `os.walk`，自己递归遍历：

```python
def _scandir_recursive(path, local_dir, partial):
    with os.scandir(path) as it:
        for entry in it:
            if entry.name.startswith("."):
                continue
            stat = entry.stat(follow_symlinks=False)
            if entry.is_dir(follow_symlinks=False):
                _scandir_recursive(entry.path, local_dir, partial)
            elif entry.is_file(follow_symlinks=False):
                partial[rel] = {"path": entry.path, "mtime": int(stat.st_mtime)}
```

**预期收益**: Windows 上约 30% 加速（减少额外的 stat 系统调用）。Linux 上差别不大（os.walk 内部已优化）。

---

## 七、优化优先级排序

按"收益 / 实现成本"排序：

| 排名 | 优化项 | 收益 | 成本 | 位置 |
|------|--------|------|------|------|
| 1 | calibrate_metadata 用 batch() | 10-50x 校准速度 | 3 行代码 | decision.py |
| 2 | build_item 前并行预热 hash_cache | 4-8x hash 计算速度 | ~15 行 | engine.py |
| 3 | MD5 → xxhash/blake2b | 2-25x hash 速度 | ~10 行 + 依赖 | utils.py |
| 4 | 增量引用索引 | 避免读 N 个 .md | ~40 行 + schema | dedup.py |
| 5 | 云端 hash 缓存 | 避免冲突精炼时下载 | ~15 行 + schema | engine.py + metadata.py |
| 6 | scan_local 用 scandir 替代 walk | ~30% 扫描加速(Win) | ~20 行 | scanner.py |
| 7 | Merkle tree 目录级比较 | O(N) → O(k·logN) | ~80 行 + schema | 新模块 |
