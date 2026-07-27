# Documentation Index

> Organization follows the cross-project docs standard
> (`/root/Projects/agent-memory/docs/design/docs-organization-standard.md`;
> Windows: `C:\Users\h1112\.codex\agent-memory\docs\design\docs-organization-standard.md`).
> Checklist stub: myforge `docs/docs-organization-standard.md`.
> Constraints: ≤7 items/dir · archive mirrors active structure · depth ≤3.

## reference/ — Living SOT (keep current)

| Doc | Purpose |
|-----|---------|
| [architecture.md](./reference/architecture.md) | Component diagram, pipeline, classify Decision Table |
| [youdao-api.md](./reference/youdao-api.md) | Youdao private API (auth, push/download, fileId) |

## guides/ — How-to

| Doc | Purpose |
|-----|---------|
| [configuration.md](./guides/configuration.md) | Config SOT — single directory, doctor, fields |

## design/ — Active proposals

| Doc | Status | Purpose |
|-----|--------|---------|
| [rfc-001-deterministic-guardrails.md](./design/rfc-001-deterministic-guardrails.md) | Implemented | Delete threshold, empty-cloud abort, audit log |

## postmortem/ — Incidents still informing practice

| Doc | Purpose |
|-----|---------|
| [2026-03-24-note-table-incident.md](./postmortem/2026-03-24-note-table-incident.md) | NOTE native-table render failure |

**New postmortems** use `YYYY-MM-DD-kebab-case.md` and include:

1. **Reflection** — Why time was burned (wrong evidence, wrong layer, incomplete “fix”).
2. **Troubleshooting** — Symptom → how to diagnose next time (commands, log keywords, artifacts).
3. **Avoidance** — Concrete guard so the class cannot recur silently (test, assert, checklist item). Name the file and proof command.

## archive/ — Frozen history

| Directory | Contents |
|-----------|----------|
| [archive/design/](./archive/design/) | Superseded design docs (TS rewrite, Rust analysis, sync hardening) |
| [archive/postmortem/](./archive/postmortem/) | Historical audits and retrospectives |
| [archive/legacy/](./archive/legacy/) | **Repo exception:** Python → TypeScript migration artifacts (not a standard active-tree mirror) |

## Conventions

Standard directories: `reference/`, `guides/`, `design/`, `postmortem/`, `archive/`.

| Directory | Naming |
|-----------|--------|
| `reference/` | `kebab-case.md` |
| `guides/` | `kebab-case.md` |
| `design/` | `rfc-NNN-kebab-case.md` for RFCs; `kebab-case.md` for drafts |
| `postmortem/` | `YYYY-MM-DD-kebab-case.md` |
| `archive/` | Mirrors active dirs (`design/`, `postmortem/`); `legacy/` is this repo’s migration bucket; no item limit |

**Historical banner** (from `docs/archive/<category>/file.md`):

```md
> **Historical (YYYY-MM).** For current usage see the root [README](../../../README.md); docs index at [docs/README.md](../../README.md).
```

From an active dir (`docs/postmortem/`, `docs/design/`, …) use one fewer `../`.

**Rules:**

1. SOT docs (`reference/`, root README) must reflect current implementation.
2. Historical docs: frozen content with banner. Move to `archive/` when no longer actively referenced.
3. Out-of-scope notes: `.local-docs/` (gitignored).
4. English filenames; Chinese fine in body.

## Local-only (not in git)

| Path | Purpose |
|------|---------|
| `.local-docs/` | Notes unrelated to youdaonote-sync product (e.g. cross-project Cursor runner) |

## Templates

- [Issue template](../.github/ISSUE_TEMPLATE/提-issue-请使用这个模版.md)
- [Pull request template](../.github/PULL_REQUEST_TEMPLATE.md)
