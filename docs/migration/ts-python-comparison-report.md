# TypeScript vs Python Module Comparison Report

> **Historical (2026-03).** For current usage see the root [README](../../README.md); docs index at [docs/README.md](../README.md).


Comparison of dedup, moves, and scan modules. Source of truth: Python.

Last updated: 2026-03-10

---

## P0 — Critical (Missing Logic / Wrong Behavior)

**全部已修复。** ✅

### Dedup

| # | Location | Status | Issue | Fix |
|---|----------|--------|-------|-----|
| 1 | `execute.ts` | ✅ | **Dry-run prints nothing** | `handleDryRunAction` 打印 `[去重] 删除` + reason |
| 2 | `execute.ts` | ✅ | **Empty hash groups not skipped** | `shouldSkipEmptyFile` 检查 size === 0 |
| 3 | `resolve.ts` | ✅ | **All-cloud asset group: wrong keep/remove** | `resolveCloudGroup` 实现了完整的 ref/unref 3-way split |
| 4 | `resolve.ts` | ✅ | **cloudScore missing createTime** | `MetadataRecord` 有 `createTime`，`cloudScore` 已使用 |
| 5 | `walk.ts` | ✅ | **Dot directories not skipped** | `walkFiles` L24: `if (ent.name.startsWith('.')) continue` 跳过所有隐藏条目 |

### Moves

| # | Location | Status | Issue | Fix |
|---|----------|--------|-------|-----|
| 6 | `orphan.ts` | ✅ | **missing sanitizeFilename** | 已使用 `sanitizeFilename(basename(...)).toLowerCase()` |

### Scan

| # | Location | Status | Issue | Fix |
|---|----------|--------|-------|-----|
| 7 | `local.ts` | ✅ | **No top-level parallelization** | `scanLocalParallel` 使用 `Promise.all` 并行扫描 |

---

## P1 — Important (Semantic / Edge-Case Differences)

**全部已修复。** ✅

### Dedup

| # | Location | Status | Issue | Fix |
|---|----------|--------|-------|-----|
| 8 | `refs.ts` | ✅ | **URL skip patterns incomplete** | `isExternalOrAbsoluteRef` 包含 `\\\\`、`://`、`includes(':', 2)` |
| 9 | `execute.ts` | ✅ | **removeEmptyParents root comparison** | `resolve(root)` 替代 `join(root)` |
| 10 | `resolve.ts` | ✅ 无需修 | **stats.kept wrong** | 核查后 all-referenced 路径不执行 `stats.kept++`，行为正确 |

### Moves

| # | Location | Status | Issue | Fix |
|---|----------|--------|-------|-----|
| 11 | `moves.ts` | ✅ 无需修 | **Phase 2 extra .toLowerCase()** | Phase 2 无 `toLowerCase`；Phase 3 `.toLowerCase()` 与 Python `.lower()` 一致 |

### Scan

| # | Location | Status | Issue | Fix |
|---|----------|--------|-------|-----|
| 12 | `local.ts` | ✅ | **fnmatch [seq] support** | `patternToRegex` 重写，支持 `[abc]` 和 `[!abc]` |
| 13 | `local.ts` | ➖ 接受差异 | **readdirSync encoding** | Node.js UTF-8 默认行为与 Python 基本一致，不影响正常使用 |

---

## P2 — Minor (Optimization / Consistency)

### Dedup

| # | Location | Status | Issue |
|---|----------|--------|-------|
| 15 | `hash-index.ts` | ➖ 接受差异 | `meta` 必填（Python 可选）。所有调用者都传递 meta，无实际影响 |
| 16 | `refs.ts` | ✅ 无需修 | `processFullWalk` 已调用 `meta.setFileRefs` |
| 17 | `compat.ts` | ➖ 接受差异 | TS 有 metadata-only compat 层（syncAt-based），不需要与 Python 完全一致 |
| 18 | `resolve.ts` | ✅ | `classifyDuplicates` 添加了 `console.warn` hash collision 警告 |

### Moves

| # | Location | Status | Issue |
|---|----------|--------|-------|
| 19 | Architecture | ➖ 接受差异 | TS `detectMoves` 是纯函数设计，语义等价但结构不同 |

### Scan

| # | Location | Status | Issue |
|---|----------|--------|-------|
| 20 | `scanner.py` | ➖ 接受差异 | TS `scanCloud` 使用 `DirBrowser` 接口，无需独立 async 变体 |
| 21 | `cloud.ts` | ➖ 接受差异 | 有道云 API 单次返回完整目录，不需要分页 |
| 22 | `cloud.ts` | ➖ 接受差异 | 无分页则无重复条目问题 |
| 23 | `local.ts` | ✅ | `scanLocalParallel` 已实现（同 P0#7）|

---

## Summary

| Category | P0 | P1 | P2 | 说明 |
|----------|----|----|-----|------|
| Dedup | 5/5 ✅ | 3/3 ✅ | 2 ✅ + 2 ➖ | |
| Moves | 1/1 ✅ | 1/1 ✅ | 1 ➖ | |
| Scan | 1/1 ✅ | 1 ✅ + 1 ➖ | 1 ✅ + 3 ➖ | |
| **Total** | **7/7** | **5/5 + 1➖** | **3 ✅ + 6 ➖** | P0/P1 全部解决 |
