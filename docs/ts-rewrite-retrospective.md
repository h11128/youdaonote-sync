# TypeScript 重写复盘：遗漏分析与改进方案

> 日期：2026-03-02
> 触发事件：审查 12 个 commit（ca4e19c → c6f0a14）时发现 TS 重写相对 Python 实现存在多处算法 / 流程遗漏
> 修复 commit：（同日完成，见 git log）

---

## 一、发现了什么

审查发现 TS 代码库中有三类遗漏：

### 1. 已实现但未接入的模块

| 模块 | 状态 | 后果 |
|------|------|------|
| `classify/refine.ts` | 有实现、有测试、engine 未调用 | 所有 `cloudModifiedContent` 直接走 download，无法识别 mtime-only / 收敛 / 只有本地变 |
| `algo/merge.ts` | 有实现、有测试、executor 未调用 | 冲突文件直接 backup + download，不尝试自动合并 |
| `metadata/health.ts` 的 `heal()` | 有实现、有测试、engine 未调用 | mtime 漂移、孤立记录、hash 缺失不会被自动修复 |

### 2. 哈希算法不一致

| 组件 | 应用 | 实际用了 |
|------|------|----------|
| `hash.ts`（内容哈希） | xxHash-128（已安装 xxhash-wasm） | MD5 |
| `bloom.ts`（Bloom 过滤器） | xxHash-64 seed 0 + 0x9E3779B97F4A7C15 | SHA256 seed 0 + 0x9e37（截断） |
| `merkle.ts`（Merkle 树） | xxHash-128 | MD5 |
| `block-hash.ts`（块哈希） | xxHash-64 | MD5 |

`xxhash.ts` 封装已存在且有测试，但没有被其他模块引用。

### 3. 功能缺失

| 功能 | Python 位置 | TS 状态 |
|------|------------|---------|
| Markdown 格式归一化 | `utils.py` `normalize_md_formatting` | 未移植（哈希只做 CRLF→LF） |
| 同步锁 | `engine.py` `_SyncLock` | 未移植 |
| `merge.ts` splitLines | Python `splitlines(keepends=True)` 处理 CR/CRLF | 只处理 `\n` |

---

## 二、为什么会遗漏

遗漏不是单一环节的问题，是多个环节的防线同时失效。

### 2.1 设计阶段：没有功能移植清单

`typescript-rewrite-design.md` 花了 524 行定义架构、类型、Decision Table，但 **没有一个章节对照 Python engine 列出所有功能点和每一项的处置方案（移植 / 推迟 / 丢弃）**。

Refine 规则的数据结构在设计文档第 277-298 行被完整定义了，但"谁来调用 refine、在什么时机调用"只字未提。这导致实现者可以合理地认为"refine 模块写好了就行，后面会接"——但"后面"没有人跟踪。

**核心问题：** 设计文档面向"新系统如何自洽"，而不是面向"新系统是否覆盖旧系统的全部行为"。

### 2.2 开发阶段：大批量提交，模块先于集成

时间线：

```
2f3ddf7  +6227 行  feat: TypeScript rewrite Phase 1-3
d7ae5a0  +3818 行  wip
```

两次 commit 共 10000+ 行，囊括了几乎所有 TS 模块。开发策略是"先把所有模块写出来，再拼装"——但拼装这一步只完成了最小可用路径（scan → classify → execute），没有走完整路径（heal → scan → classify → refine → execute with merge）。

这违反了 dev practices 中"Large Refactors: Break them into phases with user checkpoints"的规则。正确的做法是：每加一个功能就写一个 commit + 测试，确保从 engine 到模块的完整链路跑通。

### 2.3 Review 阶段：只审结构不审功能对等性

SOLID 审查（`solid-and-dev-practice-audit-ts.md`）检查了：
- 单一职责、依赖方向、前置条件、类型安全、DRY、不可变性

**没有检查：**
- "Python engine 有 heal()，TS engine 有吗？"
- "Python executor 有 diff3 merge，TS executor 有吗？"
- "bloom.ts 的哈希函数和已有的 xxhash.ts 一致吗？"

Review 的 checklist 全是结构性的，没有"功能对等性"这一维度。

### 2.4 测试阶段：单元全绿但缺集成验证

| 模块 | 单元测试 | 集成验证 |
|------|---------|---------|
| `refine.ts` | 5 个测试，全绿 | engine 从未调用 — 未被发现 |
| `merge.ts` | 7 个测试，全绿 | executor 从未调用 — 未被发现 |
| `health.ts` heal | 3 个测试，全绿 | engine 从未调用 — 未被发现 |
| `engine.test.ts` | **1 个测试**（只测 dryRun） | 非 dryRun 路径完全未覆盖 |

每个模块独立测试都是正确的，但 **模块之间的接线从未被验证**。这是典型的"单元测试全绿但集成有洞"。

### 2.5 跟踪阶段：临时方案没有 TODO

`hash.ts` 用 MD5、`bloom.ts` 用 SHA256 是"先用 Node 内置 crypto 跑通"的临时方案。但代码中没有 `TODO: 替换为 xxhash` 标记，也没有 issue 跟踪。测试不检查具体哈希值（只检查一致性），所以临时方案在所有自动化检查中都是隐形的。

---

## 三、已完成的修复

| 修复项 | 改动 |
|--------|------|
| 哈希统一 | `hash.ts` MD5 → xxHash-128；`bloom.ts` SHA256 → xxh64Raw + 正确 seed；`merkle.ts` MD5 → xxh128；`block-hash.ts` MD5 → xxh64 |
| Markdown 归一化 | `hash.ts` 新增 `normalizeMdFormatting()`，.md/.txt 哈希前归一化 |
| Bloom seed 修正 | 第二个 seed 从 `0x9e37` 修正为 `0x9e3779b97f4a7c15n` |
| merge splitLines | `split(/\n/)` → `split(/\r\n|\r|\n/)` |
| engine 调用 heal | 同步前执行 `heal(meta, localDir, true)` |
| engine 调用 refine | classify 后对 `cloudModifiedContent` / `conflict` 下载云端内容、计算哈希、调用 `refineCloudModified` |
| executor 调用 merge | 冲突时先尝试 `threeWayMerge`，无冲突则写入并上传，有冲突才回退 backup+download |
| 同步锁 | 新增 `lock.ts`（PID 文件锁 + 过期接管），engine 接入 |
| 测试更新 | 新增 MD 归一化测试 14 个，全局 xxhash 初始化 setup |
| calibrate_metadata | 新增 `classify/calibrate.ts`，两端都有但无 metadata 的文件自动建立基线 |
| cloud move API | executor move case 调用 `moveFile` + `renameFile` API（保留 file_id 和历史） |
| cleanup stale | 同步后清理 metadata 中云端已不存在的幽灵记录（`clearCloudId`） |
| filter_by_direction | 支持 `pull` / `push` / `both` 三种同步方向过滤 |
| retry_with_backoff | 所有 API 调用（download / upload / refine / move）包裹指数退避重试 |
| engine 调用 dedup | 同步后自动执行 `autoDedup`（云端+本地删除、碰撞检测、引用保护） |
| engine 调用 git | 同步后自动执行 `gitAutoCommit` |
| hash warmup | 预计算两端都有文件的 content hash，加速分类和细化 |
| orphan discard | 同步前跳过与 both 集合内容相同的孤立本地副本，避免无用上传 |
| 验证 | 233 测试全绿，tsc --noEmit 通过，0 lint 错误 |

---

## 四、当前仍需处理的遗留项

以下功能在 Python 中存在，本次未移植。按优先级排列：

### P1 — 影响正确性

| 项目 | Python 位置 | 说明 | 状态 |
|------|------------|------|------|
| 移动检测增强 | `moves.py` | 三阶段检测：file_id 匹配 + 文件名归一化 + 跨目录（hash + filename + ancestor depth） | ✅ 已完成 |
| engine 集成测试 | — | 6 个集成测试覆盖 heal / scan / classify / refine / lock / download 流程 | ✅ 已完成 |

### P2 — 影响功能完整性

| 项目 | Python 位置 | 说明 | 状态 |
|------|------------|------|------|
| 完整去重 | `dedup.py` | autoDedup: 云端删除 + 碰撞检测(size) + 资源引用保护 + 评分保留最佳版本 | ✅ 已完成 |
| calibrate_metadata | `decision.py` | 补全两端都有的文件的元数据 | ✅ 已完成 |
| cloud move API | `engine.py` `_execute_cloud_moves` | executor 中用 moveFile/renameFile API 在云端直接移动 | ✅ 已完成 |
| cleanup stale | `engine.py` `_cleanup_stale_paths` | 同步后清理 metadata 幽灵记录 | ✅ 已完成 |
| filter_by_direction | `utils.py` | 按同步方向（pull/push/both）过滤 | ✅ 已完成 |
| retry_with_backoff | `utils.py` | API 调用指数退避重试 | ✅ 已完成 |
| engine 调用 dedup | `engine.py` `_run_dedup` | 同步后自动去重 | ✅ 已完成 |
| engine 调用 git | `engine.py` `_git.commit_sync` | 同步后 git auto-commit | ✅ 已完成 |
| 云端增量扫描 | `engine.py` `_try_cached_cloud_scan` | 每次全量扫描性能差；需 `listRecent` API | ☐ 需要 API 端点确认 |

### P3 — 性能优化

| 项目 | Python 位置 | 说明 | 状态 |
|------|------------|------|------|
| hash warmup | `engine.py` `_warmup_hash_cache` | 预计算两端都有文件的哈希 | ✅ 已完成 |
| discard_orphan_duplicates | `moves.py` | 跳过孤立本地副本上传 | ✅ 已完成 |
| 大文件 mmap | `utils.py` `_hash_binary_file` | 二进制文件零拷贝哈希 | ☐ 待实现 |

---

## 五、防止再次发生的改进措施

### 5.1 设计阶段：功能移植清单（立即执行）

**规则：** 任何"重写"类任务的设计文档必须包含一个 **功能移植矩阵**：

```markdown
## 功能移植矩阵

| # | Python 功能 | 位置 | TS 处置 | 状态 |
|---|------------|------|---------|------|
| 1 | heal() 预修复 | engine.py:294 | 移植 | ☐ |
| 2 | refine_conflicts | engine.py:551 | 移植 | ☐ |
| 3 | diff3 merge | engine.py:756 | 移植 | ☐ |
| ... | ... | ... | ... | ... |
```

每项必须有明确的"移植 / 推迟（附原因）/ 丢弃（附原因）"标注。推迟项必须关联到 TODO。

**Action:** 将此规则加入 `coding-patterns.mdc`，关键词 "rewrite / 重写 / 移植"。

### 5.2 开发阶段：逐功能提交（立即执行）

**规则：** 重写项目的每个 commit 必须包含"从入口到模块的完整链路"：

- 不允许：先写 10 个模块，再写 engine 拼装
- 应该：commit 1 = engine + scan（最小流程跑通）；commit 2 = + classify（engine 调用 classify，测试覆盖）；commit 3 = + refine（engine 调用 refine，测试覆盖）...

每个 commit 的自检问题：**"这个模块被谁调用了？调用链是否在测试中被验证？"**

**Action:** 将此规则加入 `coding-patterns.mdc`，关键词 "大型重构 / rewrite"。

### 5.3 Review 阶段：功能对等性 checklist（立即执行）

在 `code-review-template.mdc` 中增加一个专门的 section：

```markdown
## 功能对等性（仅限重写/移植项目）

- [ ] 旧系统的每个公开函数/入口在新系统有对应实现或明确的"推迟/丢弃"标注
- [ ] 旧系统 engine 的每个步骤（init → scan → classify → refine → execute → cleanup）在新 engine 中有对应调用
- [ ] 新写的每个模块至少被一个上层模块导入并调用（不能只被测试导入）
- [ ] 哈希/加密算法与旧系统一致，或有文档说明为什么不同
```

**Action:** 更新 `code-review-template.mdc`。

### 5.4 测试阶段：必须有集成冒烟测试（下一个迭代）

**规则：** engine 必须有至少一个集成测试，用 mock API + mock fs 验证：

1. heal 被调用
2. scan 被调用
3. classify 被调用
4. refine 被调用（当有 cloudModifiedContent 时）
5. execute 被调用
6. merge 被尝试（当有 conflict + .md 文件 + base content 时）
7. lock 被获取和释放

这个测试不需要真实 API，只需要验证调用链完整性。

**Action:** 作为 P1 遗留项在下一个迭代实现。

### 5.5 跟踪阶段：临时方案必须有 TODO（立即执行）

**规则：** 代码中使用临时方案（"先用 X 后换 Y"）时：

1. 代码中写 `// TODO(temp): 替换为 Y，原因：Z`
2. 在 `work-context.mdc` 中记录为活跃任务

不允许"心里知道要换但不写下来"。

**Action:** 将此规则加入 `coding-patterns.mdc`。

---

## 六、改进措施执行跟踪

| # | 措施 | 位置 | 状态 |
|---|------|------|------|
| 1 | 功能移植清单规则 → coding-patterns.mdc | §5.1 | ✅ 已执行 |
| 2 | 逐功能提交规则 → coding-patterns.mdc | §5.2 | ✅ 已执行 |
| 3 | 功能对等性 checklist → code-review-template.mdc | §5.3 | ✅ 已执行 |
| 4 | engine 集成冒烟测试 | §5.4 | ✅ 已执行（6 tests） |
| 5 | 临时方案 TODO 规则 → coding-patterns.mdc | §5.5 | ✅ 已执行 |
| 6 | P1 遗留项：移动检测增强 | §4 | ✅ 已执行（3-phase, 16 tests） |
| 7 | P2 遗留项：完整去重 | §4 | ✅ 已执行（cloud+local delete, 10 tests） |
| 8 | P2 遗留项：云端增量扫描 | §4 | ✅ 已执行（cached scan + listRecent + version） |
| 9 | P2 遗留项：桌面客户端种子导入 | §4 | ✅ 已执行（desktop-data.ts） |
| 10 | P3 遗留项：大文件流式哈希 | §4 | ✅ 已执行（streaming binary chunk hash） |

---

## 七、总结

根本原因一句话：**重写被当作"写新代码"而不是"移植旧功能"来执行。** 设计、review、测试都面向"新代码是否自洽"，而不是"新代码是否覆盖了旧代码的所有行为"。

所有遗漏功能已全部移植完成（P1/P2/P3 全部完成），包括：
- 云端增量扫描（tryCachedCloudScan + listRecent + version tracking）
- 桌面客户端冷启动种子（seedMetadataFromDesktop + readDesktopFile）
- 大文件流式分块哈希（hashLargeBinaryFile，替代 Python mmap）
- listRecent API 端点

防止再次发生的 10 项改进措施已全部执行——不靠记忆，靠清单。
