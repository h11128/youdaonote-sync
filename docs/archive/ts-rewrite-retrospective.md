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

---

## 八、二次审查：第一次复盘本身的遗漏（2026-03-03）

> 触发事件：对全部 14 个 ahead commit（ca4e19c → 684808a）做逐函数级 Python↔TS 对比，发现第一次复盘声称"所有遗漏功能已全部移植完成"，实际仍存在 7 个实质性功能差距。

### 8.1 仍然缺失的功能

#### P0 — 影响数据安全

| # | 差距 | Python 实现 | TS 现状 | 影响 |
|---|------|------------|---------|------|
| 1 | **去重数据源不同** | `build_all_indexes()` 扫描文件系统、计算真实文件哈希，同时接受 `hash_cache` 和 `local_files` 参数 | `buildHashIndex(meta)` 只从 metadata 已有的 `content_hash` 字段构建索引 | 本地独有文件、新增未同步文件、移动产生的孤立副本——全部无法被去重发现 |
| 2 | **Markdown 引用保护正则不完整** | `_MD_REF_RE = r'!?\[...\]\((...)\)'` 匹配图片 `![]()`  **和** 链接 `[]()` | `MD_REF_RE = /!\[...\]\((...)\)/` 只匹配图片 `![]()` | 去重时可能删掉 `[文本](本地文件.md)` 引用的文件，造成断链 |
| 3 | **上传前内容去重缺失** | `engine.py` 上传前调用 `metadata.find_cloud_file_by_hash()`，发现云端已有相同内容则跳过上传 | 无此检查，每次都上传 | 冗余上传 + 可能在云端产生内容重复的文件 |

#### P1 — 影响合并能力

| # | 差距 | Python 实现 | TS 现状 | 影响 |
|---|------|------------|---------|------|
| 4 | **diff3 合并缺少 git 回退** | `_try_diff3_merge()` 先查 `git.get_file_content(rel_path, "HEAD")`，找不到再查 `file_base` 表 | 只查 `meta.getBaseContent()` | 文件从未下载过（无 file_base 记录）时无法做三方合并，直接回退到 backup+download |
| 5 | **下载时不保存 base** | domain=0 下载后 `_save_base(metadata, rel_path, raw, content_hash)` 存入 `file_base` 表 | 下载后不保存 base | 减少了后续能做 diff3 的场景 |

#### P2 — 影响功能完整性

| # | 差距 | Python 实现 | TS 现状 | 影响 |
|---|------|------------|---------|------|
| 6 | **云端移动失败回退缺失** | `_fallback_delete_old_files()` 记录 `_failed_moves`；上传新文件后删除旧云端文件 | move 失败只更新 metadata，不做 upload+delete 回退 | move API 失败时旧云端文件残留 |
| 7 | **git commit 粒度过粗** | `commit_sync()` 只 `git add --` 本次变更文件 + `git add -u` 去重删除文件，附 `--no-verify` | `git add -A` 提交仓库内所有变更 | 可能把用户手动修改的无关文件也一起提交 |

#### 其他差异（P3，可后续处理）

| 差距 | 说明 |
|------|------|
| `get_file_refs` / `set_file_refs` 缺失 | Python 在 metadata 中缓存 md 文件的引用关系做增量去重（避免每次重新解析），TS 每次全量扫描 |
| `diagnose_dryrun()` 缺失 | Python 在 dry-run 结束时检测可疑 UPLOAD（metadata 有记录但 file_id 为空等），TS 无此诊断 |
| `find_cloud_file_by_hash()` metadata 方法缺失 | Python metadata 有按 content_hash 反查云端文件的方法（10 个测试覆盖），TS MetadataStore 无此方法 |
| 备份文件名缺少微秒 | Python `backup_file()` 时间戳含 `_%f`（微秒），TS 不含，快速连续备份可能覆盖 |
| CLI 参数不完整 | Python 有 `--dir`、`--push`、`--pull`、`--no-dedup`；TS 只能通过 config 控制 |
| CLI 子命令不完整 | Python 有 `pull`、`list`、`search`、`download`、`gui`；TS 只有 `sync` + `watch` |

### 8.2 为什么第一次复盘没有发现这些

第一次复盘（本文 §1–§7）确实发现并修复了一批严重遗漏（refine 未接入、merge 未调用、heal 未调用、哈希算法不一致等），但 **它的审查方法本身有盲区**，导致第二层遗漏漏网。

#### 盲区 1：审查粒度停在"模块是否被调用"，没有深入到"调用时行为是否等价"

第一次复盘的核心发现模式是：

> "TS 有 refine.ts 但 engine 没调用"——接线遗漏

修复方式是：在 engine 中加调用。但修复后没有逐行对比 Python engine 中 **同一个步骤周围的辅助逻辑**。例如：

- Python 的 `_process_download_item()` 在下载后有一段 `if raw and item.domain == 0: _save_base(...)` ——这不是一个独立模块，而是嵌在下载流程中的 3 行代码。第一次复盘只关注"download 被调用了吗？"，没有关注"download 之后做了哪些附加操作？"
- Python 的 `_process_upload_item()` 在上传前有 `find_cloud_file_by_hash()` 去重——同样是嵌在上传流程中的 5 行代码。

**根本问题：** 复盘的检查清单是模块级的（"heal 调用了吗？refine 调用了吗？"），而遗漏发生在函数内部的分支级别。

#### 盲区 2：去重模块被标记为"✅ 已完成"但只对齐了接口签名，没有对齐数据来源

第一次复盘 §4 写道：

> "完整去重 | autoDedup: 云端删除 + 碰撞检测(size) + 资源引用保护 + 评分保留最佳版本 | ✅ 已完成"

这些功能确实都实现了。但 `autoDedup` 的输入来源完全不同：

- Python：`build_all_indexes(root, metadata, hash_cache, local_files)` → 扫描文件系统 + 使用同步时已计算的 hash cache
- TS：`buildHashIndex(meta)` → 只读 metadata 表

功能点的 checklist 只检查"有没有云端删除 / 碰撞检测 / 引用保护 / 评分"，没有检查"去重用的文件索引从哪来、覆盖范围是否一致"。

#### 盲区 3：正则表达式这类细节不在任何 checklist 中

`_MD_REF_RE` 中 `!?` 和 `!` 的区别，是一个字符的差异。第一次复盘的 §5.3 功能对等性 checklist 写的是：

> "哈希/加密算法与旧系统一致，或有文档说明为什么不同"

但没有一条是"正则表达式与旧系统一致"。这类"看起来正确但语义有微妙差别"的代码，只有逐行对比才能发现。

#### 盲区 4：git helper 被当作"工具"而不是"功能"

Python 的 `GitHelper` 有两个能力：`commit_sync`（选择性暂存）和 `get_file_content`（从 git 历史取 base）。TS 的 `git.ts` 只实现了 `gitAutoCommit`（`git add -A`）。

第一次复盘的移植矩阵关注的是同步核心流程（heal → scan → classify → refine → execute），git helper 被归类为"辅助工具"没有出现在矩阵中。但 `get_file_content` 是 diff3 合并链路的关键一环，`commit_sync` 的选择性暂存直接影响用户数据。

### 8.3 为什么改进措施没有阻止这些遗漏

第一次复盘制定了 5 项改进措施（§5.1–§5.5），全部标记为"✅ 已执行"。逐项检查为什么它们没能拦住第二批遗漏：

| 措施 | 设计意图 | 为什么没生效 |
|------|---------|-------------|
| §5.1 功能移植清单 | 列出所有 Python 功能 | 清单是模块/函数级的，嵌在函数内部的 3-5 行分支逻辑不会作为独立条目出现 |
| §5.2 逐功能提交 | 每个 commit 包含完整链路 | 确实让"模块未被调用"不再发生，但没有验证"调用后的行为是否一致" |
| §5.3 功能对等性 checklist | Review 时检查旧系统功能 | Checklist 的 4 条全部是模块/步骤级别，没有"对比函数内部的分支和边界处理" |
| §5.4 集成冒烟测试 | 验证调用链完整性 | 只验证"函数被调用了"，不验证"函数的行为和 Python 一致" |
| §5.5 临时方案 TODO | 防止临时代码被遗忘 | 本次遗漏不是临时方案，是"以为已经实现但其实少了一半" |

**总结：所有改进措施的防御层级都是"模块/函数是否存在且被调用"，而遗漏发生在"函数内部的行为是否完整"这个更细的层级。**

### 8.4 根本原因

第一次复盘的根本原因总结是正确的：

> "重写被当作'写新代码'而不是'移植旧功能'来执行。"

但第一次复盘的修复方式也重复了同样的思维模式：**修复是面向"我们缺少哪些模块"而不是面向"每一行 Python 代码在 TS 中有没有对应"。** 复盘检查了模块是否存在、是否被调用、是否有测试，但没有做 **逐函数的行为等价性对比**。

换一种说法：

- 第一次遗漏的模式是 **"模块写了但没接线"** → 修复方式是检查接线
- 第二次遗漏的模式是 **"接线了但行为不完整"** → 需要的是逐行对比

每次修复只向下深入一层，而不是一次性做到最底层。

### 8.5 如何确保不再遗漏

以下措施针对 §8.3 暴露的防御盲区，补充到更细的粒度。

#### 8.5.1 逐函数行为对比（替代模块级清单）

**规则：** 移植/重写项目的验收标准不是"功能模块存在且被调用"，而是 **对 Python 的每一个公开函数和 engine 中的每一个私有方法（`_` 前缀），在 TS 中找到对应实现并逐行确认行为等价**。

具体做法——对每个 Python 函数：

1. 列出函数的所有分支（if/else/try-except/for 中的 continue/break）
2. 对每个分支，确认 TS 中有对应处理
3. 对每个正则表达式、魔法常量、阈值，确认 TS 中的值相同
4. 对每个辅助调用（如 `_save_base`、`find_cloud_file_by_hash`），确认 TS 中也有调用

产出物是一个**分支级对照表**，不是模块级矩阵：

```markdown
## 分支级对照：_process_download_item

| Python 分支 | 行号 | TS 对应 | 状态 |
|------------|------|---------|------|
| 正常下载并写文件 | 905-908 | executor.ts download case | ✅ |
| domain=0 时保存 base | 911-914 | — | ☐ 缺失 |
| 下载后更新 content_hash | 916-920 | executor.ts recordSync | ✅ |
```

#### 8.5.2 自动化 diff 检测（替代人工 review）

人工对比在函数多、分支多时不可靠。添加一个检查脚本，基于以下逻辑：

1. 提取 Python 所有 `def` 和 `class` 定义
2. 提取 TS 所有 `export function` 和 `export class` 定义
3. 对比两个列表，标记 Python 有但 TS 没有的条目
4. 对标记为"已实现"的条目，对比函数体的关键特征（调用的子函数、正则表达式、常量值）

这不能替代人工审查，但能作为第一道筛网，把明显的缺失提前暴露。

#### 8.5.3 正则和常量单独对比

**规则：** 所有正则表达式和硬编码常量必须单独列一张对照表：

```markdown
| Python 正则/常量 | 位置 | TS 对应 | 是否一致 |
|-----------------|------|---------|---------|
| `_MD_REF_RE = r'!?\[...'` | dedup.py:44 | `MD_REF_RE = /!\[.../` | ❌ 缺少 `?` |
| `_GENERIC_NAMES` | moves.py:12 | `GENERIC_NAMES` | ✅ |
```

#### 8.5.4 集成测试不只检查"是否被调用"，还检查"调用参数和副作用"

当前的集成冒烟测试只用 spy 验证"heal/scan/classify/refine/execute 被调用了"。需要增加：

- download 后 `saveBaseContent` 被调用（验证 §8.1 #5）
- upload 前检查 `findCloudFileByHash`（验证 §8.1 #3）
- move 失败后 upload+delete 回退被触发（验证 §8.1 #6）
- dedup 的 `buildRefIndex` 正则匹配 `[text](file.md)` 格式（验证 §8.1 #2）

#### 8.5.5 复盘的复盘——两周后 independent review

**规则：** 重写项目的复盘文档本身，必须在两周内由一个独立的审查者（或独立的 AI 会话，不携带前一次的上下文）做二次审查。审查的问题不是"复盘写的对不对"，而是"复盘声称已修复的功能，实际行为和 Python 一致吗？"

本次遗漏的根本原因就是：复盘者和实现者是同一个上下文，会不自觉地共享"这个应该已经做了"的假设。独立审查打破这个假设。

### 8.6 遗留项修复跟踪

| # | 项目 | 优先级 | 状态 |
|---|------|--------|------|
| 1 | 去重数据源：`buildHashIndex` 改为扫描文件系统 + hash_cache + local_files | P0 | ✅ 已修复 |
| 2 | MD 引用正则：`!\[` → `!?\[` 保护 markdown 链接引用 | P0 | ✅ 已修复 |
| 3 | 上传前内容去重：`findCloudFileByHash()` + executor 上传前检查 | P0 | ✅ 已修复 |
| 4 | diff3 git 回退：`getFileContentFromGit()` + executor 合并时回退 | P1 | ✅ 已修复 |
| 5 | 下载时保存 base：domain=0 下载后 `saveBaseContent()` | P1 | ✅ 已修复 |
| 6 | 云端移动回退：`failedMoves` 跟踪 + `fallbackDeleteOldFiles` 兜底 | P2 | ✅ 已修复 |
| 7 | git commit 粒度：选择性 add changedPaths + --no-verify | P2 | ✅ 已修复 |
| 8 | 引用缓存：`get/setFileRefs` + `getAllFileRefs` + 增量 `buildRefIndex` | P3 | ✅ 已修复 |
| 9 | diagnose_dryrun：移植可疑 UPLOAD 诊断到 engine.ts | P3 | ✅ 已修复 |
| 10 | 备份文件名微秒：时间戳增加毫秒+随机数避免覆盖 | P3 | ✅ 已修复 |

### 8.7 本节总结

第一次复盘解决了"模块没接线"这一层问题，但检查方法本身只停留在模块粒度，无法发现函数内部的行为差异。**每一次 review 只能发现它的 checklist 覆盖的层级的问题**——如果 checklist 是模块级的，函数内部的遗漏就是盲区。

教训：
1. **"已完成"不等于"行为等价"**——标记 ✅ 之前，必须有分支级的对比证据，不能只看接口签名。
2. **复盘者不能是实现者的同一个上下文**——共享上下文会继承"这个应该做了"的假设，需要独立审查打破。
3. **防御措施的粒度必须和遗漏的粒度匹配**——模块级的防御挡不住函数内部的遗漏，正则级的差异需要正则级的对比。

**修复验证（2026-03-03）：** 10 项遗留全部修复完成。`tsc --noEmit` 通过，243 测试全绿（新增 10 测试）。

---

## 九、第三次审查：逐行参数与条件对比（2026-03-03）

### 9.1 审查方法

前两次审查的盲区：模块级和函数级对比只能发现"缺了什么函数"，无法发现参数顺序错误、类型强转掩盖的逻辑错误、条件表达式的语义差异。

本次采用**逐行参数对比法**：对每个共有函数，将 Python 和 TS 的具体参数、条件运算符、分支结构逐行摆在一起比对。同时用 4 个并行审查代理分别扫描 scan、classify、executor、metadata/API 四个模块。

### 9.2 P0 — 确认的代码 bug

#### 9.2.1 `calibrate.ts:25` — setDirInfo 传错参数

Python: `metadata.set_dir_info(rel, DirId(cloud["id"]), cloud["parent_id"])`
TS: `meta.setDirInfo(relPath, cloudFile.parentId, cloudFile.parentId)`

第二个参数应该是目录自身的 ID（`cloud["id"]`），TS 错误地传了 `parentId`。所有校准过的目录 ID 都会被写错，后续 `findByDirId` 全部失败。

#### 9.2.2 `moves.ts:116-118` — Case B fileId 来源错误（死代码）

```typescript
const metaPath = meta.findByFileId(
  (classified.get(cloudPath) as ClassifiedEntry & { state: { fileId?: FileId } })
    ?.state as unknown as FileId,
);
```

`state` 是 `{ kind: 'cloudDeleted' }` 类型的 FileState，强制 cast 成 FileId 永远不会匹配。
Python 版本: `fmeta = metadata.get_file_info(local_rel)` → `fid = fmeta["file_id"]`。
Case B（"云端文件的 file_id 在 metadata 中找到对应本地路径"）完全不工作。

### 9.3 P1 — 同步决策语义差异

#### 9.3.1 `previouslySynced` 缺少 fileId 检查

Python: `bool(meta["file_id"]) and meta.get("last_sync_at", 0) > 0`
TS: `meta !== null && meta.lastSyncAt > 0`

缺少 `fileId` 检查。`lastSyncAt > 0` 但 `fileId` 为空时，Python 认为未同步 → 上传/下载，TS 认为已同步 → 可能跳过。

#### 9.3.2 `cloudMtimeChanged` 用 `!==` 而非 `>`

Python: `cloud_mtime > meta_cloud_mtime`（只有更新才算变化）
TS: `cloud.mtime !== meta.cloudMtime`（任何不同都算变化）

时钟回拨时 Python 不触发下载，TS 会。

#### 9.3.3 `localMtimeChanged` 无 meta 时返回 null 而非 true

Python: `meta_local_mtime is None → local_changed = True`
TS: `meta.localMtime === 0 → null`

Python 无基线 = 认为改过（倾向上传），TS 无基线 = 未知（可能跳过）。

#### 9.3.4 跨目录文件名匹配缺少内容校验

Python 在文件名+祖先深度匹配后，还检查内容 hash：hash 不同且云端无 file_id → 跳过（防止同名不同文件误判为移动）。TS 的 `crossDirMatch` 没有这个保护。

### 9.4 P2 — 缺失功能

| # | 缺失功能 | Python 位置 | 影响 |
|---|---------|------------|------|
| 1 | 下载原子写入（tmp→rename） | `executor.py:_atomic_write` | 中断留半成品 |
| 2 | git commit 不含 dedup 删除路径和统计 | `git_helper.py:commit_sync` | dedup 删除不被 git 记录 |
| 3 | 500+body 的 auth 错误检测 | `api.py:is_auth_error` | 有道返回 500+error=207 时不提示重新登录 |

### 9.5 P3 — 已知但暂不修复

| # | 项目 | 原因 |
|---|------|------|
| 1 | 二进制文件上传 API | 需要新增 multipart API，当前用户场景为笔记同步 |
| 2 | 下载后图片 URL 迁移 | 需要图片服务端配合 |
| 3 | 并发执行（10 下载 / 5 上传） | 性能优化，不影响正确性 |
| 4 | metadata 增量保存（每 200 条） | 性能优化，不影响正确性 |
| 5 | tree_hash API | schema 有列但未使用，等 Merkle tree 功能启用时再加 |
| 6 | noteJsonToMarkdown 反向转换 | 当前不需要反向转换 |
| 7 | JSON metadata 迁移 | 旧格式用户可用 Python 版迁移 |

### 9.6 遗留项修复跟踪

| # | 项目 | 优先级 | 状态 |
|---|------|--------|------|
| 1 | calibrate.ts setDirInfo 参数修正 | P0 | ✅ 已修复 |
| 2 | moves.ts Case B fileId 来源修正 | P0 | ✅ 已修复 |
| 3 | conditions.ts previouslySynced 加 fileId 检查 | P1 | ✅ 已修复 |
| 4 | conditions.ts cloudMtimeChanged 改为严格大于 | P1 | ✅ 已修复 |
| 5 | conditions.ts localMtimeChanged 无 meta 时返回 true | P1 | ✅ 已修复 |
| 6 | moves.ts 跨目录文件名匹配增加内容校验 | P1 | ✅ 已修复 |
| 7 | executor download 原子写入 | P2 | ✅ 已修复 |
| 8 | git commit 包含 dedup 删除路径和统计 | P2 | ✅ 已修复 |
| 9 | API isAuthError 增加 500+body 检测 | P2 | ✅ 已修复 |

### 9.7 本节总结

第三次审查从"逐行参数对比"的角度发现了 2 个确认 bug、4 个语义差异、3 个缺失功能，全部已修复。

教训：**参数顺序和运算符语义是最容易被"看起来差不多"掩盖的错误类型**。类型系统可以防 API 不存在，但挡不住"参数传反"或"`!==` vs `>`"——这些只有逐行摆在一起看才能发现。

**修复验证（2026-03-03）：** 9 项遗留全部修复完成。`tsc --noEmit` 通过，243 测试全绿。同时完成了 `dedup.ts`（585 行）→ `dedup/` 目录拆分（9 文件，最大 144 行）。

---

## 十、第四次审查：独立上下文全模块对比（2026-03-03）

### 10.1 审查方法

用 4 个并行审查代理在独立上下文中分别对比 engine、executor、classify、dedup/moves/scan 四大模块，每个代理逐函数逐分支对照 Python 源码。

### 10.2 P0 — 影响数据安全

| # | 差距 | 影响 |
|---|------|------|
| 1 | **Move 失败仍更新 metadata** — `renamePath`/`recordSync` 在 move API 失败时仍执行 | metadata 与云端状态不一致，后续同步可能跳过或误删文件 |
| 2 | **localMtime 使用 `Date.now()`** — 下载后文件 mtime 被 `utimesSync` 设为 cloudMtime，但 metadata 记录 `Date.now()`  | 下次同步 `localMtimeChanged` 误判为 true，触发无意义的冲突或上传 |
| 3 | **冲突处理无方向分支** — Python PUSH 时 backup+upload，TS 始终 backup+download | push 模式下冲突文件不上传，数据丢失风险 |

### 10.3 P1 — 影响功能完整性

| # | 差距 | 影响 |
|---|------|------|
| 4 | 云端文件未过滤 sync_include/sync_exclude | 过滤仅作用于本地，云端不匹配的文件仍参与同步 |
| 5 | cleanupStalePaths 在缓存扫描时执行 | 缓存 cloudSnap 不完整 → 误清 metadata |
| 6 | 移动检测后缺少二次 calibrate | moves 产生的新路径缺少 metadata 基线 |
| 7 | HASHABLE_EXTS 缺失 .css/.js/.csv | 这些文件不参与 hash warmup 和 refine |
| 8 | refine 未利用缓存 cloudContentHash | cloudMtime 未变时仍下载云端内容计算 hash |
| 9 | autoDedup 未接收 hashCache/localFiles | 每次去重重新扫描文件系统和计算哈希 |
| 10 | ref URL 跳过模式缺少 UNC 路径和通用协议检测 | 去重时可能删掉 UNC 或 Windows 路径引用的文件 |

### 10.4 P2 — 改进项

| # | 差距 |
|---|------|
| 11 | calibrate 未设置 createTime |
| 12 | dedup cloudScore 未优先使用 createTime |
| 13 | MetadataRecord 缺少 createTime 字段 |

### 10.5 为什么前三次审查没有发现这些

| 盲区 | 原因 |
|------|------|
| Move 失败路径 | 前三次只验证"move 是否被调用"和"failedMoves 是否被跟踪"，没有验证 catch 之后 metadata 是否被隔离 |
| localMtime | 前三次关注"localMtime 是否被记录"，没有关注"记录的值是否正确" |
| 冲突方向 | 前三次验证"conflict case 是否存在 diff3"，没有验证"非 BOTH 方向的 fallback 行为" |
| 云端过滤 | 前三次只检查"local scan 接收 filters"，没有检查"cloud scan 也需要 filters" |
| 缓存扫描 | cleanupStalePaths 是后加的功能，没有考虑缓存 vs 全量扫描的前置条件 |

### 10.6 修复跟踪

| # | 项目 | 优先级 | 状态 |
|---|------|--------|------|
| 1 | move 失败隔离 metadata 更新 | P0 | ✅ |
| 2 | localMtime 改用 readFileMtime() | P0 | ✅ |
| 3 | 冲突 conflictFallback 按方向分支 | P0 | ✅ |
| 4 | filterCloudSnap + patternToRegex | P1 | ✅ |
| 5 | cleanupStalePaths 仅全量扫描后执行 | P1 | ✅ |
| 6 | moves 后二次 calibrate | P1 | ✅ |
| 7 | HASHABLE_EXTS 补全 .css/.js/.csv | P1 | ✅ |
| 8 | refine 缓存 cloudContentHash | P1 | ✅ |
| 9 | autoDedup 传入 hashCache/localFiles | P1 | ✅ |
| 10 | ref URL 跳过模式补全 | P1 | ✅ |
| 11 | calibrate 设置 createTime | P2 | ✅ |
| 12 | cloudScore 优先 createTime | P2 | ✅ |
| 13 | MetadataRecord 增加 createTime | P2 | ✅ |

**修复验证：** `tsc --noEmit` 通过，243 测试全绿，0 lint 错误。

---

## 十一、第五次审查：4 代理并行全模块逐函数对比（2026-03-03）

### 11.1 审查方法

用 4 个并行审查代理分别对比：engine、executor/download/upload、dedup/moves/scanner/utils、metadata/api/git/merge。每个代理独立读取完整的 Python 和 TS 源码，逐函数逐分支对照。

### 11.2 发现与修复

#### P0 — 影响数据安全

| # | 差距 | Python 行为 | TS 原状 | 修复 |
|---|------|------------|---------|------|
| 1 | 去重资产组处理逻辑不同 | `_resolve_cloud_group`: 有引用+无引用 → 保留所有引用，删除所有无引用；全引用 → 跳过 | 只取最高分保留，删其余（忽略引用状态） | `resolve.ts` 新增 `resolveCloudGroup` 匹配 Python 三分支逻辑 |
| 2 | `discardOrphanDuplicates` 缺少文件名净化 | `normalize_filename(basename(bp)).lower()` | `basename(bp).toLowerCase()`（未净化） | `orphan.ts` 加入 `sanitizeFilename` |

#### P1 — 影响功能正确性

| # | 差距 | Python 行为 | TS 原状 | 修复 |
|---|------|------------|---------|------|
| 3 | 云端快照未过滤 `.conflict.` 文件 | `".conflict." not in basename(k)` | 无此过滤 | `engine.ts` 加入 `.conflict.` 过滤 |
| 4 | Phase 2 名称匹配多了 `.toLowerCase()` | `normalize_filename(b)` 大小写敏感 | `sanitizeFilename(b).toLowerCase()` 大小写不敏感 | `moves.ts` 去掉 `.toLowerCase()` |
| 5 | 目录 download/upload 当文件处理 | `_execute_dir`: 下载=makedirs，上传=ensure_cloud_dir | 目录走 downloadFile/uploadFile → 失败 | `executor.ts` 新增 `executeDir` 分离处理 |

#### P2 — 功能完善

| # | 差距 | 修复 |
|---|------|------|
| 6 | `buildRefIndex` walk 路径不缓存 `file_refs` | `refs.ts` walk 路径也调用 `meta.setFileRefs` |
| 7 | 去重 dry-run 无输出 | `execute.ts` dry-run 时打印将删除的文件和原因 |
| 8 | GC 不清理孤立 `file_refs` | `health.ts` gc 中增加 `file_refs` 清理 |

### 11.3 为什么前四次没发现

| 盲区 | 原因 |
|------|------|
| 资产组去重 | 前次审查验证了"有引用的资产被跳过"，没验证"多引用+多无引用时的分组策略" |
| 文件名净化 | orphan 函数是后加的，审查时只检查了"hash 匹配逻辑"没检查"name 匹配用了什么" |
| `.conflict.` 过滤 | Python 在收集阶段过滤，不在 scan 阶段——前次只比较了 scan 和 classify |
| 大小写敏感性 | Python 的 `normalize_filename` 不做 lower()，差异隐藏在一个缺少的 `.toLowerCase()` 调用中 |
| 目录处理 | 前次审查只验证了"file 操作"，Python 的 `_execute_dir` 作为独立方法没被对照 |

### 11.4 修复验证

`tsc --noEmit` 通过，254 测试全绿（+11 新测试），0 lint 错误。

---

## §12 第六轮审查：深度功能对等性审查

日期：2026-03-04

### 12.1 审查方法

对 Python 和 TypeScript 的每个模块进行逐行功能对比（engine/executor/API/CLI/convert/dedup/scanner），
重点排查以下维度：
- 执行流中缺失的副作用（本地文件移动、changedPaths 记录）
- API 能力缺失（二进制上传、按 ID 查文件）
- 格式转换缺失（HTML → Markdown）
- CLI 选项缺失（方向控制、子目录、去重开关）
- 行为差异（lock 失败处理、dry-run 输出）

### 12.2 发现与修复

#### P1 — 影响同步正确性

| # | 差距 | Python 行为 | TS 原状 | 修复 |
|---|------|------------|---------|------|
| 1 | 移动成功后未移动本地文件 | `shutil.move(old_abs, new_abs)` | 只更新 metadata 和云端 | `move-handler.ts` 添加 `renameSync` + `mkdirSync` |
| 2 | 冲突解决路径未记入 changedPaths | 冲突解决后文件参与 git commit | push/pull fallback 和 diff3 merge 都不记录 | `executor.ts` + `conflict.ts` 所有分支添加 `changedPaths.push` |

#### P2 — 功能完善

| # | 差距 | 修复 |
|---|------|------|
| 3 | 上传只支持文本文件 (UTF-8) | `file-api.ts` 新增 `pushBinaryFile` (multipart)；`upload.ts` 按扩展名分流二进制/文本 |
| 4 | 下载后未迁移图片 URL | `executor.ts` 下载后调用 `migrateImages`，传入 cookie header |
| 5 | HTML → Markdown 转换缺失 | 新增 `convert/html-to-md.ts`；`download.ts` 的 `detectFileType` 识别 HTML |
| 6 | dry-run 输出不完整 | `engine-helpers.ts` 新增 `printPreview` + `printDryrunSummary`，`diagnoseDryrun` 自动调用 |
| 7 | lock 失败抛异常而非返回空 stats | `engine.ts` lock 失败返回 `emptyStats()` + 空 classified（匹配 Python 行为）|
| 8 | 缺少 `getFileInfo(fileId)` API | `client.ts` 新增该方法 |

#### P3 — 功能增强

| # | 差距 | 修复 |
|---|------|------|
| 9 | CLI 缺少 --dir/--push/--pull/--no-dedup | `cli.ts` sync 命令添加四个选项 |
| 10 | 缺少 `collectItems()` 公开 API | `engine.ts` 新增该方法，供外部工具调用 |

### 12.3 重构

为保持文件行数 ≤300：
- 冲突 fallback 逻辑从 `executor.ts` 提取到 `conflict.ts`
- refine 逻辑从 `engine.ts` 提取到 `engine-refine.ts`
- `file-api.ts` 校验逻辑提取为 `required()` 工具函数

### 12.4 修复验证

`tsc --noEmit` 通过，271 测试全绿，0 lint 错误。

---

## §13 第七轮审查：move 检测实现偏离设计文档（2026-03-04）

### 13.1 审查背景

用户执行 dry-run 同步时发现：本地已移动/重命名的文件被判定为 `cloudNew` 并重新下载，产生重复文件。根因追踪发现 TS move 检测的 hash 数据源被切断，导致基于 hash 的移动配对完全失效。

### 13.2 核心问题：实现偏离了设计文档

项目有两份设计文档明确定义了 move 检测的目标架构：

- **sync-engine-overhaul.md §五 第 159 行**："moves (content hash matching) ~200行 | 纯 hash 匹配，不依赖文件名"
- **typescript-rewrite-design.md §3.5**：`detectMoves` 签名接收 `hash: ContentHash | null`，注释写明"纯 hash 匹配，不依赖文件名"

但 `moves.ts` 的注释直接写着 "Three-phase move detection **(matches Python moves.py)**"——实现选择了移植 Python 的复杂三阶段方法，而非设计文档定义的纯 hash 方案。Python 的 move 检测正是设计文档指出需要被替换的（overhaul.md 第 16 行："移动检测依赖文件名相似度，改名太大就失效"）。

三阶段本身不是问题（file_id、文件名归一化、跨目录 hash+文件名各有价值），但关键的 hash 数据源被切断了。

### 13.3 为什么 metadata hash 没有被使用

Bug 在 `engine.ts` 第 178-180 行：

```typescript
const classifiedWithHash = new Map();
for (const [path, state] of classified) {
  classifiedWithHash.set(path, { state, hash: localHashes.get(path) ?? null });
}
```

`localHashes` 只包含本地磁盘上存在的文件的 hash。已删除/已移动的文件（`localDeleted`、`cloudNew` 等）在 `localHashes` 中不存在，hash 永远是 null。

而 `metaSnap`（同一函数第 176 行已经获取）里存着每个路径上次同步时的 `contentHash`——这正是已删除文件的唯一 hash 来源——但从未被传递给 `classifiedWithHash`。

### 13.4 架构教训：metadata hash 不是 "fallback"

之前的讨论中曾将 metadata hash 称为 "fallback"。这个措辞本身就揭示了认知偏差：

- 对于本地存在的文件：`localHash`（磁盘实时计算）是最准确的，metadata hash 确实是备选
- 对于本地不存在的文件：metadata hash 是**唯一的 hash 来源**，不是"备选"

正确的模型是：

| 文件状态 | hash 来源 | 原因 |
|---------|----------|------|
| 本地存在 | localHash（实时） | 文件在磁盘上，可以直接计算 |
| 本地不存在 | meta.contentHash（历史快照） | 文件已删除/移动，只有上次同步时的记录 |
| 两者都无 | null | 无法做 hash 匹配 |

设计文档 `typescript-rewrite-design.md` 第 39 行写明 "content hash 作为核心决策驱动"。hash 的来源（实时 vs 历史）是实现细节，核心原则是：**每个参与 move 检测的路径都应该有 hash**。

### 13.5 第二个缺失：cross-side 匹配

当文件在两端同时被移动/重命名时，原路径消失（classify 为 `gone`），两边各出现新路径（`cloudNew` 和 `localNew`）。现有的 Phase 3 只匹配同侧（cloudDeleted↔cloudNew、localDeleted↔localNew），不匹配跨侧（cloudNew↔localNew）。

### 13.6 修复

| # | 修复 | 文件 |
|---|------|------|
| 1 | `classifiedWithHash` 构建时，`localHash` 缺失则使用 `metaSnap.contentHash` | engine.ts |
| 2 | Phase 4：cloudNew↔localNew cross-side hash/filename 匹配 | moves.ts |
| 3 | 4 个新测试覆盖 cross-side 匹配场景 | moves.test.ts |

### 13.7 为什么前六轮审查没有发现

| 盲区 | 原因 |
|------|------|
| hash 数据源 | 前几轮审查验证了"detectMoves 是否被调用"和"Phase 1/2/3 是否实现"，没有追踪"hash 从哪里来、对于 deleted 路径是否有值" |
| cross-side 匹配 | Phase 3 的两次 `crossDirMatch` 调用看起来覆盖了所有组合，实际只覆盖了同侧 |
| 设计文档对比 | 前几轮审查都是 Python↔TS 对比，没有回头对比 TS 设计文档↔TS 实现——设计文档写的是"纯 hash"，实现注释写的是"matches Python moves.py"，这个偏离没有被发现 |

### 13.8 教训

1. **实现应该对照设计文档，不只是对照旧代码。** 当设计文档说"纯 hash 匹配"而实现注释说"matches Python"时，说明开发者选择了移植旧实现而非执行新设计。
2. **数据流的"最后一英里"容易断裂。** `metaSnap` 被正确获取并传给了 `classifyAll`，但没有传给 `classifiedWithHash`——从获取到使用只差一行代码，但这一行的缺失让整个 hash 匹配系统失效。
3. **"fallback" 这个词暗示了可选性。** 对于已删除文件，metadata hash 不是可选的 fallback，是唯一来源。命名和措辞会影响实现者的优先级判断。
