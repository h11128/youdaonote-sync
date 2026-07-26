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
| `sync_include` | No | Glob allow-list |
| `sync_exclude` | No | Glob deny-list |

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

See also: [Architecture](../design/architecture.md) · [README E2E flow](../../README.md#端到端同步流程)
