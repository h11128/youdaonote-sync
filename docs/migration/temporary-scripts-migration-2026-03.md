# Temporary Scripts Migration (2026-03)

> **Historical (2026-03).** For current usage see the root [README](../../README.md); docs index at [docs/README.md](../README.md).


This note records one-off `.local-scripts` used during NOTE table incident debugging and their permanent replacements.

## Migrated to `diagnose` commands

| Removed temporary script | Permanent command |
| --- | --- |
| `fetch-cloud-note.mjs` | `diagnose fetch-note` |
| `compare-cloud-notes.mjs` | `diagnose compare-note --focus table` |
| `compare-file-info.mjs` | `diagnose compare-note --focus attrs` |
| `raw-json-diff.mjs` | `diagnose compare-note --focus raw` |
| `compare-conflict.mjs` / `compare-conflict.ts` | `diagnose compare-cloud-local` |
| `compare-conflict-detail.mjs` | `diagnose compare-cloud-local --max-diffs N` |

## Removed one-off scripts (not productized)

These scripts were incident-specific probes and are intentionally removed:

- `fix-json-diaries.mjs`
- `redownload-diaries.mjs`
- `find-raw-json.mjs`
- `find-native-table.mjs`
- `diff-table-json.mjs`
- `deep-diff-json.mjs`
- `dump-table-area.mjs`
- `check-child-attrs.mjs`
- `reupload-with-original-json.mjs`
- `list-table-files.mjs`
- `debug-upload-json.mjs`

## Why this cleanup

- Reduce script sprawl and duplicated logic
- Keep debugging entry points discoverable under `diagnose`
- Avoid hardcoded file IDs and machine-specific paths in reusable tooling
