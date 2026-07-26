# Configuration Guide (Single Source of Truth)

Runtime configuration has **one** directory. The CLI never uses the repo `config/` folder.

## Where is the SOT?

| Priority | Source |
|----------|--------|
| 1 | `YOUDAONOTE_CONFIG_DIR` (optional override) |
| 2 | Windows: `%APPDATA%\youdaonote-sync\` |
| 2 | macOS / Linux: `~/.config/youdaonote-sync/` |

```bash
cd ts-src
npx youdaonote-sync config path      # print active directory
npx youdaonote-sync config doctor    # missing files / dual-config conflict
```

Implementation: [`ts-src/src/util/config-dir.ts`](../../ts-src/src/util/config-dir.ts).

## Files in the SOT

| File | Required | Written by |
|------|----------|------------|
| `config.json` | Yes | You (from template) |
| `cookies.json` | Yes for sync | `npx youdaonote-sync login` |
| `sync_metadata.db` | Created on first sync | Engine |

Templates in the **repo** (not runtime):

- [`config.example.json`](../../config.example.json)
- [`.env.example`](../../.env.example) — optional; only for `YOUDAONOTE_CONFIG_DIR` / `YOUDAONOTE_VERBOSE`

## First-time setup

```bash
cd ts-src
npm install && npm run build
npx youdaonote-sync config path
# Copy config.example.json → <SOT>/config.json and set local_dir
npx youdaonote-sync login
npx youdaonote-sync config doctor
npx youdaonote-sync sync --dry-run
npx youdaonote-sync sync
```

### `config.json` fields

| Field | Required | Meaning |
|-------|----------|---------|
| `local_dir` | Yes | Absolute path to local notes root |
| `smms_secret_token` | No | [SM.MS](https://sm.ms/home/apitoken) token; empty = download images locally |
| `is_relative_path` | No | Prefer relative image links in Markdown |
| `maxDeletesPerSync` | No | Default `5`; exceed → sync suspended ([RFC-001](../rfc/RFC-001-deterministic-guardrails.md)) |
| `sync_include` | No | Glob allow-list (array of strings) |
| `sync_exclude` | No | Glob deny-list (array of strings) |

### Delete propagation

By default, when one side deletes a previously-synced file the engine **skips** it (safe mode). Pass `--propagate-deletes` on the CLI to enable actual deletion:

- **Local deleted → cloud**: the cloud file is removed via API.
- **Cloud deleted → local**: the local file is moved to `{local_dir}/.trash/{YYYY-MM-DD}/` (preserving relative path). No automatic cleanup.

The `maxDeletesPerSync` guardrail still applies: if deletes exceed the threshold, sync is suspended with a dry-run report regardless of `--propagate-deletes`.

### Selective sync (include / exclude)

`sync_include` and `sync_exclude` are pattern arrays evaluated against the **relative path** inside the note tree (e.g. `"工作/计划.md"`).

- If `sync_include` is set, **only** matching paths are synced.
- `sync_exclude` removes matching paths from the sync set.
- Excluded paths already tracked in metadata are purged on next sync run.
- Matching uses a custom converter in [`scan/name.ts`](../../ts-src/src/scan/name.ts) (`patternToRegex`): `*` → `.*` (can cross `/`), `?` → `.`, and `[...]` character classes. This is **not** minimatch — `*` is path-wide, not single-segment.

Example:

```json
{
  "local_dir": "D:/Notes",
  "sync_include": ["工作/*", "学习/*"],
  "sync_exclude": ["*/draft-*"]
}
```

## Conflict rules

If **both** `{SOT}/config.json` and `{repo}/config/config.json` exist, sync/login/watch/diagnose **exit with an error**.

Fix: keep only the SOT copy; delete or rename the repo `config/` folder.

If only the old repo `config/` exists, the CLI auto-migrates into the SOT and renames the old folder aside. You can also run:

```bash
npx youdaonote-sync migrate
```

## Optional `.env`

Not required for the default SOT. Use only to override the directory or enable verbose logs. Loaded from repo root or `ts-src/` ([`load-env.ts`](../../ts-src/src/util/load-env.ts)). Never put cookies or tokens in `.env`.

## Checklist

- [ ] `config path` points where you expect
- [ ] `config doctor` shows no conflict and `config.json` / `cookies.json` present
- [ ] `local_dir` exists on disk
- [ ] `sync --dry-run` completes before the first real sync

See also: [Architecture](../design/architecture.md) · [Youdao API](./youdao-api.md) · [README E2E flow](../../README.md#端到端同步流程)
