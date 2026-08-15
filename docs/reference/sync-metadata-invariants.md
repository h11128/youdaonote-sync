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
9. **`cacheCloudFileInfo` conflict updates must refresh `cloud_mtime`** along with `file_id`.
10. **Empty `file_id` rows stay calibratable** (`shouldSkipCalibration` must not skip them). Hash local files before calibrate so Case2 can re-link.
11. **Youdao push 20108 / 211 must recover** (reuse duplicate id / retry update), not leave a failed create as "done".
12. **Upload of a path present in this sync's cloud snapshot must update that file.** Use the scanned `id` / `name` / `domain` (`.note` stays `.note`). Empty or stale metadata `file_id` is not permission to `isCreate` a second `foo.md` beside `foo.note`. Metadata id is only a fallback when the snapshot has no file.
13. **Incomplete index cannot stand in for a live cloud listing.** Cache snap omits empty `file_id` rows; live scan still sees the mapped `.note`. If any `files.file_id` is empty, skip cache and full-scan so membership matches live listing, then write ids back.
14. **One identity everywhere.** `mapCloudName` / `officialAppName` / `pickPreferredCloud` are the only rules for "this local path is that cloud file". Incremental cache must hydrate local-only paths by listing the parent with those same rules before classify — "not in cache" is not "not on cloud".

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
npx vitest run src/engine/e2e-metadata-invariants.test.ts src/engine/purge-nonsyncable.test.ts src/scan/cloud-cache.test.ts
npm run diagnose -- cache          # expect empty file_id but local: 0 (else exit 1)
npm run diagnose -- purge-inactive --dry-run
```

PE side (myforge):

```bash
cargo test -p progress-engine youdao_sync
```

These are SyncEngine pipeline e2e tests (real MetadataStore + local files + mock API), not isolated store unit checks.
