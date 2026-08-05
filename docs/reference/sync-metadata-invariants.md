# Sync Metadata Invariants

Living reference for agents and reviewers. Root-cause context: [PE #610 postmortem](../postmortem/2026-08-05-pe-task-610-empty-file-id.md).

These rules exist because scheduled sync once wiped `file_id` after a successful upload and left perpetual `localNew`. Treat metadata as a state machine, not a cache dump.

## MUST

1. **`files.file_id` after successful upload/link must be non-empty.** Assert before `recordSync`. Never "skip upload because hash matched" without writing `file_id`.
2. **`cleanupStalePaths` may clear `file_id` only when the path is absent from both cloudSnap and localSnap.** Pre-execute cloudSnap omits just-uploaded paths — local presence is the guard.
3. **Exclude/include filters run before `saveScanVersion`.** Saving an unfiltered snap re-injects excluded paths into metadata every full scan.
4. **Delete: `recordSync` then `removeFileInfo`.** `recordSync` upserts `files`; remove after the log write or deletes resurrect.
5. **Directory actions must not upsert `files` with empty `file_id`.** Use `appendSyncLog` (dirs live in `dirs`).
6. **`cacheCloudFileInfo` conflict updates must refresh `cloud_mtime`** along with `file_id`.
7. **Empty `file_id` rows stay calibratable** (`shouldSkipCalibration` must not skip them). Hash local files before calibrate so Case2 can re-link.
8. **Youdao push 20108 / 211 must recover** (reuse duplicate id / retry update), not leave a failed create as "done".

## Tests required when touching these paths

- Upload then `cleanupStalePaths` keeps `file_id` while local exists
- Empty `file_id` + both sides present → calibrate re-links
- Exclude filtered before metadata save
- Delete leaves no `files` row
- `diagnose cache` warns on `empty file_id but local`

## Do not

- Clear cloud linkage solely because a path is missing from a stale/pre-execute cloudSnap
- Restore hash-collision skip-upload without also linking `file_id`
- Call `recordSync(..., fileId: '')` for directories

## Proof commands

```bash
cd ts-src && npx vitest run src/engine/engine.test.ts src/classify/calibrate.test.ts src/execute/upload.test.ts src/metadata/store.test.ts src/tools/diagnose.test.ts src/engine/cloud-scan-phase.test.ts
npm run diagnose -- cache
```
