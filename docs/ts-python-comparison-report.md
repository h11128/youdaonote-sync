# TypeScript vs Python Module Comparison Report

Comparison of dedup, moves, and scan modules. Source of truth: Python.

---

## P0 — Critical (Missing Logic / Wrong Behavior)

### Dedup

| # | Location | Issue | Python | TS |
|---|----------|-------|--------|-----|
| 1 | `execute.ts` L36-37 | **Dry-run prints nothing** | Python `_execute_removals` prints `[去重] 删除 {path}` and `{reason}` when `dry_run=True` | TS `executeRemovals` does `if (dryRun) continue` — no console output |
| 2 | `execute.ts` L96-104 | **Empty hash groups not skipped** | Python `auto_dedup` skips groups where hash starts with `_EMPTY_HASH` (xxh3_128 of empty bytes) | TS `autoDedup` has no empty-hash check; empty-file groups may be processed |
| 3 | `resolve.ts` L120-145 | **All-cloud asset group: wrong keep/remove logic** | Python `_resolve_cloud_group`: when any path is asset, prioritizes referenced over unreferenced — keeps ALL referenced, removes ALL unreferenced | TS `resolveAllCloud`: sorts by score, keeps single best; only skips deleting referenced assets. Can keep unreferenced and leave referenced duplicates |
| 4 | `resolve.ts` L45-56 | **cloudScore missing createTime** | Python `_cloud_score` uses `info.get("create_time", 0)` with fallback to cloud_mtime/local_mtime | TS `cloudScore` uses `info.cloudMtime \|\| info.localMtime` — `MetadataRecord` has no `createTime`; DB has it but `rowToMetadata` does not map it |
| 5 | `walk.ts` L24-28 | **Dot directories not skipped** | Python `os.walk` modifies `dirnames[:]` to exclude dirs starting with `.` | TS `walkFiles` recurses into `.git`, `.cursor`, etc. — can include hidden dir files in dedup/ref index |

### Moves

| # | Location | Issue | Python | TS |
|---|----------|-------|--------|-----|
| 6 | `orphan.ts` L27-28, L37 | **discardOrphanDuplicates: missing sanitizeFilename** | Python uses `normalize_filename(os.path.basename(bp)).lower()` for both index and lookup | TS uses `basename(bp).toLowerCase()` — no `sanitizeFilename`. `"My  File.md"` vs `"My File.md"` won't match |

### Scan

| # | Location | Issue | Python | TS |
|---|----------|-------|--------|-----|
| 7 | `local.ts` | **No top-level parallelization** | Python `scan_local` uses `ThreadPoolExecutor` — each top-level subdir scanned in parallel | TS `scanLocal` is fully synchronous; large trees are slower |

---

## P1 — Important (Semantic / Edge-Case Differences)

### Dedup

| # | Location | Issue | Python | TS |
|---|----------|-------|--------|-----|
| 8 | `refs.ts` L16 | **_MD_REF_RE URL skip patterns incomplete** | Python skips: `http://`, `https://`, `data:`, `note://`, `ftp://`, `mailto:`, `//`, `\\\\`; plus `"://" in ref_path`; plus `len(ref_path)>2 and ":" in ref_path[2:]` (Windows paths) | TS: `/^(https?:|data:|note:|ftp:|mailto:|\/\/)/` — missing `\\\\`, generic `://`, Windows `C:\` paths |
| 9 | `execute.ts` L11-23 | **removeEmptyParents root comparison** | Python uses `os.path.abspath(root)` for `parent != root` check | TS uses `join(root)` and `parent !== dirname(parent)` — different loop guard; relative root may misbehave |
| 10 | `resolve.ts` L122-124 | **All-referenced asset group: stats.kept wrong** | Python returns `(cloud_paths, None)` → caller skips, no stats update | TS returns `[]` but still does `stats.kept++` — minor stats inaccuracy |

### Moves

| # | Location | Issue | Python | TS |
|---|----------|-------|--------|-----|
| 11 | `moves.ts` L151-152 | **Phase 2 name match: extra .toLowerCase()** | Python `_detect_name_mismatches` uses `(d, normalize_filename(b))` — case-sensitive | TS uses `sanitizeFilename(basename(np)).toLowerCase()` — case-insensitive. `ReadMe.md` ↔ `readme.md` would match in TS but not Python |

### Scan

| # | Location | Issue | Python | TS |
|---|----------|-------|--------|-----|
| 12 | `local.ts` L145-151 | **Selective filter: not fnmatch-compatible** | Python uses `fnmatch.translate()` — supports `[a-z]`, `[!x]`, etc. | TS `patternToRegex` is simple glob: `*`→`.*`, `?`→`.`; no `[seq]` support |
| 13 | `local.ts` L27 | **readdirSync encoding** | Python `os.scandir` uses default encoding | TS passes `encoding: 'utf-8'` — may affect filenames with non-UTF-8 bytes on some systems |

---

## P2 — Minor (Optimization / Consistency)

### Dedup

| # | Location | Issue | Python | TS |
|---|----------|-------|--------|-----|
| 15 | `hash-index.ts` | **buildHashIndex always requires meta** | Python `build_hash_index(root, metadata=None)` — metadata optional | TS `buildHashIndex(root, meta, opts)` — meta required |
| 16 | `refs.ts` L66 | **buildRefIndex without meta: no setFileRefs** | Python `_build_indexes` with metadata calls `set_file_refs` when parsing md | TS `walkFiles` path never calls `meta.setFileRefs` — refs not cached when using fs walk |
| 17 | `compat.ts` | **findDuplicates / removeDuplicateMetadata** | Python dedup.py has no direct equivalent | TS has metadata-only compat layer — different algorithm (syncAt-based) |
| 18 | `resolve.ts` L33-34 | **classifyDuplicates: no MD5 collision warning** | Python logs `logging.warning` when hash collision detected (same hash, different size) | TS silently skips |

### Moves

| # | Location | Issue | Python | TS |
|---|----------|-------|--------|-----|
| 19 | Architecture | **reconcile_moves vs detectMoves** | Python mutates `cloud_files`, `local_files`, `only_local`, `only_cloud` in place; returns `PendingMove[]` | TS `detectMoves` is pure: takes classified map, returns state updates; no in-place mutation. Engine applies to classified. Semantically equivalent but different structure |

### Scan

| # | Location | Issue | Python | TS |
|---|----------|-------|--------|-----|
| 20 | `scanner.py` | **async_scan_cloud** | Python has `async_scan_cloud` (httpx.AsyncClient, pagination) | TS has only `scanCloud` (async, DirBrowser). No separate paginated/async variant |
| 21 | `cloud.ts` | **scanCloud: no pagination** | Python `async_scan_cloud` paginates with `startIndex`, `max_pages=50` | TS `fetchDir` uses single `getDirInfoById` — assumes API returns full dir in one call |
| 22 | `cloud.ts` | **scanCloud: no seen_ids dedup** | Python `async_scan_cloud` has `seen_ids` to skip duplicate entries in paginated response | TS has no entry-level dedup |
| 23 | `local.ts` | **scanLocal: no top-level parallelism** | Python uses `min(len(top_dirs), cpu_count, 8)` workers | TS single-threaded (see P0#7) |

---

## Summary Table

| Category | P0 | P1 | P2 |
|----------|----|----|-----|
| Dedup | 5 | 3 | 4 |
| Moves | 1 | 1 | 1 |
| Scan | 1 | 2 | 4 |
| **Total** | **7** | **6** | **9** |

---

## Recommended Fix Order

1. **P0-1** Empty hash skip in `autoDedup`
2. **P0-3** All-cloud asset group: keep referenced, remove unreferenced (match Python)
3. **P0-5** Skip dot directories in `walkFiles`
4. **P0-6** Use `sanitizeFilename` in `discardOrphanDuplicates`
5. **P0-2** Dry-run print in `executeRemovals`
6. **P0-4** Add `createTime` to `MetadataRecord` and use in `cloudScore`
7. **P1-8** Extend ref URL skip patterns in `refs.ts`
8. **P1-9** Fix `removeEmptyParents` root handling (use `resolve` for absolute path)
