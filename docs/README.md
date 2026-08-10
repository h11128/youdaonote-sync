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
| [sync-metadata-invariants.md](./reference/sync-metadata-invariants.md) | Metadata lifecycle: empty `file_id`, purge, fail-closed diagnose |

## guides/ — How-to

| Doc | Purpose |
|-----|---------|
| [configuration.md](./guides/configuration.md) | Config SOT — single directory, doctor, fields |
| [scheduled-sync.md](./guides/scheduled-sync.md) | Windows Task `YoudaoNoteSync` — silent PS1 + cache gate |

## design/ — Newer RFCs (chrono order, ≤7)

RFC numbers follow document date (oldest = 001). Active `design/` keeps the **newest** RFCs so the folder lists contiguous recent numbers.

| # | Doc | Status | Purpose |
|---|-----|--------|---------|
| 005 | [rfc-005-sync-engine-overhaul.md](./design/rfc-005-sync-engine-overhaul.md) | Historical | Pre-rewrite engine analysis (2026-03-01) |
| 006 | [rfc-006-typescript-rewrite-design.md](./design/rfc-006-typescript-rewrite-design.md) | Historical | TypeScript rewrite design (2026-03-01) |
| 007 | [rfc-007-deterministic-guardrails.md](./design/rfc-007-deterministic-guardrails.md) | Implemented | Sync guardrails (2026-04-08) |

## postmortem/ — Still informing practice (`YYYY-MM-DD-kebab-case.md`, ≤7)

| Doc | Purpose |
|-----|---------|
| [2026-08-09-pe-false-alert-and-empty-file-id.md](./postmortem/2026-08-09-pe-false-alert-and-empty-file-id.md) | PE false alert + empty `file_id` zombies (#734–#740) |
| [2026-08-05-pe-task-610-empty-file-id.md](./postmortem/2026-08-05-pe-task-610-empty-file-id.md) | Upload wipe / calibrate / push recovery (#610/#613) |
| [2026-03-24-note-table-incident.md](./postmortem/2026-03-24-note-table-incident.md) | NOTE native-table render failure |
| [2026-03-29-ai-development-retrospective.md](./postmortem/2026-03-29-ai-development-retrospective.md) | Diagnose-tool avoidance |
| [2026-03-20-architecture-review.md](./postmortem/2026-03-20-architecture-review.md) | Architecture review snapshot |
| [2026-03-02-ts-rewrite-retrospective.md](./postmortem/2026-03-02-ts-rewrite-retrospective.md) | TS rewrite gaps (historical; cleanup behavior superseded 2026-08) |

**New postmortems** include Reflection / Troubleshooting / Avoidance.

## archive/ — Older history (chrono)

| Directory | Contents |
|-----------|----------|
| [archive/design/](./archive/design/) | Older RFCs 001–004 (see map below) |
| [archive/postmortem/](./archive/postmortem/) | Point-in-time audits (`YYYY-MM-DD-kebab-case.md`) |
| [archive/legacy/](./archive/legacy/) | **Repo exception:** Python → TypeScript migration artifacts |

### Full RFC map (chronological)

| # | Location | Doc date | Topic |
|---|----------|----------|-------|
| 001 | [archive/design/](./archive/design/rfc-001-rust-rewrite-analysis.md) | 2026-02-21 | Rust rewrite feasibility |
| 002 | [archive/design/](./archive/design/rfc-002-sync-hardening-plan.md) | 2026-02-21 | Sync hardening |
| 003 | [archive/design/](./archive/design/rfc-003-desktop-data-refactor.md) | 2026-02-22 | Desktop data / scan cache |
| 004 | [archive/design/](./archive/design/rfc-004-git-lessons-and-algorithms.md) | 2026-02-21 | Git-inspired sync algorithms |
| 005 | [design/](./design/rfc-005-sync-engine-overhaul.md) | 2026-03-01 | Engine overhaul analysis |
| 006 | [design/](./design/rfc-006-typescript-rewrite-design.md) | 2026-03-01 | TypeScript rewrite design |
| 007 | [design/](./design/rfc-007-deterministic-guardrails.md) | 2026-04-08 | Deterministic guardrails |

## Conventions

| Directory | Naming |
|-----------|--------|
| `reference/` | `kebab-case.md` |
| `guides/` | `kebab-case.md` |
| `design/` **and** `archive/design/` | **`rfc-NNN-kebab-case.md` only** (numbers = chrono order) |
| `postmortem/` **and** `archive/postmortem/` | **`YYYY-MM-DD-kebab-case.md` only** |
| `archive/legacy/` | `YYYY-MM-DD-kebab-case.md` when date known |

**Rules:**

1. SOT docs (`reference/`, root README) must reflect current implementation.
2. RFC numbers increase with document date. Older RFCs move to `archive/design/`; newer stay in `design/` so the active folder lists contiguous recent numbers.
3. New design work gets the next free number; if `design/` would exceed 7, archive the oldest Historical RFC there first.
4. Out-of-scope notes: `.local-docs/` (gitignored).

## Local-only (not in git)

| Path | Purpose |
|------|---------|
| `.local-docs/` | Notes unrelated to youdaonote-sync product |

## Templates

- [Issue template](../.github/ISSUE_TEMPLATE/提-issue-请使用这个模版.md)
- [Pull request template](../.github/PULL_REQUEST_TEMPLATE.md)
