# Final Review — Bug Report

> **状态：唯一发现的 bug（utils.py CRLF carry_cr）已修复**

## 1. metadata.py

### UPSERT logic (lines 285–313)
- **Empty upsert_sets**: Not possible. `upsert_sets` always starts with 3 items (`file_id`, `cloud_mtime`, `local_mtime`), so the SQL is always valid.
- **`excluded.column`**: Correct for SQLite `INSERT ... ON CONFLICT DO UPDATE SET`.
- **Verdict**: No bug.

### NULL schema
- `find_duplicates_by_hash`: `WHERE content_hash != '' AND file_id != ''` — rows with NULL `content_hash` are excluded (SQL `NULL != ''` is NULL/unknown). Correct.
- `find_cloud_file_by_hash`: Uses `content_hash = ?`; NULL rows do not match. Correct.
- `_row_to_file_dict`: `if row[5] is not None` handles NULL. Correct.
- **Verdict**: No bug.

### close() idempotency (lines 167–177)
- After first `close()`, `self._conn` is set to `None`. Second call: `if self._conn:` is False, so the block is skipped.
- **Verdict**: Safe to call twice.

---

## 2. moves.py

### Error recovery (lines 63–78, 267–283)
- **Loop state after `continue`**: On failure we restore with `local_files[local_path] = local_files.pop(cloud_new)`, then `only_local.add(local_path)`, `only_local.add(cloud_new)`. The restored dict is the original `local_info`; on failure we never reach `local_files[cloud_new]["path"] = new_abs`, so `path` stays as `old_abs`. Correct.
- **`local_info` validity**: `local_info = local_files.pop(local_path)` captures the dict before any in-place changes. On error we never modify it. Correct.
- **Verdict**: No bug.

---

## 3. scanner.py

### Sync version `visited` (lines 96, 108–114)
- `visited` is checked and updated inside `active_lock`. All `visited.add()` and `sd_id not in visited` are under the same lock.
- **Verdict**: Thread-safe.

### Async version `visited` (lines 212–224)
- Single-threaded asyncio; no concurrent access to `visited`.
- **Verdict**: Safe.

---

## 4. utils.py — **BUG FOUND → ✅ FIXED**

### `_hash_large_text_file` carry_cr logic (lines 279–283)

**Bug**: When CRLF (`\r\n`) is split across chunks, both `\r` and `\n` are dropped from the hash instead of being replaced with `\n`.

**Trace**:
- Chunk 1 ends with `\r` → `carry_cr = True`, `\r` is not hashed.
- Chunk 2 starts with `\n` → `chunk[0:1] == b"\n"` → `chunk = chunk[1:]`, but `h.update(b"\n")` is never called.
- Result: neither `\r` nor `\n` is hashed. Correct behavior: `\r\n` → `\n`, so we should hash `\n`.

**Impact**:
- Large text files (>1MB) with CRLF at chunk boundaries get wrong hashes.
- Same content can produce different hashes for small vs large files (small uses `_hash_small_text_file` with correct normalization).
- Affects duplicate detection, dedup, and move reconciliation.

**Fix** (applied): Add `h.update(b"\n")` before `chunk = chunk[1:]` when `carry_cr` and chunk starts with `\n`, so the normalized newline is hashed.

### Other cases checked
- **(b) Lone CR**: `carry_cr` + non-`\n` → `h.update(b"\r")`. Correct.
- **(c) EOF with `\r`**: `if carry_cr: h.update(b"\r")`. Correct.
- **(d) Empty chunks**: `f.read(chunk_size)` returns `b""` only at EOF. No mid-file empty chunks.
- **BOM mid-file**: `replace(b"\xef\xbb\xbf", b"", 1)` only strips first occurrence (file start). Mid-file BOM is hashed as content. Acceptable.

---

## 5. engine.py

### `_hash_cache` locking (lines 328–335)
- Read: `with self._lock: cached_hash = self._hash_cache.get(...)`
- Write (in `_do_download`): `with self._lock: self._hash_cache[item.local_path] = content_hash`
- **TOCTOU**: Two threads can both miss cache and both call `compute_content_hash`. Both get the same deterministic result. Redundant work, but correct.
- **Verdict**: No correctness bug.

---

## Summary

| # | File      | Bug? | Details                                                                 |
|---|-----------|------|-------------------------------------------------------------------------|
| 1 | metadata  | No   | UPSERT, NULL handling, and `close()` all correct.                       |
| 2 | moves     | No   | Error recovery restores state correctly.                                |
| 3 | scanner   | No   | `visited` access is properly synchronized.                              |
| 4 | utils     | Yes → **Fixed**  | CRLF split across chunks: both bytes dropped; should hash `\n`. Fix applied: `h.update(b"\n")` before skipping `\n` byte. |
| 5 | engine    | No   | `_hash_cache` TOCTOU causes redundant work only, not wrong results.    |
