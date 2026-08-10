# PE #610 — False empty file_id / upload recovery

- **Date**: 2026-08-05
- **Status**: done (+ harden follow-up #613)
- **Trigger**: scheduled-sync log + `diagnose cache` showed perpetual `localNew` / empty `file_id` after “successful” uploads; intermittent 20108 / 211
- **Commits**: `765477d` (primary fix); harden in follow-up commit with #613

## Summary

| Symptom | Root cause | Fix |
|---|---|---|
| Upload writes `file_id`, next full scan clears it | `cleanupStalePaths` used pre-upload `cloudSnap` and wiped ids still present locally | Keep `file_id` when `localSnap.has(path)`; require `localSnap` |
| Exclude paths re-enter metadata every full scan | `saveScanVersion` ran before exclude filter | Filter first in `cloud-scan-phase` |
| Empty `file_id` rows never re-link | `shouldSkipCalibration` skipped on `lastSyncAt`/hash | Do not skip empty `file_id`; hash before calibrate |
| 20108 / 211 leave failed uploads | push path only threw | `push-errors` + `pushWithRecovery` reuse dup id / retry conflict |
| Delete then metadata returns | `removeFileInfo` then `recordSync` upsert | `recordSync` then `removeFileInfo` |
| Empty cloud abort too aggressive | Aborted whenever cloud empty | Abort only if linked files `> maxDeletes` |

Intentionally **not** restored: hash-collision skip-upload (that left empty `file_id` forever).

## Why these bugs clustered (principle failures)

1. **No metadata lifecycle invariants.** `files` / `dirs` / `sync_log` roles were implicit. Agents and code treated “clear stale cloud id” as safe without stating *when* local still owns the path.
2. **Snapshot timing not modeled in tests.** Full-scan cleanup used pre-execute `cloudSnap`; unit tests never simulated “upload then cleanup with same session snaps.”
3. **Optimization without linking.** Hash-collision skip-upload avoided an API call but skipped writing `file_id` — a silent contract break.
4. **API error codes treated as fatal.** 20108/211 are recoverable Youdao states; missing recovery made intermittent failures look like permanent localNew.
5. **`recordSync` dual-writes.** Logging and `files` upsert share one API; delete/dir callers easily resurrect or pollute rows.
6. **Observability gap.** `diagnose cache` counted empty `file_id` but did not flag “empty + local exists” as the dangerous class.

## Harness gaps → actions

| Gap | Component | Action |
|---|---|---|
| No written invariants | SopDoc | `docs/reference/sync-metadata-invariants.md` (+ local `.cursor/rules` projection) |
| No exclude-before-save regression | Test | `cloud-scan-phase.test.ts` |
| Stale `cloud_mtime` on cache upsert | Code + test | `cacheCloudFileInfo` updates mtime; store test |
| Dir `recordSync` → empty `file_id` files | Code | `appendSyncLog` for directory actions |
| Diagnose silent on dangerous empties | Diagnose | warn `empty file_id but local` → later **exit 1** (#737/#740) |
| Upload can record empty id | Assert | `requireNonEmpty` after upload |

Living checklist: [sync-metadata-invariants](../reference/sync-metadata-invariants.md).
Scheduled ops: [scheduled-sync](../guides/scheduled-sync.md).
Later drain / fail-closed: [2026-08-09 postmortem](./2026-08-09-pe-false-alert-and-empty-file-id.md) (#735–#740).

## Verification

- Unit: `push-errors`, `calibrate`, `upload`, `guardrails`, `store` cloud_mtime, `diagnose` empty-local warn, `cloud-scan-phase` exclude-before-save
- Engine: `engine.test`, `e2e.test`
- Review: primary fix approved; harden reviewed in follow-up

## Follow-ups

- [x] Residual empty-`file_id` drain + remove soft-clear + scheduled cache gate — see [2026-08-09](./2026-08-09-pe-false-alert-and-empty-file-id.md) (#735/#737/#740)
- Optional: purge gone metadata for renamed `AI模型比较.md`
- [x] PE #613: harden invariants
