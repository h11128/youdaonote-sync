# 同步引擎重写分析

> 2026-03-01 | 基于代码快照 088bd42 + dry-run 实测数据
>
> 前提：彻底重构整个项目（非渐进改造）

## 一、为什么要重写

### 1.1 反复出现的 bug

从深度重构（`9a3dbed`）到当前（`088bd42`），15 个 commit、76,395 行改动、7 P0 + 8 P1 bug，但 2026-03-01 的 dry-run 仍暴露 3 类老问题：

| 类别 | 表现 | 根因 |
|------|------|------|
| Ghost update | `2026年行动指南.md` 被判 DOWNLOAD — diff 显示全是格式重排，内容零变化 | 决策只看 mtime，不验证 content hash |
| 重命名丢匹配 | "上数学课…" DOWNLOAD + "擦黑板答题" UPLOAD — 实为同一文件改名 | 移动检测依赖文件名相似度，改名太大就失效 |
| 孤儿目录 | 9 个已删/改名目录被判 DOWNLOAD | 目录无 `previously_synced` 逻辑 |

### 1.2 Bug 模式分类

commit 历史中的 bug 按根因分为 5 类：

| 根因 | 次数 | 说明 |
|------|------|------|
| 内容 hash 标准化不一致 | 4 | CRLF 跨 chunk、二进制文件误做文本标准化 |
| 共享可变状态 / 并发 | 3 | 非原子标志、浅拷贝泄露 |
| 类型 / schema drift | 3 | 传错类型、返回类型变了调用方没更新 |
| 跨模块重复计算 | 4 | hash 算 4 次/文件、dedup 重复 os.walk |
| 路径标准化散落 | 2 | 各模块自己做 normalize |

### 1.3 为什么修补不够

项目已做过 SOLID 审计（2 轮）、性能审计、类型审计、Rust 重写可行性分析。代码质量工具用了一遍，但同类 bug 仍然反复出现。

根本原因有两层：

1. **决策模型缺陷** — mtime 优先 + hash 辅助的模型，从设计上无法避免 ghost update 和重命名丢失
2. **架构对 AI 开发不友好** — 20 步管线、12 个 metadata 写入方法散布在 7 个文件、隐式顺序依赖 — 超出 AI 单次对话的有效推理范围

修补只能修症状，改架构才能改根因。

## 二、当前代码结构

| 模块 | 行数 | 文件数 | 外部依赖 |
|------|------|--------|---------|
| sync 核心 | 4,128 | 10 | xxhash |
| API + 传输 | 1,599 | 4 | httpx |
| 格式转换 | 745 | 5 | 无（手写 XML/JSON 解析） |
| 其他（cookies/common/GUI） | ~800 | 6 | tkinter |
| 测试 | 9,248 | 23 | — |
| **总计** | **~16,500** | | |

外部依赖极少（httpx + xxhash + tkinter），格式转换无第三方库。**迁移到其他语言没有生态壁垒。**

## 三、目标架构：状态机 + 内容寻址

### 3.1 为什么选状态机

对比 4 种架构在 AI 开发场景下的表现（评估维度：因果链长度、隐式依赖、可变状态、遗漏边界保证、可独立修改）：

| 架构 | 核心优势 | 核心弱点 | AI 友好度 |
|------|---------|---------|----------|
| 纯函数管线 | 消除可变状态 | decide 内部可能复杂；无穷举保证 | 中 |
| **状态机 + 内容寻址** | **穷举保证 + 每状态独立 + hash 驱动** | 状态数可能多 | **最高** |
| 规则引擎 | 单条规则独立 | 规则间优先级/交互难管理 | 中 |
| 事件溯源 | 移动/重命名是显式事件 | 事件检测本身引入 bug；需存快照 | 低 |

**状态机最适合 AI 开发的原因**：

- **穷举保证** — 所有状态显式枚举，match/switch 漏了编译器报错。AI 最常犯的"遗漏边界情况"从架构上被消除
- **模块独立** — 改一个状态的逻辑不影响其他状态。AI 不需要理解整个同步流程就能安全修改
- **classify 是逐文件的扁平判断** — 因果链极短，在 AI 有效推理范围内
- **测试 1:1** — 每个状态一个测试用例，输入→期望状态→期望 action

### 3.2 状态枚举

```
FileState:
  SYNCED                        两端存在且 hash 相同 → SKIP
  LOCAL_NEW                     本地有，云端无，未同步过 → UPLOAD
  CLOUD_NEW                     云端有，本地无，未同步过 → DOWNLOAD
  LOCAL_DELETED                 之前同步过，本地删了 → SKIP
  CLOUD_DELETED                 之前同步过，云端删了 → SKIP
  LOCAL_MODIFIED                本地 hash 变了，云端没变 → UPLOAD
  CLOUD_MODIFIED_CONTENT        云端 hash 变了（内容真的不同）→ DOWNLOAD
  CLOUD_MODIFIED_MTIME_ONLY     云端 mtime 变了但 hash 没变 → SKIP
  BOTH_MODIFIED_CONVERGED       两端都改了但 hash 相同 → SKIP
  CONFLICT                      两端都改了且 hash 不同 → CONFLICT
  MOVED                         hash 相同但路径不同 → MOVE
```

当前 3 类 bug 全部变为显式状态：ghost update → `CLOUD_MODIFIED_MTIME_ONLY`；重命名 → `MOVED`（hash 索引直接匹配）；孤儿目录 → `LOCAL_DELETED`。

### 3.3 整体流程

```
1. scan    → cloud_files, local_files  （不可变快照）
2. classify → 逐文件判断 FileState     （纯函数，无副作用）
3. execute  → 执行 action              （唯一有副作用的步骤）
```

从 20 步压缩到 3 步。classify 是纯函数，可 100% 用单元测试覆盖。

## 四、语言选型

### 4.1 评估维度

| 维度 | 权重 | 含义 |
|------|------|------|
| AI bug 拦截 | 最高 | AI 生成代码时，多少 bug 在编写阶段就被拦住 |
| 状态机表达 | 高 | discriminated union + 穷举 match 的语言级支持 |
| AI 代码质量 | 高 | AI 在该语言上生成正确代码的能力 |
| 生态适配 | 中 | HTTP / SQLite / filesystem / hash / XML→MD 的库成熟度 |
| 重写成本 | 中 | 全量重写的预估工作量 |

### 4.2 对比

| | Python | TypeScript | Rust | Go | Kotlin |
|--|--------|-----------|------|-----|--------|
| AI bug 拦截 | 3 — pyright 可绕过 | **5** — strict 不可绕过 | 4 — 最强但 AI 用 clone 逃避 | 2 — 类型弱 | 4 — null safe + sealed |
| 状态机表达 | 2 — match 不强制穷举 | **5** — discriminated union + never | 5 — enum + match | 1 — 无原生支持 | 4 — sealed + when |
| AI 代码质量 | 4 | **5** | 2 | 4 | 3 |
| 生态适配 | **5** — 全部现成 | 4 — 全部有等价库 | 3 — 无 HTML→MD 库 | 3 — 无 HTML→MD 库 | 3 — JVM 重 |
| 重写成本 | 5 — ~2000 行改动 | 3 — ~8000 行 | 1 — ~13000 行 | 2 — ~10000 行 | 3 — ~8000 行 |
| **总分 (/25)** | **19** | **22** | **15** | **12** | **17** |

### 4.3 结论

**TypeScript strict** 在 AI bug 拦截、状态机表达、AI 代码质量三个最高权重维度上全部拿到最高分。

- vs Python：TypeScript 的类型安全是强制的不是建议的；discriminated union + `never` 穷举检查是语言原生的
- vs Rust：类型系统接近但 AI 写 TypeScript 的质量远高于 Rust（不会频繁卡在 borrow checker 上用 clone 逃避）
- vs Kotlin：能力接近但 TypeScript 的 AI 生态和 CLI 工具生态更好
- vs Go：Go 类型系统不足以支撑状态机架构（无 discriminated union、无穷举 match）

### 4.4 TypeScript 生态对应

| 需求 | Python 当前 | TypeScript 等价 |
|------|------------|----------------|
| HTTP 客户端 | httpx | fetch (内置) / axios |
| SQLite | sqlite3 | better-sqlite3（同步 API，性能好） |
| 文件系统 | os / pathlib | node:fs / node:path |
| 哈希 | xxhash | xxhash-wasm / node:crypto |
| XML 解析 | xml.etree.ElementTree | fast-xml-parser |
| HTML→MD | 手写 | turndown（成熟库，可选） |
| CLI | argparse | commander / yargs |
| 测试 | pytest | vitest |

## 五、重写范围

全量重写，不保留 Python 代码。

| 模块 | 新代码量估算 | 说明 |
|------|------------|------|
| types + state machine | ~300 行 | FileState enum, classify 逻辑 |
| scanner (cloud + local) | ~400 行 | 扫描 + map_cloud_name |
| metadata (SQLite) | ~500 行 | better-sqlite3, schema 沿用 |
| engine (orchestrator) | ~400 行 | scan → classify → execute 三步 |
| moves (content hash matching) | ~200 行 | 纯 hash 匹配，不依赖文件名 |
| API client | ~500 行 | 有道云 API 调用 |
| transfer (download/upload) | ~400 行 | 文件传输 + 格式转换 |
| convert (XML/JSON → MD) | ~500 行 | 移植现有手写解析 |
| CLI entry point | ~100 行 | |
| **源码合计** | **~3,300 行** | 当前 Python ~7,000 行的 47% |
| 测试 | ~2,000 行 | 状态机每状态一个用例 + 集成测试 |
| **总计** | **~5,300 行** | |

代码量大幅减少的原因：状态机架构消除了 calibrate、reconcile_moves 的大量复杂代码（这些变成了 classify 里的几行判断）；TypeScript 类型系统消除了手动类型检查代码。

## 六、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 重写过程中引入新 bug | 高 | 状态机每状态独立测试；TypeScript 编译器拦截类型错误 |
| 有道云 API 逆向调试不便 | 中 | 保留一份 Python API 调试脚本（tools/debug/），TS 版用 fetch 等价实现 |
| XML/JSON→MD 转换边界情况 | 中 | 移植现有 Python 测试用例到 vitest，逐个验证 |
| SQLite schema 兼容性 | 低 | 沿用现有 schema，better-sqlite3 与 Python sqlite3 完全兼容 |

## 七、参考文档

| 文档 | 与本分析的关系 |
|------|-------------|
| [rust-rewrite-analysis.md](rust-rewrite-analysis.md) | Rust 重写不可行的详细论证（AI 写 Rust 效率低、58% bug 是逻辑问题）。TypeScript 避免了 Rust 的问题 |
| [type-driven-design-audit.md](type-driven-design-audit.md) | TypedDict + magic-key 是当前类型安全最大短板。TypeScript 的 interface + readonly 从根源解决 |
| [git-lessons-and-algorithms.md](git-lessons-and-algorithms.md) | content hash + Merkle tree 已实现但只用于辅助。新架构将 content hash 作为核心决策驱动 |
| [sync-algorithm-audit.md](sync-algorithm-audit.md) | 算法优化已完成但决策模型未变。新架构用状态机替代 mtime 优先的 decide_action |
