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

## design/ — Active / still-referenced designs (≤7)

| Doc | Status | Purpose |
|-----|--------|---------|
| [rfc-001-deterministic-guardrails.md](./design/rfc-001-deterministic-guardrails.md) | Implemented | Delete threshold, empty-cloud abort, audit log |
| [typescript-rewrite-design.md](./design/typescript-rewrite-design.md) | Historical | Full type system / Decision Table detail (living bits in architecture) |
| [sync-engine-overhaul.md](./design/sync-engine-overhaul.md) | Historical | Pre-rewrite engine analysis |
| [sync-hardening-plan.md](./design/sync-hardening-plan.md) | Historical | Completed hardening features |

## postmortem/ — Still informing practice (≤7)

| Doc | Purpose |
|-----|---------|
| [2026-03-02-ts-rewrite-retrospective.md](./postmortem/2026-03-02-ts-rewrite-retrospective.md) | TS rewrite gaps (refine/merge/heal, hash, guardrails) |
| [2026-03-20-architecture-review.md](./postmortem/2026-03-20-architecture-review.md) | Dry-run + code architecture review snapshot |
| [2026-03-24-note-table-incident.md](./postmortem/2026-03-24-note-table-incident.md) | NOTE native-table render failure |
| [2026-03-29-ai-development-retrospective.md](./postmortem/2026-03-29-ai-development-retrospective.md) | Diagnose-tool avoidance / agent process |

**New postmortems** use `YYYY-MM-DD-kebab-case.md` and include:

1. **Reflection** — Why time was burned (wrong evidence, wrong layer, incomplete “fix”).
2. **Troubleshooting** — Symptom → how to diagnose next time (commands, log keywords, artifacts).
3. **Avoidance** — Concrete guard so the class cannot recur silently (test, assert, checklist item). Name the file and proof command.

## archive/ — Frozen history

| Directory | Contents |
|-----------|----------|
| [archive/design/](./archive/design/) | Superseded design notes (Rust analysis, desktop-data, git-lessons) |
| [archive/postmortem/](./archive/postmortem/) | Point-in-time audits (`YYYY-MM-DD-kebab-case.md`) |
| [archive/legacy/](./archive/legacy/) | **Repo exception:** Python → TypeScript migration artifacts |

## Conventions

| Directory | Naming |
|-----------|--------|
| `reference/` | `kebab-case.md` |
| `guides/` | `kebab-case.md` |
| `design/` | RFCs: `rfc-NNN-kebab-case.md`; drafts: `kebab-case.md` |
| `postmortem/` | **`YYYY-MM-DD-kebab-case.md` only** |
| `archive/postmortem/` | same as postmortem (`YYYY-MM-DD-…`) |
| `archive/design/` | `kebab-case.md` |
| `archive/legacy/` | `YYYY-MM-DD-kebab-case.md` when date known |

**Historical banner** (from `docs/archive/<category>/file.md`):

```md
> **Historical (YYYY-MM).** For current usage see the root [README](../../../README.md); docs index at [docs/README.md](../../README.md).
```

From an active dir (`docs/postmortem/`, `docs/design/`, …):

```md
> **Historical (YYYY-MM).** For current usage see the root [README](../../README.md); docs index at [docs/README.md](../README.md).
```

**Rules:**

1. SOT docs (`reference/`, root README) must reflect current implementation.
2. Historical docs: frozen content with banner. Keep in active `design/` / `postmortem/` only while still referenced or informing practice; otherwise `archive/`.
3. Out-of-scope notes: `.local-docs/` (gitignored).
4. English filenames; Chinese fine in body.

## Local-only (not in git)

| Path | Purpose |
|------|---------|
| `.local-docs/` | Notes unrelated to youdaonote-sync product |

## Templates

- [Issue template](../.github/ISSUE_TEMPLATE/提-issue-请使用这个模版.md)
- [Pull request template](../.github/PULL_REQUEST_TEMPLATE.md)
