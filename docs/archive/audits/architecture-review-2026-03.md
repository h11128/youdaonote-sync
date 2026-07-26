# 架构审查报告 — 2026-03-20

> **历史快照（已归档）**。文中“待修复问题”、测试数量、配置迁移状态等可能已过时。  
> 当前用法见 [README](../../../README.md)；文档索引见 [docs/README.md](../../README.md)。  
> 文中样例文件名已脱敏。

基于 dry-run + 实际同步执行 + 全量代码审阅产出。

## 1. 项目概况（2026-03-20 当日数据）

| 指标 | 值 |
|------|------|
| 源文件（非测试） | 104 个 .ts |
| 测试文件 | 60 个 .test.ts |
| 总代码行 | ~22,000 行 |
| 测试数 | 626 个，全部通过 |
| 被管理的笔记文件 | ~6,000 个 |
| 同步耗时（含网络） | ~7 秒 |

## 2. 同步流程概览

```
SyncEngine.sync()
  ├─ initXxhash()                   // WASM 模块加载
  ├─ loginByCookies()               // Cookie 认证
  ├─ SyncLock.acquire()             // 文件锁（dry-run 跳过）
  ├─ heal()                         // 元数据自愈（dry-run 跳过）
  ├─ obtainSnapshots()
  │    ├─ tryCachedCloudScan()      // 增量缓存 → 或 scanCloud() BFS 全量
  │    ├─ filterCloudSnap()         // include/exclude 过滤
  │    ├─ scanLocalParallel()       // 本地并行扫描
  │    ├─ calibrateMetadata()       // 元数据校准（补全缺失记录）
  │    ├─ computeHashesConcurrent() // content hash 计算（带缓存）
  │    └─ warmupHashCache()         // 补算两端都存在的文件 hash
  ├─ classifyAndRefine()
  │    ├─ classifyAll()             // 规则表匹配，产出 14 种状态
  │    ├─ detectMoves()             // 4 阶段移动检测
  │    ├─ discardOrphanDuplicates() // 孤儿去重
  │    └─ refineAllConflicts()      // 冲突精炼（下载云端内容比对 hash）
  ├─ filterByDirection()            // push/pull 方向过滤
  │
  ├─ [dry-run 分支] diagnoseDryrun() → printPreview + writeDryrunReport
  ├─ [执行分支]     runExecuteSync() → executeAll()
  │    ├─ 目录创建（download: mkdir / upload: cloud createDir）
  │    ├─ 下载（并发 5，atomic write，格式转换）
  │    ├─ 上传（并发 5，hash 去重检查）
  │    ├─ 冲突（diff3 合并 → fallback 备份+下载）
  │    └─ 移动（云端 rename/move API）
  └─ runPostSyncCleanup()
       ├─ cleanupStalePaths()       // 清理失效的 cloud path
       ├─ gc()                      // 垃圾回收（过期记录、孤儿目录、旧日志）
       ├─ autoDedup()               // 自动去重
       └─ gitAutoCommit()           // 可选 git 提交
```

## 3. Dry-Run 实测结果 (2026-03-20)

| 类型 | 数量 | 文件 |
|------|------|------|
| ↓ Download | 7 | 若干近期笔记 |
| ↑ Upload | 4 | 一篇长文 + 两张 svg + 一篇新文档 |
| ⚡ Conflict | 0 | — |
| → Move | 0 | — |
| Unchanged | 6,019 | — |

### 可疑 UPLOAD 诊断

3 个标记为上传的文件（`chart-a.svg`、`long-note-v2.md`、`chart-b.svg`）触发了可疑 UPLOAD 警告。深入分析后确认全部是**正常的 localModified**：

- 本地文件 content hash 与 metadata 记录不同（确认内容发生了变化）
- 云端 mtime 未变化（cloudMtimeChanged = false）
- 分类规则：`localHashChanged=true + cloudMtimeChanged=false → localModified → upload`

结论：警告是防御性提示，这几个文件是正常修改后的上传。同步执行后二次 dry-run 确认 0 变更。

## 4. 发现的问题

### 4.1 构建和工程问题（影响基本可用性）

#### P1: `npm run build` 不工作

`package.json` 中 `"build": "tsup"`，但没有 tsup 配置文件。实际构建用的是 `tsc`（tsconfig.json 配置完整）。运行 `npm run build` 报错 "No input files"。

此外，之前 tsup 产出的 `dist/algo/xxhash.js` 把 `createRequire(import.meta.url)` 编译丢了，变成裸 `require()`，在 ESM 模式下直接崩溃。

**修复**：`"build": "tsc"` 或补全 tsup 配置。`devDependencies` 中的 `tsup` 如果不用就删除。

#### P2: 缺少 CLI 可执行入口

`createCli()` 只是一个导出函数，没有：
- 独立的入口文件调用 `createCli().parse()`
- `package.json` 中没有 `bin` 字段
- 没有 `#!/usr/bin/env node` shebang 脚本

目前运行命令的方式是 `node -e "import(...).then(m => m.createCli().parse())" -- sync`，极不直观。

**修复**：创建 `src/bin.ts` 入口 + 添加 `bin` 字段。

#### P3: 配置目录迁移只有警告没有行动

代码把配置目录迁移到了 `%APPDATA%/youdaonote-sync`，但旧配置在 `cwd/config/`。`warnIfLegacyConfig()` 只打印了一行警告，没有提供自动迁移或迁移命令。每次运行都要手动设 `YOUDAONOTE_CONFIG_DIR` 环境变量。

**修复**：添加 `migrate` 命令，或在检测到旧配置时交互式询问是否自动迁移。

### 4.2 Dry-Run 报告信息不足

#### I1: 可疑 UPLOAD 缺少分类原因

当前警告只说"曾在 xxx 同步过"，没有给出分类状态（如 `localModified`）和 hash 变化对比。诊断时需要额外运行 `diagnose decision` 才能定位原因。

**改进**：警告中直接附带分类状态和 `contentHash old=xxx → new=yyy`。

#### I2: 报告缺少文件大小和时间

dry-run 报告只列文件路径，不含文件大小、本地/云端修改时间。对于大批量同步，"这次要传多少数据"和"什么时候改的"是关键信息。

#### I3: 同步过程没有进度输出

下载 7 + 上传 4 个文件，过程完全静默，只在结尾输出一行 summary。没有 `[3/7] ↓ 文件名` 这样的进度。`--quiet` / `--verbose` 选项也缺失。

## 5. 架构层面的问题和改进方向

### 5.1 删除操作不传播

**现状**：`localDeleted` 和 `cloudDeleted` 都映射为 `skip`（state.ts L22-28）。

这意味着：
- 本地删除文件 → 云端**不会删除**
- 云端删除文件 → 本地**不会删除**

**影响**：两端的文件只增不减，删除操作被忽略。如果用户期望完整的双向同步，这是功能缺失。

**分析**：这可能是有意的保守设计（防止误删导致数据丢失）。但当前 dry-run 报告中也不会显示"被跳过的删除"，用户完全无感知。

**改进方向**：
1. 短期：dry-run 报告中增加"跳过的删除"区域，列出 `localDeleted` 和 `cloudDeleted` 的文件
2. 中期：增加 `--propagate-deletes` 选项，或者配置文件中可选开启
3. 长期：引入回收站机制——删除操作先移到 `.trash/`，N 天后真正清理

### 5.2 heal 阶段性能瓶颈

**现状**：`heal()` 在每次非 dry-run 同步前运行（engine.ts L99），遍历 metadata 中**所有**文件做 `existsSync()` + `statSync()` + 可能的 `computeContentHashFromFile()`。

```
healOrphanRecords → 遍历所有文件，existsSync()
healMtimeDrift   → 遍历所有文件，existsSync() + statSync() + hash
healHashBackfill → 遍历所有文件，existsSync() + statSync() + hash
```

当前 6,000 个文件还可接受，但：
- 三次遍历 `getAllFiles()` 产生三倍开销
- `statSync` 和 `computeContentHashFromFile` 是阻塞同步 I/O
- 随文件增长会成为瓶颈

**改进方向**：
1. 三次遍历合并为一次
2. 用 `scanLocalParallel()` 的结果驱动 heal，避免重复 `existsSync`/`statSync`
3. 加降频——每 N 次同步做一次完整 heal，平时只做轻量检查
4. hash 回填改为异步并发

### 5.3 hash 计算流水线可优化

**现状**：本地文件 hash 计算发生在三个阶段：

1. `calibrateMetadata()` — 对两端都有但 metadata 缺失的文件，同步算 hash（阻塞）
2. `computeHashesConcurrent()` — 对剩余未算的文件，并发算 hash（有缓存加速）
3. `warmupHashCache()` — 对"两端都有 + hashable 扩展名 + 还没算过"的文件，再补一轮

**问题**：
- 阶段 1 是同步阻塞，在 `batch()` 事务内逐个算
- 阶段 3 与阶段 2 部分重叠——已经在阶段 2 算过的文件，阶段 3 会跳过，但判断逻辑不太直观
- 总体来看，同一个文件可能被 3 个不同函数尝试处理

**改进方向**：
1. calibrate 阶段只标记"需要 hash"，不实际计算；推迟到阶段 2 统一并发处理
2. 删除阶段 3（warmupHashCache），将其功能合并到阶段 2 的过滤条件中
3. 整合后只有一个 hash 计算入口，逻辑更清晰

### 5.4 API 层 retry 嵌套

**现状**：`httpPost()` / `httpGet()` 内部已经用了 `retryWithBackoff()`（client.ts L74-108），但调用处又常再包一层 retry：

```typescript
// cloud.ts
data = await retryWithBackoff(() => api.getDirInfoById(dirId), retryOpts);

// executor.ts
const result = await retryWithBackoff(() => uploadFile(ulOpts));

// refine.ts
const raw = await retryWithBackoff(() => deps.api.getFileById(cloudFile.id));
```

**影响**：一个失败的请求最多会被 retry `(inner 2+1) × (outer 3+1) = 12` 次，且退避时间不协调。

**改进方向**：
1. 统一在 API 层做 retry，调用方不再包 retry
2. 或者 API 层只做一次请求，retry 全部放在调用层——但需要统一策略
3. 核心原则：retry 只在一个层级出现

### 5.5 云端缓存增量更新的 edge case

**现状**：`tryCachedCloudScan()` 通过 `listRecent(30)` 获取最近 30 条变更，对比 cached version 做增量更新。

**潜在问题**：
- 如果两次同步之间变更超过 30 条，增量窗口溢出 → 回退全量扫描。但 `listRecent` 的上限是 30（API 硬限制），无法调大
- `reconcileRecent()` 中 `allCovered = changed.length < recent.length`：如果恰好 30 条全部是新变更，`allCovered=false` → 回退全量扫描。这是正确的保守策略，但频繁全量扫描会影响性能
- 增量更新只处理新增/修改，**不处理删除**——如果云端删了一个文件，缓存中不会移除它
- **dry-run 也受 60 秒 TTL 影响**：`tryCachedCloudScan` 默认 60 秒 TTL，如果连续跑两次 dry-run 或者在 60 秒内云端有变更，dry-run 结果可能不准。dry-run 本身不应该被缓存"骗过"

**改进方向**：
1. 增量更新时检测被删除的文件（listRecent 可能不包含删除事件，需要找其他 API 或定期全量校准）
2. 添加定期强制全量扫描（如每 24 小时）作为补偿
3. dry-run 模式下使用 `cacheTtlSeconds: 0`，强制重新检查云端变更

### 5.6 锁的竞态窗口

**现状**：`SyncLock` 用文件锁实现互斥（lock.ts），takeover 逻辑是 `unlinkSync → openSync(O_CREAT|O_EXCL)`。

**问题**：`unlinkSync` 和 `openSync` 之间有竞态窗口——两个进程同时检测到 stale lock，都 unlink 后都尝试 create，其中一个 EEXIST 但被错误忽略（返回 false 而非 retry）。

**实际风险**：低。同时运行两个同步进程的场景不常见，且 1 小时 stale threshold 足够保守。

**改进方向**：如果以后支持 watch 模式下的并发，可以改用 `proper-lockfile` 库或用 SQLite advisory lock（已有 SQLite）。

### 5.7 错误处理粒度不足

**现状**：executor 中单文件执行错误被 catch 后只打印一行 `console.error`，然后 `stats.errors++` 继续执行。

```typescript
// executor.ts L84-87
} catch (e: unknown) {
  stats.errors++;
  console.error(`Error processing dir ${relPath}: ${formatError(e)}`);
}
```

**问题**：
- 没有 error 列表收集，同步完成后只报 "N errors"，不知道哪些文件失败了
- 没有区分暂时性错误（网络超时）和永久性错误（文件权限）
- 失败的文件在下次同步时可能反复失败

**改进方向**：
1. 收集失败文件列表和错误类型，在 summary 中输出
2. dry-run 报告中增加上次同步的失败记录
3. 可选的 `--retry-failed` 模式

### 5.8 scan 阶段的 async 和 sync 混用

**现状**：
- `scanLocalParallel()` 是全 async 的（使用 `fsPromises`）
- `scanLocal()` 是全 sync 的（使用 `readdirSync` + `statSync`）
- `calibrateMetadata()` 内部调用同步的 `computeContentHashFromFile()`
- `heal()` 全部是同步 I/O

两套 API 并存，阻塞版被用在了 sync 主流程的关键路径上（calibrate + heal）。

**改进方向**：统一为 async，让 event loop 不被长时间阻塞。对 SQLite 操作保持同步（better-sqlite3 的设计），但文件 I/O 一律 async。

## 6. 其他改进建议

| 项目 | 现状 | 建议 | 优先级 |
|------|------|------|--------|
| dry-run 报告位置 | `config/.local-reports/` | 改到 `localDir/.sync-reports/` 或可配置 | 低 |
| `diagnose summary` vs `sync --dry-run` | 两个入口做同样的 scan+classify | 统一底层，`diagnose summary` 复用 dry-run 输出 | 低 |
| 同步耗时统计 | 只有 profiler 模式才有分阶段计时 | 在普通模式也输出总耗时 | 低 |
| 云端扫描 BFS 并发数 | 硬编码 8 | 可配置或自适应 | 低 |
| upload 前的 hash 去重 | `findCloudFileByHash` 查 metadata | 只在 metadata 中查，未覆盖"云端有但 metadata 未记录"的情况 | 中 |
| 二进制文件上传 | 用 pushBinaryFile（multipart），但分类逻辑对二进制的支持有限 | 明确二进制文件的同步策略文档 | 低 |

## 7. 实现方案

分 8 个 Phase 执行，每个 Phase 结束后跑全量测试（626 tests）确认无回归。

### Phase 1: 构建和 CLI 基础设施 (P1 + P2)

**P1 修复 build**：`package.json` 中 `"build": "tsup"` → `"build": "tsc"`，删除 tsup 依赖。

**P2 添加 CLI 入口**：创建 `src/bin.ts`，内容为 `#!/usr/bin/env node` + `createCli().parse()`。`package.json` 添加 `"bin": { "youdaonote-sync": "./dist/bin.js" }`。

改动文件：`ts-src/package.json`、`ts-src/src/bin.ts`（新建）

- [x] P1: build 脚本改为 tsc，删除 tsup
- [x] P2: 创建 bin.ts 入口 + package.json bin 字段
- [x] 验证：`npm run build && node dist/bin.js sync --dry-run`

### Phase 2: 配置目录自动迁移 (P3)

`warnIfLegacyConfig()` 改为自动迁移：检测到旧配置且新目录为空时，自动复制 `config.json`、`cookies.json`、`sync_metadata.db` 到新位置。CLI 添加 `migrate` 子命令用于手动触发。

改动文件：`ts-src/src/util/config-dir.ts`、`ts-src/src/cli/cli.ts`

- [x] config-dir.ts: warnIfLegacyConfig → autoMigrateLegacyConfig，自动复制文件
- [x] cli.ts: 添加 migrate 子命令
- [x] 验证：删除 AppData 目录后运行，确认自动迁移

### Phase 3: Dry-Run 和同步体验改进 (I1 + I2 + I3 + 5.7)

**I1 可疑 UPLOAD 附带原因**：`collectUploadWarnings()` 增加 `classified` 参数，输出中附带 `state.kind` 和 hash 对比。

**I2 报告增加文件大小和时间**：`writeDryrunReport()` 增加 `cloudSnap` + `localSnap` 参数，每个文件行附带 size / mtime。

**I3 同步进度输出**：`runFileEntries()` 中每处理一个文件输出 `[n/total] ↓/↑ path`。

**5.7 错误列表收集**：`SyncStats` 增加 `failedFiles` 数组，catch 块 push 错误详情，summary 输出失败文件列表。

改动文件：`ts-src/src/engine/helpers.ts`、`ts-src/src/engine/helpers-dryrun.ts`、`ts-src/src/execute/executor.ts`、`ts-src/src/execute/types.ts`、`ts-src/src/cli/cli.ts`

- [x] I1: collectUploadWarnings 接收 classified，输出 state.kind + hash 对比
- [x] I3: executor runFileEntries 加进度计数器输出
- [x] 5.7: SyncStats 加 failedFiles 数组，catch 块收集，cli 输出
- [x] 验证：dry-run 查看增强报告，sync 查看进度输出

### Phase 4: 消除 retry 嵌套 (5.4)

策略：API 层（client.ts httpPost/httpGet）已有 retry，调用方不再包 retry。

删除以下位置的 `retryWithBackoff` 包装：
- `scan/cloud.ts` fetchDir 中的 `retryWithBackoff(() => api.getDirInfoById(dirId))`
- `execute/executor.ts` 中 `retryWithBackoff(() => uploadFile(ulOpts))` 和下载处
- `engine/refine.ts` 中 `retryWithBackoff(() => deps.api.getFileById(...))`

改动文件：`ts-src/src/scan/cloud.ts`、`ts-src/src/execute/executor.ts`、`ts-src/src/engine/refine.ts`

- [x] cloud.ts: fetchDir 中去掉外层 retryWithBackoff
- [x] executor.ts: upload/download 处去掉外层 retryWithBackoff
- [x] refine.ts: getCloudHash 中去掉外层 retryWithBackoff
- [x] 验证：626 tests 全通过

### Phase 5: heal 性能 + hash 流水线整合 (5.2 + 5.3 + 5.8)

核心思路：先 scan → 统一 computeHashesConcurrent → 用 localHashes 驱动 heal 和 calibrate。

**heal 拆分**：
- `healPreScan(meta, localDir, autoFix)` — 只做 orphan 清理 + zeroCloud 统计（不依赖 hash）
- `healPostHash(meta, localDir, localSnap, localHashes, autoFix)` — mtimeDrift + hashBackfill 使用 localHashes 而非 computeContentHashFromFile

**calibrate 改造**：`calibrateFileCase2` 不再调用 `computeContentHashFromFile`，只从 `localHashes` 读取。

**删除 warmupHashCache**：经分析，阶段 2 完成后 warmupHashCache 已是死代码。

**engine.ts 流程调整**：
```
syncInner:
  healPreScan()          // 不依赖 hash
  obtainSnapshots()      // scan + 统一 hash
  healPostHash()         // 用 localHashes
  classifyAndRefine()
```

改动文件：`ts-src/src/metadata/health.ts`、`ts-src/src/classify/calibrate.ts`、`ts-src/src/engine/engine.ts`、`ts-src/src/engine/helpers.ts`

- [x] health.ts: 拆分 heal → healPreScan + healPostHash
- [x] health.ts: healMtimeDrift/healHashBackfill 改为使用 localHashes 参数
- [x] calibrate.ts: calibrateFileCase2 不再调用 computeContentHashFromFile
- [x] engine.ts: syncInner 调用顺序调整
- [x] helpers.ts: 删除 warmupHashCache
- [x] engine.ts: scanLocalPhase 移除 warmupHashCache 调用
- [x] 验证：626 tests 全通过

### Phase 6: 删除传播 (5.1)

**新增 SyncAction**：`'deleteCloud' | 'deleteLocal'`。`stateToAction` 保持不变（向后兼容），在 engine 层通过 `mapDeleteActions(classified)` 在 `propagateDeletes=true` 时替换。

**配置**：`SyncEngineConfig` 增加 `propagateDeletes?: boolean`（默认 false）。CLI `sync` 增加 `--propagate-deletes` 选项。

**回收站**：删除前先移到 `{localDir}/.trash/{YYYY-MM-DD}/`，保留原始相对路径。不自动清理。

**executor 新增 handler**：
- `deleteCloud`：下载云端文件到 .trash → `api.deleteFile(fileId)` → `meta.removeFileInfo`
- `deleteLocal`：移动本地文件到 .trash → `meta.removeFileInfo`

**SyncStats 扩展**：增加 `deletedCloud` + `deletedLocal` 计数。

**dry-run 支持**：report 中增加 deleteCloud / deleteLocal 分组。

改动文件：`ts-src/src/types/state.ts`、`ts-src/src/types/engine-config.ts`、`ts-src/src/execute/types.ts`、`ts-src/src/execute/executor.ts`、`ts-src/src/engine/engine.ts`、`ts-src/src/engine/helpers.ts`、`ts-src/src/engine/helpers-dryrun.ts`、`ts-src/src/cli/cli.ts`

- [x] state.ts: 添加 deleteCloud / deleteLocal 到 SyncAction
- [x] engine-config.ts: 添加 propagateDeletes 选项
- [x] engine.ts: classify 后 collectDeleteOverrides
- [x] executor.ts: 添加 deleteCloud / deleteLocal handler + trash 逻辑
- [x] execute/types.ts: SyncStats 增加 deletedCloud / deletedLocal
- [x] helpers.ts: printPreview / dryRunStats / diagnoseDryrun 支持 deleteOverrides
- [x] helpers-dryrun.ts: REPORT_ORDER / REPORT_LABELS 增加 delete 类型
- [x] cli.ts: sync 添加 --propagate-deletes 选项
- [x] 验证：626 tests 全通过

### Phase 7: 云端缓存改进 (5.5 + 5.6)

**dry-run TTL 修复**：`engine.ts scanCloudPhase()` 中 dryRun 时传 `cacheTtlSeconds: 0`。

**24 小时强制全量扫描**：`cloud-cache.ts` 增加 `STATE_LAST_FULL_SCAN`，`tryCachedCloudScan()` 中检查距上次全量扫描 >24h 则返回 null。

**锁竞态注释**：`lock.ts` takeover 路径加显式注释说明 EEXIST 语义。

改动文件：`ts-src/src/engine/engine.ts`、`ts-src/src/scan/cloud-cache.ts`、`ts-src/src/util/lock.ts`

- [x] engine.ts: dryRun 时 cacheTtlSeconds: 0
- [x] cloud-cache.ts: 24h 强制全量扫描逻辑
- [x] lock.ts: takeover EEXIST 注释明确化
- [x] 验证：626 tests 全通过

### Phase 8: 小项改进 (§6)

**报告位置**：`diagnoseDryrun()` 调用处改为传 `localDir` 而非 `configDir`。

**同步耗时**：`cli.ts runSyncAction` 中记录开始/结束时间，summary 输出 `(耗时 Xs)`。

改动文件：`ts-src/src/engine/engine.ts`、`ts-src/src/cli/cli.ts`

- [x] engine.ts: diagnoseDryrun 传 localDir
- [x] cli.ts: sync 输出耗时
- [x] 验证：dry-run 报告保存到 localDir/.local-reports/，sync 输出耗时 ✓

## Appendix A: detectFileType Bug — Post-mortem (2026-03-23)

### 现象

若干近期笔记下载到本地后是 raw JSON 文本（有道笔记内部格式），而非可读 Markdown。文件以 `.md` 扩展名保存，在编辑器中打开是一堆 `{"2":"1","3":"Ju9C-...` 的 JSON 结构。

### 根因

`detectFileType(data, ext)` 的判断顺序错误：

```typescript
// BUG: 扩展名优先于内容检测
if (ext === '.md') return 'markdown';  // ← 直接返回，跳过内容检测
const prefix = ...;
if (prefix.startsWith('{"')) return 'json';  // ← 永远到不了
```

有道笔记 API 对 `domain=0`（NOTE 类型）的笔记返回 JSON 格式数据，即使文件名以 `.md` 结尾。`detectFileType` 看到 `.md` 就短路返回 `'markdown'`，后续 `convertToMarkdown` 对 `'markdown'` 类型只做 `Buffer.toString('utf-8')`——原封不动写入磁盘。

### 修复

内容检测提升到扩展名之前：先看字节前缀（`{"` → json, `<?xml` → xml, `<!DOCTYPE html` → html），都不匹配再按扩展名回退。

### 为什么会写出这个 bug

**1. 对有道笔记 API 的隐含假设没有验证**

写 `detectFileType` 时，隐含假设是：`.md` 文件 = API 返回纯文本 Markdown。这个假设来自对"文件扩展名反映内容格式"的日常直觉，没有用实际 API 响应验证过。有道笔记的 NOTE domain 笔记不管文件名叫什么，API 返回的是内部存储格式（XML 或 JSON），需要转换后才是 Markdown。

根本问题：**把外部系统的行为当作了常识，而不是需要验证的假设**。

**2. Python 版本的同一个 bug 被继承了**

Python 版 `_download_and_detect` 也有完全相同的逻辑：

```python
if youdao_file_suffix == MARKDOWN_SUFFIX:
    return FileType.MARKDOWN, None  # 同样的短路
```

TS 重写时"忠实移植"了这个行为。移植本身没有错误——问题是移植时没有带着怀疑的眼光审视被移植的逻辑。当源代码本身就有 bug 时，"精确移植"等于"精确复制 bug"。

**3. 测试只覆盖了已知路径**

`detectFileType` 的测试用例：
- `.md` 扩展名 + 空数据 → `'markdown'` ✓
- `.note` 扩展名 + JSON 数据 → `'json'` ✓

缺失的测试：`.md` 扩展名 + JSON 数据 → 应该是 `'json'`。测试设计时的思维模型和代码实现的思维模型完全一致——都假设 `.md` 扩展名等于 Markdown 内容。**当测试的假设和代码的假设相同时，测试无法发现 bug**。

**4. 更早一批笔记侥幸没有触发**

更早的一篇同类型笔记也是 `domain=0`，但 API 返回的恰好是 Markdown 格式（或者说该笔记本身就是纯 Markdown 存储的）。之后有道笔记后端对新创建的 NOTE 笔记切换到了 JSON 存储格式。这意味着这个 bug 从代码写出来那天就存在，只是直到外部条件变化（后端格式切换）才触发。

这是一类典型的潜伏 bug：**代码逻辑有缺陷，但恰好被外部环境掩盖，直到环境变化时才暴露**。

**5. 六轮 code audit 都没发现**

项目经历了六轮正式 audit（详见 git log），`detectFileType` 从未被标记为问题。原因：
- 函数只有 6 行，看起来"显然正确"
- 审查者也共享同一个隐含假设
- 没有用真实 API 数据做端到端验证（所有审查都是静态分析 + 单元测试）

### 教训

| # | 教训 | 可操作化 |
|---|------|----------|
| 1 | 外部 API 的行为是需要验证的假设，不是常识 | 对每个 API 调用，记录"预期响应格式"并用至少一个真实样本验证 |
| 2 | 移植时要审视源代码的假设，不仅仅是行为 | 移植 checklist 应包含"列出被移植函数的隐含假设" |
| 3 | 测试要包含"跨域"组合（扩展名 × 内容类型） | 对有多个输入维度的函数，写 cross-product 测试 |
| 4 | 端到端验证不可替代 | 每次同步功能变更后，对至少 3 个真实文件做 download → verify content 的 e2e check |
| 5 | "从没出过问题"不等于"没有 bug" | 对依赖外部系统行为的代码，定期用真实数据回归 |
