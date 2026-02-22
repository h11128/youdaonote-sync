# 同步引擎加固计划

> 基于与 Git 模型的对比分析，针对数据安全、正确性、网络健壮性三个维度的 5 项改进。

## 背景

当前同步引擎与 Git 等成熟同步系统的关键差距：

| 维度 | Git | 当前实现 | 目标 |
|------|-----|---------|------|
| 决策依据 | content hash（确定性） | mtime（不确定性） | content hash 参与决策 |
| 崩溃安全 | 先写对象再更新 ref（原子） | 直接写目标文件（非原子） | temp + rename |
| 删除处理 | commit 中显式记录 | 无法区分"删除"和"不存在" | delete tracking |
| 并发控制 | index.lock | 无 | PID lock file |
| 网络韧性 | transport retries 仅连接层 | 同上 | 应用层 retry + backoff |

## Feature 1: 写入原子化

**现状**: download.py 已有 `_atomic_write`（temp → `os.replace`）；SQLite WAL 保护元数据事务。

**改动**:
- `metadata.py`: `save()` 中加 `PRAGMA wal_checkpoint(PASSIVE)` 定期刷 WAL 到主文件，防止 WAL 无限增长和断电丢数据。

**改动量**: ~5 行

## Feature 2: 文件锁

**目标**: 防止多个同步进程同时运行导致数据竞争。

**方案**: PID lock file（跨平台，无外部依赖）

**设计**:
```
.sync.lock 文件内容:
{"pid": 12345, "started": "2026-02-22T10:00:00"}
```

- `sync()` 入口: 尝试获取锁 → 失败则检查 PID 是否存活 → 存活则退出，不存活则接管
- `sync()` 结束/异常: 释放锁

**改动文件**: `engine.py`（加 `_acquire_lock` / `_release_lock`）

**改动量**: ~40 行

## Feature 3: Delete Tracking

**目标**: 区分"用户主动删除"和"从未同步过"，防止删除后文件被重新下载/上传。

**方案**: 在 metadata 中记录文件的最后同步时间

**Schema 变更**:
```sql
ALTER TABLE files ADD COLUMN last_sync_at INTEGER DEFAULT 0;
```

**决策逻辑变更**:

| 场景 | 旧行为 | 新行为 |
|------|--------|--------|
| 本地有 + 云端无 + 无元数据 | UPLOAD | UPLOAD（新文件） |
| 本地有 + 云端无 + 有元数据 | UPLOAD | SKIP（云端已删除） |
| 本地无 + 云端有 + 无元数据 | DOWNLOAD | DOWNLOAD（新文件） |
| 本地无 + 云端有 + 有元数据 | DOWNLOAD | SKIP（本地已删除） |

**保守策略**: 不自动传播删除（不删对面的文件），只跳过。避免数据丢失。

**改动文件**:
- `metadata.py`: schema + `mark_synced()` 方法
- `utils.py`: `decide_action` 加 `previously_synced` 参数
- `decision.py`: `build_item` 传递 previously_synced
- `engine.py`: 同步成功后调用 `mark_synced()`

**改动量**: ~60 行

## Feature 4: Retry + Backoff

**现状**: `httpx.HTTPTransport(retries=3)` 只处理连接层重试（TCP 连接失败、DNS 失败等），不处理 HTTP 5xx、超时等应用层错误。

**方案**: 指数退避重试装饰器

**设计**:
```python
def retry_with_backoff(fn, max_retries=3, base_delay=1.0, retryable=(httpx.TimeoutException, httpx.HTTPStatusError)):
    for attempt in range(max_retries + 1):
        try:
            return fn()
        except retryable as e:
            if attempt == max_retries:
                raise
            if isinstance(e, httpx.HTTPStatusError) and e.response.status_code < 500:
                raise  # 4xx 不重试
            delay = base_delay * (2 ** attempt)
            time.sleep(delay)
```

**应用位置**: `engine.py` 的 `_do_download` 和 `_do_upload`

**改动文件**: `utils.py`（retry 函数）、`engine.py`（包装调用）

**改动量**: ~40 行

## Feature 5: Content Hash 参与决策

**目标**: mtime 变了但内容没变时跳过同步，消除 mtime 不可靠带来的误操作。

**方案**: `decide_action` 新增 hash 参数

**决策逻辑**:
```
原逻辑: mtime 变了 → 需要同步
新逻辑: mtime 变了 → 检查 hash → hash 相同 → SKIP
                                → hash 不同 → 按原逻辑
```

具体场景:

| mtime 变化 | hash 变化 | 结果 |
|-----------|----------|------|
| 本地 mtime 变了 | hash 相同 | SKIP（touch 但没改内容） |
| 云端 mtime 变了 | hash 相同 | SKIP |
| 双方 mtime 都变了 | hash 相同 | SKIP |
| 双方 mtime 都变了 | hash 不同 | 原冲突逻辑 |
| mtime 没变 | — | SKIP（同原逻辑） |

**改动文件**:
- `utils.py`: `decide_action` 加 `local_hash` / `meta_hash` 可选参数
- `decision.py`: `build_item` 计算并传递 hash

**改动量**: ~30 行

## 实施顺序

按风险从低到高、依赖关系排列:

1. **Feature 1** (原子化) → 最小改动，独立
2. **Feature 2** (文件锁) → 独立，无依赖
3. **Feature 4** (Retry) → 独立，无依赖
4. **Feature 5** (Hash 决策) → 改 decide_action 签名，需更新所有调用方
5. **Feature 3** (Delete tracking) → 改 schema + decide_action，需 Feature 5 先就位

每完成一个 feature 运行测试验证无回归。

## 测试计划

每个 feature 对应的测试:

| Feature | 测试内容 |
|---------|---------|
| 1 | WAL checkpoint 调用验证 |
| 2 | 锁获取/释放、重复获取、PID 失效接管 |
| 3 | 删除后不重新下载/上传、新文件正常同步 |
| 4 | 重试次数、退避间隔、不可重试异常透传 |
| 5 | mtime 变 + hash 同 → SKIP；mtime 变 + hash 异 → 正常同步 |
| 6 | 三方 hash 收敛 → SKIP；cloud_hash == meta_hash → UPLOAD；bytes hash 与文件 hash 一致性 |

## Feature 6: 云端 Content Hash 精炼（追加）

**问题**: Feature 5 只对本地文件算 hash，云端变化仍依赖 mtime 判断。当双方 mtime 都变了但判为 CONFLICT 时，无法知道云端内容是否真正改变。

**方案**: 对 CONFLICT 项下载云端内容、计算 hash，用三方比较降级冲突。

**三方 Hash 决策矩阵**:

| local_hash vs meta | cloud_hash vs meta | local vs cloud | 结果 |
|---|---|---|---|
| 相同 | 相同 | 相同 | SKIP（三方一致） |
| 不同 | 相同 | — | UPLOAD（只有本地变了） |
| 相同 | 不同 | — | DOWNLOAD（只有云端变了） |
| 不同 | 不同 | 相同 | SKIP（双方改成一样的） |
| 不同 | 不同 | 不同 | CONFLICT/mtime 决定 |

**实现**:
- `utils.py`: `compute_hash_from_bytes()` — 从原始字节算 hash（与文件 hash 相同规范化）
- `utils.py`: `decide_action` 新增 `cloud_hash` 参数
- `engine.py`: `_refine_conflicts()` — 并发下载 CONFLICT 项云端内容，算 hash 后重新决策

**限制**: 只处理文本文件（.md, .txt 等），.note/.clip 因格式转换无法比较。

**改动量**: ~80 行代码 + 11 个测试
