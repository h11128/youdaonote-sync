# Engine Rewrite Diff Report: Python vs TypeScript

> **Historical (2026-03).** For current usage see the root [README](../../README.md); docs index at [docs/README.md](../README.md).


Comparison of `src/sync/engine.py` (Python, source of truth) with `ts-src/src/engine.ts` (TypeScript rewrite).

---

## P0: Logic Bugs or Missing Critical Functionality

### 1. **Conflict handling ignores sync direction** (Python 965–992 vs TS executor 169–201)

**Python** `_do_conflict` (engine.py:965–992) branches on `direction`:
- `PULL`: backup + download
- `PUSH`: backup (if cloud_id and local_path) + upload
- `BOTH`: backup + download (or download only if no local file)

**TS** `executeSingle` conflict case (executor.ts:169–201) always does backup + download, regardless of direction. There is no `direction` parameter passed to the executor.

**Impact**: When user selects `direction: 'push'`, conflicts should prefer local and upload. TS always overwrites with cloud.

---

### 2. **Local file moves not executed** (Python moves.py 66–68, 323–324 vs TS executor 204–249)

**Python** `reconcile_moves` performs local file moves via `_move_local_file`:
- Cloud moved: move local file from `local_rel` to `cloud_new` (moves.py:66–68)
- Cross-dir cloud wins: move local file from `local_path` to `cloud_path` (moves.py:323–324)

**TS** `executeSingle` move case (executor.ts:204–249) only calls `api.moveFile` / `api.renameFile` (cloud API). It never moves local files on disk.

**Impact**: When cloud renames/moves a file, or when cloud path wins in cross-dir detection, the local file stays at the old path. Metadata is updated as if it moved, but the file is not moved.

---

### 3. **Cloud move API used incorrectly for “cloud moved” case** (Python 361–402 vs TS executor 204–228)

**Python** `_execute_cloud_moves` runs before downloads/uploads and only handles `PendingMove` (local wins in cross-dir). For “cloud moved” cases, Python moves the local file in `reconcile_moves`, not via cloud API.

**TS** executor move case: when `relPath` is where cloud has the file (Case A), it calls `api.moveFile(oldFileId, newParentId)`. The cloud file is already at `relPath`; moving it to its own parent is a no-op. The local file at `oldPath` is never moved.

---

### 4. **Cloud files not filtered by sync_include/sync_exclude** (Python 649–651 vs TS engine)

**Python** (engine.py:649–651):
```python
if self._sync_include or self._sync_exclude:
    filt = compile_selective_filter(...)
    cloud_files = {k: v for k, v in cloud_files.items() if filt.matches(k)}
```

**TS** engine passes `syncInclude`/`syncExclude` only to `scanLocal`. `cloudSnap` is never filtered.

**Impact**: With selective sync, cloud-only files outside include/exclude are still considered and can trigger downloads.

---

### 5. **cleanupStalePaths runs when using cached scan** (Python 521–522 vs TS 181)

**Python** (engine.py:521–522): `_cleanup_stale_paths` is called only when `did_full_scan and not dry_run`.

**TS** (engine.ts:181): `cleanupStalePaths(cloudSnap)` runs after every execute, including when using cached cloud scan.

**Impact**: With cached scan, `cloudSnap` may be incomplete. Clearing “stale” paths can remove metadata for files that still exist in cloud but were not in the incremental update.

---

### 6. **Lock failure: Python returns empty stats, TS throws** (Python 272–274 vs TS 76–78)

**Python**: On lock failure, returns `empty_stats()` and logs error.

**TS**: Throws `Error('Cannot acquire sync lock...')`.

**Impact**: Different error handling; callers must handle exceptions in TS vs checking stats in Python.

---

## P1: Missing Optimizations or Secondary Features

### 7. **Auto-dedup does not reuse hash_cache and local_files** (Python 346–350 vs TS 187)

**Python** `_run_dedup` (engine.py:346–350):
```python
stats = auto_dedup(..., hash_cache=self._hash_cache, local_files=self._local_files)
```

**TS** (engine.ts:187): `autoDedup(localDir, this.meta, { api: this.api })` — no `hashCache` or `localFiles`.

**Impact**: TS re-scans and re-computes hashes for dedup; slower on large trees.

---

### 8. **Second calibrate_metadata after reconcile_moves** (Python 516–521 vs TS)

**Python** (engine.py:516–521): After `reconcile_moves`, if keys changed, runs `calibrate_metadata` again for affected paths:
```python
changed_keys = post_move_keys - pre_move_keys
if changed_keys and not dry_run:
    calibrate_metadata(self.metadata, affected_cloud, affected_local, ...)
```

**TS**: No second calibration after move detection.

**Impact**: Metadata for paths affected by moves may be less accurate.

---

### 9. **cloud_path parameter not supported** (Python 255–256, 283, 328 vs TS)

**Python** `sync` and `_async_collect_items` accept `cloud_path` for scoped sync (e.g. sync only a subtree).

**TS**: No `cloud_path`; always scans from root.

**Impact**: Cannot limit sync to a subdirectory.

---

### 10. **Warmup uses synchronous batches instead of parallel** (Python 538–541 vs TS 214–237)

**Python** `_warmup_hash_cache` uses `asyncio.to_thread` + `Semaphore` for parallel hash computation.

**TS** `warmupHashCache` computes hashes in batches of 50, synchronously.

**Impact**: Slower hash warmup on large trees.

---

### 11. **Refine: cloud hash cache check missing** (Python 563–568 vs TS 263–272)

**Python** `_refine_conflicts` (engine.py:563–568): Uses cached `cloud_content_hash` from metadata when `cached_cloud_mtime == item.cloud_mtime` to avoid re-downloading.

**TS** `refineConflicts`: Always fetches cloud content; no metadata cache check.

**Impact**: Extra API calls for conflict refinement.

---

### 12. **Move execution order** (Python 337–341 vs TS executor)

**Python**: Runs `_execute_cloud_moves` before `_async_execute_all`, then removes moved items from the execution list.

**TS**: Executes moves inside `executeAll` together with downloads/uploads/conflicts, in a single pass.

**Impact**: Order differences can affect behavior when moves and other operations interact.

---

## P2: Minor Differences (Logging, Cosmetic)

### 13. **HASHABLE_EXTS mismatch** (Python 558 vs TS 26)

**Python**: `.md`, `.txt`, `.html`, `.css`, `.js`, `.json`, `.xml`, `.csv`

**TS**: `.md`, `.txt`, `.html`, `.htm`, `.xml`, `.json` — missing `.css`, `.js`, `.csv`; adds `.htm`.

---

### 14. **Lock: no Windows-specific PID check** (Python 113–128 vs TS lock.ts 67–76)

**Python**: On Windows, uses `ctypes` + `OpenProcess` for PID liveness.

**TS**: Uses `process.kill(pid, 0)`; EPERM handling may differ on Windows.

---

### 15. **fallbackDeleteOldFiles: no warning when skipping** (Python 406–410 vs TS 335–337)

**Python**: Logs warning when skipping delete because upload did not succeed.

**TS**: Silently skips.

---

### 16. **listRecent failure: no warning log** (Python 419–422 vs TS 396–398)

**Python**: Logs `logging.warning("扫描缓存: listRecent 失败...")` when listRecent fails.

**TS**: No log.

---

### 17. **Incremental new file: no debug log** (Python 474 vs TS 434)

**Python**: Logs `logging.debug("扫描缓存: 增量发现新文件 ...")` for new files in incremental update.

**TS**: Comment only; no log.

---

### 18. **dry-run: no print_preview / print_dryrun_summary** (Python 332–335 vs TS 159–161)

**Python**: Calls `print_preview(item)` for each item and `print_dryrun_summary(all_items)`.

**TS**: Only `diagnoseDryrun`; no per-item preview or summary.

---

### 19. **Metadata batch save / dirty tracking** (Python 184–187, 298–302 vs TS)

**Python**: Uses `_meta_dirty` and `METADATA_SAVE_BATCH` (200) to batch metadata saves.

**TS**: Calls `this.meta.save()` once at the end.

---

### 20. **collect_items public API** (Python 423–431)

**Python**: Exposes `collect_items(cloud_dir_id, cloud_path, dry_run)` for external tools.

**TS**: No equivalent public API.

---

### 21. **domain=0 upload warning** (Python 719–722)

**Python** `_do_upload`: Logs warning when uploading domain=0 notes (XML → Markdown format change).

**TS**: No equivalent warning.

---

### 22. **record_sync old_hash** (Python 202–220, 226–238)

**Python** `_record_file_change` passes `old_hash` to `metadata.record_sync`.

**TS**: `meta.recordSync` calls do not pass `old_hash` (if TS metadata supports it).

---

## Summary Table

| # | Severity | Category | Python Lines | TS Lines |
|---|----------|----------|--------------|----------|
| 1 | P0 | Conflict direction ignored | 965–992 | executor 169–201 |
| 2 | P0 | Local file moves not executed | moves 66–68, 323–324 | executor 204–249 |
| 3 | P0 | Cloud move API misuse | 361–402 | executor 204–228 |
| 4 | P0 | Cloud not filtered by include/exclude | 649–651 | engine (missing) |
| 5 | P0 | cleanupStalePaths on cached scan | 521–522 | 181 |
| 6 | P0 | Lock failure behavior | 272–274 | 76–78 |
| 7 | P1 | Dedup hash/local reuse | 346–350 | 187 |
| 8 | P1 | Second calibrate after moves | 516–521 | (missing) |
| 9 | P1 | cloud_path parameter | 255–256, 328 | (missing) |
| 10 | P1 | Parallel hash warmup | 538–541 | 214–237 |
| 11 | P1 | Refine cloud hash cache | 563–568 | 263–272 |
| 12 | P1 | Move execution order | 337–341 | executor |
| 13 | P2 | HASHABLE_EXTS | 558 | 26 |
| 14 | P2 | Lock Windows PID | 113–128 | lock 67–76 |
| 15 | P2 | Fallback skip warning | 406–410 | 335–337 |
| 16 | P2 | listRecent failure log | 419–422 | 396–398 |
| 17 | P2 | Incremental new file log | 474 | 434 |
| 18 | P2 | Dry-run preview/summary | 332–335 | 159–161 |
| 19 | P2 | Metadata batch save | 184–187, 298–302 | (missing) |
| 20 | P2 | collect_items API | 423–431 | (missing) |
| 21 | P2 | domain=0 warning | 719–722 | (missing) |
| 22 | P2 | record_sync old_hash | 202–238 | (verify) |
