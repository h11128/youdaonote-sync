# Postmortem: PE false Youdao alert + 2532 empty file_id zombies

- **Date**: 2026-08-09
- **Tasks**: PE #734/#738 (monitor), #735/#737 (empty file_id), #740 (robust fail-closed)
- **Commits**: youdaonote-sync `1924695` / `d12588a` + #740; myforge `e06da385` / `2621d8f6` + #740
- **Symptom**: PE showed `YoudaoNoteSync 同步失败: Log file not found` while scheduled sync was healthy; `diagnose cache` showed 2532 empty `file_id` rows

## Conclusion

Two independent design bugs, not one “sync is broken” incident.

1. **PE monitor treated “cannot observe” as “sync failed”.** Missing Windows log on Android/test hosts became an Urgent alert.
2. **youdaonote `cleanupStalePaths` left zombie rows.** It cleared `file_id` for paths outside active *file* snaps (`images/`, `.note` leftovers, dirs in `files`) instead of deleting the row. Count grew forever; sync still reported exit 0.

## Why #1 happened (PE alert)

| Layer | What went wrong |
|---|---|
| Signal | Health = parse `E:/Projects/youdaonote-sync/logs/scheduled-sync.log` |
| Failure mode | `!exists()` → `is_healthy=false` + message `Log file not found` |
| Trigger | Tauri Android UI crawl / temp PE state without that Windows path (see crawl doc) |
| Reality | Host scheduled task `YoudaoNoteSync` LastResult=0; log had `Finished with exit code 0` |

**Principle failure:** A *host-local observability probe* was sold as a *product sync failure*. Absence of the probe’s input is not evidence of Youdao API failure.

**Secondary bug (masked until #734):** `hours_since` was hard-coded `0`, so even non-zero exits could look “recent enough.” Fixed: use log mtime; exit 0 + stale mtime (≥24h) is unhealthy; missing log → `monitor_skipped` (no alert).

## Why #2 happened (empty file_id)

Related to #610/#613 but a different leftover class.

| Fact | Detail |
|---|---|
| Count | 2532 empty `file_id`, all still on disk; 1950 under `/images/`; 469 `.note` with `.md` already linked; 102 dirs wrongly in `files` |
| Classify | Mostly `gone` (~2430), not `localNew` — so day-to-day sync looked fine |
| Mechanism | Local scan **skips** `images/` / `attachments/`; `.note` maps to `.md`. Those paths are **not** in `localSnap` as files. Old `cleanupStalePaths` saw “not in cloudSnap, not in localSnap” → `clearCloudId` → empty row forever |
| GC gap | Comment said “row may remain until GC”; GC only drops old missing-local rows, **not** empty-id artifact rows |

**Principle failure:** Metadata treated as “clear the id and keep the row” without a lifecycle for *non-syncable* paths. Artifact dirs and name-mapped extensions are first-class scan rules; cleanup ignored that contract.

#610 fixed “wipe id after successful upload.” It did **not** remove the soft-clear path that manufactures empty-id zombies for non-snap paths. Warning in `diagnose cache` existed; nothing auto-drained or failed closed.

## What we changed

| Area | Change |
|---|---|
| PE monitor | Resolve log via env → project-index → sibling → fallback; missing → skip; stale mtime after exit 0 → alert |
| PE monitor (#740) | Parse latest-run `Sync complete … N errors`; unhealthy even if wrapper exit was 0; no cross-run error leak |
| Sync cleanup | `cleanupStalePaths` **removes** inactive `files` rows (shared `listInactiveFilePaths`) |
| Sync cleanup (#740) | Every sync `purgeNonSyncableFileRows`; `clearCloudId` API removed |
| CLI / schedule (#740) | Sync file errors → exit 1; `scripts/scheduled-sync.ps1` ISO log + `diagnose cache` gate |
| Ops | `diagnose purge-inactive` (full cloud scan; dry-run on temp DB) |
| Invariants | Doc + MDC + tests: no soft-clear zombies; e2e expects row gone |
| One-shot | Purged 2532 → 0; backup under `%APPDATA%/youdaonote-sync/*.bak-empty-fileid-*` |

## How to keep it from coming back

### Already in place (must not regress)

1. **Invariants** `docs/reference/sync-metadata-invariants.md` §2 / Do-not: no `clearCloudId`-only zombies.
2. **Tests**: `cleanupStalePaths` unit + e2e stale cleanup expects `getFileInfo == null`.
3. **PE unit tests**: missing log skips alert; stale success unhealthy.
4. **Full scheduled sync** runs cleanup after full cloud scan → drains new zombies if any reappear.

### Required gates (fail closed)

| Gate | Owner | Proof |
|---|---|---|
| `diagnose cache` non-zero exit when `empty file_id but local > 0` | youdaonote-sync | `npm run diagnose -- cache`; exit 1 if warn class > 0 |
| PE Youdao alert never uses “Log file not found” as sync failure | progress-engine | `cargo test -p progress-engine youdao_sync` |
| Do not reintroduce `clearCloudId` in `cleanupStalePaths` | code review + rg | `rg clearCloudId ts-src/src/engine` |

### Agent / review rules

- Touching `cleanupStalePaths` / `files` upsert / dir `recordSync`: read invariants first; run e2e-metadata-invariants.
- Adding a PE “system health” probe: **missing input ⇒ skip or Info**, never Urgent “product X failed.”
- Host-path monitors must resolve via env/project-index; hardcoded `E:/…` is fallback only.

## Proof commands

```bash
# youdaonote
cd E:/Projects/youdaonote-sync/ts-src
npx vitest run src/engine/e2e-metadata-invariants.test.ts src/engine/engine.test.ts -t cleanupStale
npm run diagnose -- cache          # expect Without file_id: 0
npm run diagnose -- purge-inactive --dry-run

# PE
cd E:/Projects/myforge
cargo test -p progress-engine youdao_sync
curl -s http://127.0.0.1:9200/api/alerts | rg -i youdao || true
```

## Follow-ups

- [x] Make `diagnose cache` exit non-zero on empty-file_id-but-local (#737)
- [x] PE regression: never alert "Log file not found" (#738)
- [x] Every-sync `purgeNonSyncableFileRows`; remove `clearCloudId`; sync exit≠0 on file errors (#740)
- [x] Scheduled sync: ISO timestamps + diagnose cache gate (`scripts/scheduled-sync.ps1`)
- [x] PE parse `Sync complete … N errors` as unhealthy even if wrapper exit was 0
