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

## design/ — RFCs only (`rfc-NNN-kebab-case.md`, ≤7)

| Doc | Status | Purpose |
|-----|--------|---------|
| [rfc-001-deterministic-guardrails.md](./design/rfc-001-deterministic-guardrails.md) | Implemented | Delete threshold, empty-cloud abort, audit log |
| [rfc-003-sync-hardening-plan.md](./design/rfc-003-sync-hardening-plan.md) | Implemented | Completed hardening features |
| [rfc-006-sync-engine-overhaul.md](./design/rfc-006-sync-engine-overhaul.md) | Historical | Pre-rewrite engine analysis |
| [rfc-007-typescript-rewrite-design.md](./design/rfc-007-typescript-rewrite-design.md) | Historical | Full type system / Decision Table detail (living bits in architecture) |

## postmortem/ — Still informing practice (`YYYY-MM-DD-kebab-case.md`, ≤7)

| Doc | Purpose |
|-----|---------|
| [2026-03-02-ts-rewrite-retrospective.md](./postmortem/2026-03-02-ts-rewrite-retrospective.md) | TS rewrite gaps (refine/merge/heal, hash, guardrails) |
| [2026-03-20-architecture-review.md](./postmortem/2026-03-20-architecture-review.md) | Dry-run + code architecture review snapshot |
| [2026-03-24-note-table-incident.md](./postmortem/2026-03-24-note-table-incident.md) | NOTE native-table render failure |
| [2026-03-29-ai-development-retrospective.md](./postmortem/2026-03-29-ai-development-retrospective.md) | Diagnose-tool avoidance / agent process |

**New postmortems** include Reflection / Troubleshooting / Avoidance.

## archive/ — Frozen history

| Directory | Contents |
|-----------|----------|
| [archive/design/](./archive/design/) | Older RFCs: [002](./archive/design/rfc-002-rust-rewrite-analysis.md), [004](./archive/design/rfc-004-desktop-data-refactor.md), [005](./archive/design/rfc-005-git-lessons-and-algorithms.md) |
| [archive/postmortem/](./archive/postmortem/) | Point-in-time audits (`YYYY-MM-DD-kebab-case.md`) |
| [archive/legacy/](./archive/legacy/) | **Repo exception:** Python → TypeScript migration artifacts |

## Conventions

| Directory | Naming |
|-----------|--------|
| `reference/` | `kebab-case.md` |
| `guides/` | `kebab-case.md` |
| `design/` **and** `archive/design/` | **`rfc-NNN-kebab-case.md` only** (zero-padded) |
| `postmortem/` **and** `archive/postmortem/` | **`YYYY-MM-DD-kebab-case.md` only** |
| `archive/legacy/` | `YYYY-MM-DD-kebab-case.md` when date known |

### Design RFC number map

| # | File | Topic |
|---|------|-------|
| 001 | `rfc-001-deterministic-guardrails.md` | Sync guardrails |
| 002 | `archive/design/rfc-002-rust-rewrite-analysis.md` | Rust rewrite feasibility |
| 003 | `rfc-003-sync-hardening-plan.md` | Sync hardening |
| 004 | `archive/design/rfc-004-desktop-data-refactor.md` | Desktop data / scan cache |
| 005 | `archive/design/rfc-005-git-lessons-and-algorithms.md` | Git-inspired sync algorithms |
| 006 | `rfc-006-sync-engine-overhaul.md` | Engine overhaul analysis |
| 007 | `rfc-007-typescript-rewrite-design.md` | TypeScript rewrite design |

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
2. Every design doc is an RFC (`rfc-NNN-…`). New design work gets the next free number.
3. Historical docs: frozen content with banner. Keep in active dirs only while still referenced or informing practice.
4. Out-of-scope notes: `.local-docs/` (gitignored).
5. English filenames; Chinese fine in body.

## Local-only (not in git)

| Path | Purpose |
|------|---------|
| `.local-docs/` | Notes unrelated to youdaonote-sync product |

## Templates

- [Issue template](../.github/ISSUE_TEMPLATE/提-issue-请使用这个模版.md)
- [Pull request template](../.github/PULL_REQUEST_TEMPLATE.md)
