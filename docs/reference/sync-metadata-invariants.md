# Sync Metadata Invariants

Living reference for agents and reviewers. Root-cause context:
[PE #610 postmortem](../postmortem/2026-08-05-pe-task-610-empty-file-id.md),
[2026-08-09 PE false alert + empty file_id](../postmortem/2026-08-09-pe-false-alert-and-empty-file-id.md).

Ops for the Windows Task Scheduler job: [scheduled-sync guide](../guides/scheduled-sync.md).

These rules exist because scheduled sync once wiped `file_id` after a successful
upload and later left 2500+ empty-`file_id` zombies via soft-clear. Treat metadata
as a state machine, not a cache dump.

## MUST

1. **`files.file_id` after successful upload/link must be non-empty.** Assert before `recordSync`. Never "skip upload because hash matched" without writing `file_id`.
2. **`cleanupStalePaths` removes `files` rows** absent from both cloudSnap and localSnap *as files* (full cloud scan only). Pre-execute cloudSnap omits just-uploaded paths — local file presence is the guard. Do **not** soft-clear `file_id` (`clearCloudId` API removed). Directories belong in `dirs`, not `files`.
3. **Every sync** runs `purgeNonSyncableFileRows` (`images/` / `attachments/` / `.note`/`.clip` / dirs wrongly in `files`, including deleted extensionless leftovers) — not only full scans.
4. **CLI exits non-zero when `stats.errors > 0` or `failedFiles.length > 0`.** `bin.ts` uses `parseAsync` so async sync/diagnose actions keep `process.exitCode`. Scheduled Task + PE log probe depend on this.
5. **`diagnose cache`**: `empty file_id but local > 0` → `process.exitCode = 1` (fail-closed). Scheduled sync runs this after every sync.
6. **Exclude/include filters run before `saveScanVersion`.** Saving an unfiltered snap re-injects excluded paths into metadata every full scan.
7. **Delete: `recordSync` then `removeFileInfo`.** `recordSync` upserts `files`; remove after the log write or deletes resurrect.
8. **Directory actions must not upsert `files` with empty `file_id`.** Use `appendSyncLog` (dirs live in `dirs`).
9. **`cacheCloudFileInfo` baseline rules:** unsynced rows (`last_sync_at === 0`) refresh `cloud_mtime` with `file_id`; synced rows preserve baseline **only when `file_id` is unchanged** — a relink refreshes `cloud_mtime` from the live scan. `saveScanVersion` runs **before** classify; it must not overwrite synced baselines (classify compares live snap mtime vs stored baseline).
10. **`healCloudMtimeBaseline` before classify:** After obtaining a live cloud snap and before `classifyAll`, repair synced rows where (a) `file_id` relinked to a different cloud id, or (b) stored `cloud_mtime` is ahead of live cloud mtime (pre-fix scan corruption). Engine calls with `autoFix=true` on every non-dry-run sync.
11. **Cached cloud snap must expose live mtimes to classify while DB keeps baselines.** When any `files.last_sync_at > 0` row exists: skip TTL shortcut; if `listRecent` fails or returns empty → force full scan; when cloud version is unchanged → overlay live mtimes from `listRecent` onto the in-memory snap (`overlayLiveMtimesFromRecent`) without overwriting DB baselines.
12. **Empty `file_id` rows stay calibratable** (`shouldSkipCalibration` must not skip them). Hash local files before calibrate so Case2 can re-link.
13. **Youdao push 20108 / 211 must recover** (reuse duplicate id / retry update), not leave a failed create as "done".
14. **Upload of a path present in this sync's cloud snapshot must update that file.** Use the scanned `id` / `name` / `domain` (`.note` stays `.note`). Empty or stale metadata `file_id` is not permission to `isCreate` a second `foo.md` beside `foo.note`. Metadata id is only a fallback when the snapshot has no file.
15. **Incomplete index cannot stand in for a live cloud listing.** Cache snap omits empty `file_id` rows; live scan still sees the mapped `.note`. If any `files.file_id` is empty, skip cache and full-scan so membership matches live listing, then write ids back.
16. **One identity everywhere.** `mapCloudName` / `officialAppName` / `pickPreferredCloud` are the only rules for "this local path is that cloud file". Incremental cache must hydrate local-only paths by listing the parent with those same rules before classify — "not in cache" is not "not on cloud". A successful parent list that omits known same-parent sibling ids is a stale dir id: increment `blocked`, skip merge, and fall back to a full scan. When the cache has no siblings, walk from the root to confirm the dir id before treating a miss as local-new. A hydrate full-scan fallback must not `clear`/`saveScanVersion` an empty or collapsed live snap (any dir list failure is fatal when saving; live size below half the cache is refused). Sibling bind on upload is create-only.
17. **Diary upload guard:** Uploading a local diary file (`YYYY年MM月DD日`) must refuse to overwrite a cloud note if the local file is an empty template shell and the cloud note has handwritten content (`refuseEmptyDiaryUpload`). Baseline `cloud_mtime` preservation (invariants 9–11) keeps `classify` able to trigger conflict resolution before upload.

## Tests required when touching these paths

- Upload then `cleanupStalePaths` keeps `file_id` while local exists
- Empty `file_id` + both sides present → calibrate re-links
- Exclude filtered before metadata save
- Delete leaves no `files` row
- Non-syncable / inactive paths → row **removed** (`getFileInfo == null`), not empty `file_id`
- `diagnose cache` exits `1` when `empty file_id but local > 0`
- CLI / scheduled wrapper: file errors → non-zero exit; log has `Finished with exit code … (sync=… cache=…)`
- Cloud snapshot has `.note` mapped to local `.md` + empty metadata `file_id` → upload updates that `.note` (`isCreate=false`), does not create `.md`
- Metadata has any empty `file_id` → `tryCachedCloudScan` returns null (full scan)
- Hydrate: listing misses known sibling ids → `blocked` and no merge; listing has sibling + wanted `.note` → merge; listing has sibling only → local-new, not blocked
- Hydrate: stale dir id and no cached siblings → `blocked`; blocked fallback + empty or collapsed live scan must not save
- Incremental listing with `.md` and omitted domain → MARKDOWN (not NOTE)
- Upload update of a MARKDOWN target must not rebind a same-stem `.note`
- Synced row + `cacheCloudFileInfo` with new `file_id` → `cloud_mtime` refreshes; same `file_id` → baseline preserved
- `healCloudMtimeBaseline`: file_id relink and baseline-ahead clamp before classify
- `saveScanVersion` then classify: live cloud mtime change vs preserved baseline → `conflict`
- Metadata has synced rows → TTL shortcut skipped (`listRecent` called)

## Do not

- Reintroduce `clearCloudId` / soft-clear leaving empty-`file_id` zombies
- Skip `purgeNonSyncableFileRows` on incremental syncs
- Clear cloud linkage solely because a path is missing from a stale/pre-execute cloudSnap
- Restore hash-collision skip-upload without also linking `file_id`
- Call `recordSync(..., fileId: '')` for directories
- Treat PE missing log as Youdao sync failure (PE policy: `monitor_skipped`)

## Proof commands

```bash
cd ts-src
npx vitest run src/engine/e2e-metadata-invariants.test.ts src/engine/e2e-hydrate-cache.test.ts src/engine/purge-nonsyncable.test.ts src/scan/cloud-cache.test.ts src/scan/hydrate-cached-cloud.test.ts src/metadata/heal-cloud-mtime.test.ts src/metadata/store.test.ts
npm run diagnose -- cache          # expect empty file_id but local: 0 (else exit 1)
npm run diagnose -- purge-inactive --dry-run
```

PE side (myforge):

```bash
cargo test -p progress-engine youdao_sync
```

These are SyncEngine pipeline e2e tests (real MetadataStore + local files + mock API), not isolated store unit checks.
