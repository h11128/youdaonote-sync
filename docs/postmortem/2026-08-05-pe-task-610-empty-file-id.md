# PE #610 — False empty file_id / upload recovery

- **Date**: 2026-08-05
- **Status**: done
- **Trigger**: scheduled-sync log + `diagnose cache` showed perpetual `localNew` / empty `file_id` after “successful” uploads; intermittent 20108 / 211
- **Commit**: `765477d`

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

## Verification

- Unit: `push-errors`, `calibrate`, `upload`, `guardrails`
- Engine: `engine.test`, `e2e.test`
- [code-reviewer](5796d399-19f3-4685-aea7-611697820410): approved (0 Critical / 0 Warning)

## Follow-ups (ops, not code)

- Next real scheduled sync should drain empty-`file_id` localNew via re-link / 20108 recovery
- Optional: purge gone metadata for renamed `AI模型比较.md` path if still listed in cache
