# SOLID 与 Dev Practice 审查报告（TypeScript 代码库）

> 审查日期：2026-03-02  
> 审查范围：`ts-src/src/` 全部模块  
> 依据：jason-dev-practices.mdc、memory-rules.mdc、SOLID 原则

---

## 一、总体结论

| 维度 | 评价 |
|------|------|
| S — 单一职责 | 🟡 store.ts、api/client.ts 超 300 行；engine 编排合理 |
| O — 开闭 | 🟢 分类规则表驱动，易扩展 |
| L — 里氏替换 | 🟢 无继承层次，类型为联合/接口 |
| I — 接口隔离 | 🟢 DirBrowser 已抽；ExecuteContext 依赖具体 API 类型 |
| D — 依赖倒置 | 🟡 Engine 直接 new YoudaoNoteApi/MetadataStore，未注入 |
| 前置条件 | 🟡 部分公开方法缺 early validation |
| 类型安全 | 🔴 engine 使用 `as any` 两处 |
| 依赖方向 | 🟡 metadata 依赖 scan/name（路径工具宜放公共层） |
| 测试/文档 | 🟢 纯逻辑有单测；需随变更更新文档 |

---

## 二、问题清单

### P0 — 必须修复

| ID | 问题 | 位置 | 依据 |
|----|------|------|------|
| P0-1 | 使用 `as any` 绕过类型检查 | engine.ts:59 `scanCloud(this.api as any, rootDirId)` | Code Quality：类型安全 |
| P0-2 | 使用 `(ctx as any).dryRun` 写入上下文 | engine.ts:101 | ExecuteContext 已含 dryRun，且 dryRun 时已提前 return，此行多余且破坏类型 |

### P1 — 应该修复

| ID | 问题 | 位置 | 依据 |
|----|------|------|------|
| P1-1 | 单文件超 ~300 行，职责过多 | metadata/store.ts（474 行） | Single responsibility |
| P1-2 | 单文件超 ~300 行 | api/client.ts（411 行） | Single responsibility |
| P1-3 | 数据层依赖扫描层模块 | store.ts 依赖 `../scan/name.js` 的 normalizeSep、sanitizeFilename | Dependency direction：下层不应依赖上层；路径工具应为公共 util |
| P1-4 | Engine 直接 new 依赖，难以测试/替换 | engine.ts 构造函数内 `new YoudaoNoteApi`、`new MetadataStore` | 依赖倒置：应通过构造函数注入接口 |

### P2 — 建议修复

| ID | 问题 | 位置 | 依据 |
|----|------|------|------|
| P2-1 | 公开函数缺少参数前置校验 | classify.ts `classify(input)` 未校验 input 非 null/undefined | Specify preconditions |
| P2-2 | 公开函数缺少参数前置校验 | classifyAll 未校验四个 Map 非 null | Specify preconditions |
| P2-3 | verify/gc/heal 未校验 localDir 非空 | metadata/health.ts | Specify preconditions |

### P3 — 低优先级 / 仅记录

| ID | 问题 | 位置 |
|----|------|------|
| P3-1 | SyncStats 为可变对象，调用方可能误改 | executor 返回 stats，由 executeAll 内部累加，对外只读语义未强制 |
| P3-2 | 已有 solid-audit.md / solid-audit-v2.md 针对 Python，本报告专用于 TS，架构文档可注明“TS 审计见 solid-and-dev-practice-audit-ts.md” |

---

## 三、SOLID 与 Dev Practice 对照

### S — 单一职责
- **store.ts**：同时负责 files、directories、sync_state、sync_log、file_base、migrations、path 规范化、batch、save、health 相关查询。建议拆为：核心 CRUD + 表结构（保留）、migrations 已独立、path 归一化可迁至 util。
- **api/client.ts**：认证、目录列表、文件下载/上传、删除、rootId 缓存等。可考虑按“认证 + 目录浏览”“文件传输”拆分，或仅记录为“单文件偏大”。

### O — 开闭
- 分类逻辑：RULES 表驱动，新增规则只需加配置，符合开闭。

### L — 里氏替换
- 无类继承；FileState 为只读联合类型，stateToAction 用 never 收尾，替换安全。

### I — 接口隔离
- DirBrowser 仅暴露 getDirInfoById，scan 不依赖完整 YoudaoNoteApi，已满足。
- ExecuteContext 中 api 类型为 YoudaoNoteApi，executor 只用到下载/上传等，可后续抽窄为接口（如 FileSyncApi）。

### D — 依赖倒置
- Engine 依赖具体 YoudaoNoteApi、MetadataStore，未通过构造函数注入，测试需真实 DB/API 或改源码。

### Dev Practice
- **前置条件**：setFileInfo/recordSync 已校验 localPath 非空；classify/classifyAll、health 的 verify/gc/heal 未校验。
- **不可变**：FileState 只读；SyncStats 可变但由 executor 单点写入，可接受。
- **DRY**：normalizeSep/sanitizeFilename 仅在一处实现（scan/name），被 store、upload、local 引用，无重复实现。

---

## 四、修复优先级与建议

1. **P0**：去掉两处 `as any`（见下文修复说明）。
2. **P1**：  
   - P1-1/P1-2：可先记录，后续迭代拆文件；或只做“按职责分组注释/小节”以利后续拆。  
   - P1-3：将 normalizeSep、sanitizeFilename 移至公共 util（如 `util/path.js` 或 `util/name.js`），store、scan、execute 均从 util 引用；若暂不挪动，至少在文档中注明“路径工具宜归入公共层”。  
   - P1-4：Engine 构造函数改为接受可选 `api?: YoudaoNoteApi`、`meta?: MetadataStore`，内部 `this.api = api ?? new YoudaoNoteApi(...)`，便于单测注入 mock。
3. **P2**：classify 中对 input 做非空/结构校验；classifyAll 对四个 Map 非 null 校验；verify/gc/heal 对 localDir 非空校验。
4. **P3**：SyncStats 可改为 Readonly<SyncStats> 返回或文档约定只读；在架构/索引文档中引用本报告。

---

## 五、修复记录（2026-03-02）

| 问题 | 修复方式 | 状态 |
|------|----------|------|
| P0-1 | engine.ts：`this.api as any` 改为 `this.api as DirBrowser`，并自 `./scan/cloud.js` 导入 `DirBrowser` | ✅ |
| P0-2 | engine.ts：删除多余的 `(ctx as any).dryRun` 赋值（dryRun 时已提前 return，不会执行到 executeAll） | ✅ |
| P2-1 | classify.ts：`classify(input)` 开头增加 `if (input == null) throw new Error(...)` | ✅ |
| P2-2 | classify.ts：`classifyAll` 开头校验 cloud/local/meta/localHashes 非 null | ✅ |
| P2-3 | metadata/health.ts：`verify`、`gc`、`heal` 开头校验 localDir 非空且为 string | ✅ |

### 彻底修复（同次会话续）

| 问题 | 修复方式 | 状态 |
|------|----------|------|
| P1-1 | 拆 store：store-dirs.ts、store-state.ts、store-files.ts，store.ts 委托后降至 274 行 | ✅ |
| P1-2 | 拆 api：urls.ts、dir.ts、file-api.ts，client.ts 降至 244 行 | ✅ |
| P1-3 | 新增 util/path.ts（normalizeSep、sanitizeFilename），store 改从 util 引用；scan/name 从 util 引入并 re-export | ✅ |
| P1-4 | SyncEngineConfig 增加可选 api?、meta?；构造函数内 `config.api ?? new YoudaoNoteApi(...)` | ✅ |
| P3-1 | executeAll / dryRunStats 返回 `Object.freeze(stats)`，对外只读 | ✅ |
| P3-2 | typescript-rewrite-design.md 增加“TS 代码库 SOLID 与 Dev Practice 审查见 solid-and-dev-practice-audit-ts.md” | ✅ |

---

## 六、修复后验证

- 运行 `npm test`（ts-src 内）：167 个测试通过。
- `tsc --noEmit` 与 Lint 通过。
- 若后续新增 util 或移动代码，按 memory-rules 更新架构/目录说明。

---

## 七、对本次改动的自查（SOLID + Dev Practice）

> 审查对象：为修复 P0～P3 所增改的全部代码（util、metadata 拆片、api 拆片、engine、classify、health、executor、文档）。

### 7.1 SOLID 对照

| 原则 | 改动 | 结论 |
|------|------|------|
| **S** | store 拆成 store-files / store-dirs / store-state；api 拆成 urls / dir / file-api / request；util/path 独立 | ✅ 单文件单职责，每片 ~50～200 行 |
| **O** | 未改分类/规则扩展点 | ✅ 无破坏 |
| **L** | 无继承；Engine 注入可选 api/meta 为同一接口 | ✅ 无破坏 |
| **I** | DirBrowser、DirListContext、FileApiContext 均为窄接口 | ✅ 调用方只依赖所需方法 |
| **D** | Engine 依赖注入 api?/meta?；dir/file-api 依赖 Context 抽象 | ✅ 高层依赖抽象，便于测试 |

### 7.2 Dev Practice 对照

| 条款 | 改动 | 结论 |
|------|------|------|
| **File Management** | 新增 util/path、store-*、api/urls|dir|file-api|request；用户要求「彻底修复」且审计建议拆文件 | ✅ 先看结构再拆；文档已更 |
| **Single responsibility** | 每新文件只做一类事（路径 / 目录表 / 状态表 / 文件表 / URL / 目录列表 / 文件 API / 请求工具） | ✅ |
| **Dependency direction** | metadata → util（不再 → scan）；api 子模块 → types、urls、request | ✅ 下层不依赖上层 |
| **DRY** | 原问题：api/dir 与 api/file-api 各自实现 safeJson；已抽到 api/request.ts，client 一并改用 | ✅ 已修 |
| **Limit mutability** | SyncStats 返回 Object.freeze；新增模块无暴露可变全局 | ✅ |
| **Specify preconditions** | classify/classifyAll、verify/gc/heal 已加参数校验 | ✅ |
| **Comments — WHY** | engine 的 DirBrowser 断言已注明「类型声明与运行时一致、仅断言无 fallback」 | ✅ |
| **Testing** | util/path 由 scan/name.test 覆盖（name re-export）；store-* 由现有 store 单测覆盖；未删减测试 | ✅ |
| **Backward compatibility** | scan/name 对 sanitizeFilename、normalizeSep 做 re-export，调用方无需改 import | ✅ |

### 7.3 已知取舍 / 可后续改进 → 已彻底修复

| 项 | 原说明 | 修复方式 |
|----|--------|----------|
| **engine 的 DirBrowser 断言** | 因 client 返回类型与 DirBrowser 不兼容而用断言 | ✅ 新增 types/dir.ts（DirFileEntry、DirInfoByIdResponse）；api/dir 与 client.getDirInfoById 改为返回 DirInfoByIdResponse；scan DirBrowser 使用同类型；engine 直接 scanCloud(this.api)，无需断言 |
| **store-state.ts 三表合一** | 同时管 sync_state、sync_log、file_base | ✅ 拆为 store-state-kv.ts、store-sync-log.ts、store-file-base.ts；store-state.ts 仅 re-export，职责按表分离 |
| **api/urls.ts 命名** | 内含 BASE_HEADERS，命名略宽 | ✅ 重命名为 api/constants.ts，注释为「URL 与请求常量」 |

### 7.4 自查后修正

- **DRY**：`safeJson` 在 dir.ts、file-api.ts、client 中重复 → 已抽到 **api/request.ts**，三处改为引用，测试通过。

### 7.5 彻底修复 §7.3（本次）

- **engine 断言**：types/dir.ts + API 返回类型兼容 DirBrowser → engine 去掉 `as unknown as DirBrowser`。
- **store-state 拆片**：store-state-kv.ts（sync_state）、store-sync-log.ts（sync_log）、store-file-base.ts（file_base），store-state.ts 仅 re-export。
- **api 常量命名**：urls.ts 重命名为 constants.ts。
- **验证**：`tsc --noEmit` 与 167 个测试通过。
