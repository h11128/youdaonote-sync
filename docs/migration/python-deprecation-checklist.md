# Python → TypeScript 移植 Checklist

> **Historical (2026-03).** For current usage see the root [README](../../README.md); docs index at [docs/README.md](../README.md).


> 创建时间：2026-03-10
> 目的：逐文件对照被删除的 Python 代码，确认 TS 端是否已有对应实现
> 相关文档：`ts-python-comparison-report.md`（模块级差异）、`2026-03-02-ts-rewrite-retrospective.md`（遗漏复盘）

状态说明：
- ✅ 已有对应实现
- ⚠️ 部分实现 / 有差异
- ❌ 缺失
- ➖ 无需移植（空包入口 / Python 特有 / 设计选择不移植）

---

## 1. src/ 核心模块

| # | Python 文件 | 功能 | TS 对应 | 状态 |
|---|------------|------|---------|------|
| 1 | `src/__init__.py` | 包入口 | — | ➖ |
| 2 | `src/__main__.py` | CLI 入口 | `cli.ts` + `index.ts` | ✅ |
| 3 | `src/api.py` | HTTP API 客户端 | `api/client.ts` + `api/dir.ts` + `api/file-api.ts` + `api/request.ts` + `api/retry.ts` + `api/constants.ts` | ✅ |
| 4 | `src/auth.py` | Playwright 登录 + cookie 刷新 | `api/auth.ts` | ✅ `browser-cookie3` 不移植（设计选择：该库不稳定，Playwright 完全覆盖） |
| 5 | `src/cli.py` | CLI 子命令（YoudaoNoteCLI 类） | `cli.ts` → sync/watch/login/gui/list/search/download/pull/diagnose | ✅ |
| 6 | `src/common.py` | 公共类型 + 工具函数 | `types/common.ts`（类型）、`utils.ts`（formatFileSize, safeLongPath）、`util/path.ts`（normalize）、`cli.ts`（loadConfig） | ✅ |
| 7 | `src/cookies.py` | Cookie 读写 + 管理 | `api/cookies.ts` | ✅ |
| 8 | `src/log.py` | 文件+控制台双路日志 | console.log/error | ➖ TS CLI 不需要文件日志 |
| 9 | `src/login.py` | Playwright 交互登录 | `api/auth.ts` → `browserLogin()` | ✅ |
| 10 | `src/protocols.py` | Protocol 接口定义（ISP） | 接口分散在各模块（`scan/cloud.ts` → `DirBrowser` 等） | ✅ |
| 11 | `src/watcher.py` | watchdog 文件监控 | `watcher.ts`（poll + fs.watch + debounce） | ✅ |

## 2. src/gui/ GUI

| # | Python 文件 | 功能 | TS 对应 | 状态 |
|---|------------|------|---------|------|
| 12 | `src/gui/__init__.py` | 包入口 | — | ➖ |
| 13 | `src/gui/app.py` | Tkinter 桌面 GUI | `gui/server.ts`（HTTP 服务）+ `gui/ui.ts`（前端 SPA） | ✅ Web GUI 替代 |
| 14 | `src/gui/controller.py` | GUI 事件控制器 | 逻辑合并到 `gui/server.ts` 路由处理器 | ✅ |

## 3. src/convert/ 格式转换

| # | Python 文件 | 功能 | TS 对应 | 状态 |
|---|------------|------|---------|------|
| 15 | `src/convert/__init__.py` | 包入口 | `convert/index.ts` | ✅ |
| 16 | `src/convert/json_convert.py` | JSON 笔记 → Markdown | `convert/json-to-md.ts` | ✅ |
| 17 | `src/convert/md_to_note.py` | Markdown → .note XML | `convert/md-to-note.ts` | ✅ |
| 18 | `src/convert/note_convert.py` | 统一转换入口 | 拆分到 `xml-to-md.ts` + `json-to-md.ts` + `html-to-md.ts` | ✅ |
| 19 | `src/convert/xml_convert.py` | XML 笔记 → Markdown | `convert/xml-to-md.ts` | ✅ |

## 4. src/sync/ 同步引擎

| # | Python 文件 | 功能 | TS 对应 | 状态 |
|---|------------|------|---------|------|
| 20 | `src/sync/__init__.py` | 包入口 | — | ➖ |
| 21 | `src/sync/bloom.py` | Bloom 过滤器 | `algo/bloom.ts` | ✅ |
| 22 | `src/sync/decision.py` | 文件分类决策 | `classify/classify.ts` + `rules.ts` + `conditions.ts` + `refine.ts` | ✅ |
| 23 | `src/sync/dedup.py` | 内容去重 | `dedup/`（index/walk/resolve/execute/orphan/hash-index/refs/compat） | ✅ 细节差异见 `ts-python-comparison-report.md` |
| 24 | `src/sync/desktop_data.py` | 桌面客户端数据读取 | `desktop-data.ts` | ✅ |
| 25 | `src/sync/engine.py` | 同步引擎主循环 | `engine.ts` + `engine-helpers.ts` + `engine-refine.ts` | ✅ |
| 26 | `src/sync/git_helper.py` | Git auto-commit | `git.ts` | ✅ |
| 27 | `src/sync/merge.py` | diff3 三路合并 | `algo/merge.ts` | ✅ |
| 28 | `src/sync/merkle.py` | Merkle 树增量检测 | `algo/merkle.ts` | ✅ |
| 29 | `src/sync/metadata.py` | SQLite 元数据存储 | `metadata/store.ts` + `store-files.ts` + `store-dirs.ts` + `store-state.ts` 等 | ✅ |
| 30 | `src/sync/metadata_aux.py` | 元数据辅助查询 | 合并到 metadata/store 各子模块 | ✅ |
| 31 | `src/sync/metadata_health.py` | 元数据健康检查 + 自修复 | `metadata/health.ts` | ✅ |
| 32 | `src/sync/metadata_migrations.py` | 数据库迁移 | `metadata/migrations.ts` | ✅ |
| 33 | `src/sync/moves.py` | 文件移动 / 重命名检测 | `classify/moves.ts` | ✅ |
| 34 | `src/sync/rolling_hash.py` | 滚动哈希 / 块级哈希 | `algo/block-hash.ts` | ✅ |
| 35 | `src/sync/scanner.py` | 云端 + 本地扫描 | `scan/cloud.ts` + `scan/local.ts`（含 `scanLocalParallel`）+ `scan/name.ts`；分页和 seen_ids 在 `api/dir.ts` | ✅ |
| 36 | `src/sync/types.py` | 类型定义 | `types/`（common/state/scan/metadata/dir） | ✅ |
| 37 | `src/sync/utils.py` | 同步工具函数 | 功能分散到各模块 | ✅ |

## 5. src/transfer/ 传输模块

| # | Python 文件 | 功能 | TS 对应 | 状态 |
|---|------------|------|---------|------|
| 38 | `src/transfer/__init__.py` | 包入口 | — | ➖ |
| 39 | `src/transfer/download.py` | 单文件下载 + 格式转换 | `execute/download.ts` | ✅ |
| 40 | `src/transfer/image.py` | 图片/附件下载替换 | `execute/images.ts` | ✅ |
| 41 | `src/transfer/image_upload.py` | SM.MS 图床上传 | `execute/image-upload.ts` | ✅ |
| 42 | `src/transfer/pull.py` | 递归全量拉取 | `browse/pull.ts` → `pullAll()` + `downloadFolder()` | ✅ |
| 43 | `src/transfer/search.py` | 云端搜索引擎 | `browse/search.ts` → `searchByName()` + `findFolderByPath()` + `getDirectoryEntries()` | ✅ |
| 44 | `src/transfer/upload.py` | 文件上传 | `execute/upload.ts` | ✅ |

## 6. test/ 测试文件

| # | Python 文件 | TS 对应 | 状态 |
|---|------------|---------|------|
| 45 | `test/test_api.py` | `api/request.test.ts` + `api/file-api.test.ts` + `api/constants.test.ts` + `api/cookies.test.ts` + `api/retry.test.ts` | ✅ |
| 46 | `test/test_bloom.py` | `algo/bloom.test.ts` | ✅ |
| 47 | `test/test_convert.py` | `convert/xml-to-md.test.ts` + `json-to-md.test.ts` + `html-to-md.test.ts` | ✅ |
| 48 | `test/test_convert_ext.py` | 同上（扩展用例） | ✅ |
| 49 | `test/test_decision.py` | `classify/classify.test.ts` + `classify/refine.test.ts` | ✅ |
| 50 | `test/test_dedup.py` | `dedup.test.ts` + `e2e-dedup.test.ts` | ✅ |
| 51 | `test/test_desktop_data.py` | 功能测试在 `e2e.test.ts` 中覆盖 | ✅ |
| 52 | `test/test_download.py` | `execute/download.test.ts` | ✅ |
| 53 | `test/test_e2e_sync.py` | `e2e.test.ts` + `e2e-extra.test.ts` | ✅ |
| 54 | `test/test_engine_int.py` | `engine.integration.test.ts` | ✅ |
| 55 | `test/test_filename.py` | `scan/name.test.ts` | ✅ |
| 56 | `test/test_hash.py` | `hash.test.ts` + `algo/xxhash.test.ts` | ✅ |
| 57 | `test/test_merge.py` | `algo/merge.test.ts` | ✅ |
| 58 | `test/test_merkle.py` | `algo/merkle.test.ts` | ✅ |
| 59 | `test/test_metadata.py` | `metadata/store.test.ts` + `metadata/store-extra.test.ts` + `metadata/migrations.test.ts` | ✅ |
| 60 | `test/test_misc.py` | 分散到各模块测试 | ✅ |
| 61 | `test/test_moves.py` | `classify/moves.test.ts` | ✅ |
| 62 | `test/test_p1_functions.py` | 回归测试，覆盖在 TS 各模块测试中 | ✅ |
| 63 | `test/test_scanner_ext.py` | `scan/cloud.test.ts` + `scan/local.test.ts` + `scan/cloud-cache.test.ts` | ✅ |
| 64 | `test/test_upload.py` | `execute/upload.test.ts` | ✅ |

## 7. tools/ 工具脚本

### 7.1 tools/cli/ 命令行工具

| # | Python 文件 | 功能 | TS 对应 | 状态 |
|---|------------|------|---------|------|
| 65 | `tools/__init__.py` | 包入口 | — | ➖ |
| 66 | `tools/cli/__init__.py` | 包入口 | — | ➖ |
| 67 | `tools/cli/auto_extract_cookies.py` | browser-cookie3 自动提取 | — | ➖ Playwright 替代，不需要 |
| 68 | `tools/cli/capture_api.py` | Playwright 捕获 API 请求 | — | ➖ 开发调试工具，按需手动操作 |
| 69 | `tools/cli/playwright_login.py` | Playwright 登录脚本 | `api/auth.ts` → `browserLogin()` | ✅ 已集成到 `login` 命令 |
| 70 | `tools/cli/update_cookies.py` | 手动输入 cookie | — | ➖ 有 Playwright login，此工具不再需要 |

### 7.2 tools/debug/ 诊断工具

| # | Python 文件 | 功能 | TS 对应 | 状态 |
|---|------------|------|---------|------|
| 71 | `tools/debug/__init__.py` | 包入口 | — | ➖ |
| 72 | `tools/debug/analyze_local.py` | 本地文件分析（extra/dir-match/dir-upload） | `tools/diagnose.ts` → `cmdLocalStats`（`diagnose local`） | ✅ 核心 extra 子命令已移植 |
| 73 | `tools/debug/diagnose_api.py` | API 连通性诊断（basic/detail/large/status） | `tools/diagnose.ts` → `cmdApiStatus`（`diagnose api-status`） | ✅ 核心 status 子命令已移植 |
| 74 | `tools/debug/diagnose_cache.py` | 缓存 vs 全量扫描差异诊断 | `tools/diagnose-commands.ts` → `cmdCache`（`diagnose cache`） | ✅ |
| 75 | `tools/debug/diagnose_sync.py` | 同步诊断（对应 TS `diagnose path/decision/summary`） | `tools/diagnose.ts` → `cmdPath` + `cmdDecision` + `cmdSummary` | ✅ 核心功能已有 |
| 76 | `tools/debug/dryrun_report.py` | dry-run 统计报告 | `tools/diagnose.ts` → `cmdSummary` | ✅ |
| 77 | `tools/debug/inspect_desktop.py` | 桌面客户端数据检查（app/data/sync/format/domain） | — | ➖ 不移植（desktop-data.ts 已有数据读取能力） |
| 78 | `tools/debug/rebuild_metadata.py` | 元数据补全重建 | `tools/diagnose-commands.ts` → `cmdRebuild`（`diagnose rebuild`） | ✅ |
| 79 | `tools/debug/reset_cache_version.py` | 重置扫描缓存版本 | `tools/diagnose.ts` → `cmdResetCache` | ✅ |
| 80 | `tools/debug/scan_duplicates.py` | 本地重复文件扫描 | `tools/diagnose-commands.ts` → `cmdDuplicates`（`diagnose duplicates`） | ✅ |
| 81 | `tools/debug/test_move_api.py` | move_file API 验证 | — | ➖ 一次性测试脚本 |
| 82 | `tools/debug/test_scan_cache.py` | 扫描缓存机制验证 | — | ➖ 一次性测试脚本 |
| 83 | `tools/debug/test_session.py` | Session/Cookie 测试（extract/test/refresh） | — | ➖ 开发调试工具 |
| 84 | `tools/debug/verify_fixes.py` | 修复效果验证 | — | ➖ 一次性验证脚本 |

## 8. 其他被删文件

| # | 文件 | TS 对应 | 状态 |
|---|------|---------|------|
| 85 | `pyproject.toml` | `ts-src/package.json` | ✅ |
| 86 | `requirements.txt` | `ts-src/package.json` dependencies | ✅ |

---

## 统计

| 状态 | 数量 |
|------|------|
| ✅ 已有 | 64 |
| ➖ 无需移植 | 22 |
| **合计** | **86** |

## ⚠️ 已知差异（需另外跟踪）

详见 `ts-python-comparison-report.md`，主要是：
- Dedup 模块 5 个 P0 差异（空 hash 跳过、资产组逻辑、dot 目录等）
- Moves 模块大小写匹配差异
