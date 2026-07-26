# Documentation Index

Public docs for [youdaonote-sync](https://github.com/h11128/youdaonote-sync).

## Current docs

| Doc | Purpose |
|-----|---------|
| [README](../README.md) | Install + E2E sync |
| [guides/configuration.md](./guides/configuration.md) | Config SOT — single directory, doctor, fields |
| [design/architecture.md](./design/architecture.md) | Component / pipeline / sequence diagrams |
| [rfc/RFC-001-deterministic-guardrails.md](./rfc/RFC-001-deterministic-guardrails.md) | Delete threshold, empty-cloud abort, audit log |
| [retrospectives/2026-03-note-table-incident.md](./retrospectives/2026-03-note-table-incident.md) | NOTE table render incident |

## Conventions (aligned with myforge / Progress Engine)

Layout mirrors the common myforge taxonomy (`guides/`, `design/`, `rfc/`, `retrospectives/`, `archive/`). Keep this repo lean: add a folder only when you have a real doc for it.

| Directory | What belongs here | Naming |
|-----------|-------------------|--------|
| `guides/` | How-to for users/operators | `kebab-case.md` |
| `design/` | Current architecture / design SOT | `kebab-case.md` |
| `rfc/` | Proposals and completed RFCs | `RFC-NNN-kebab-case.md` (zero-padded NNN) |
| `retrospectives/` | Post-incident / post-task write-ups that still teach current practice | `YYYY-MM-DD-kebab-case.md` (use `YYYY-MM-…` if day is unknown) |
| `archive/` | Frozen history — audits, old designs, old retros | Keep original filename; place under the subfolder below |

### Archive subfolders

| Subfolder | Contents |
|-----------|----------|
| `archive/design/` | Superseded design docs |
| `archive/audits/` | Point-in-time audits / reviews |
| `archive/migration/` | Python → TypeScript migration artifacts |
| `archive/retrospectives/` | Old retros kept for history only |
| `archive/notes/` | Out-of-scope notes (agent helpers, lessons) |

**Archive rules**

1. Move here when a doc is no longer the source of truth for current behavior.
2. Do not rewrite archive content to match today’s code — add a short banner pointing to current docs instead.
3. Prefer links into `archive/…` over copying paragraphs into live docs.
4. New archive files: keep the original name; put them in the matching subfolder.

### RFC / retrospective tips

- RFC header should include status (`Proposed` / `Accepted` / `Implemented` / `Superseded`) and date.
- New retrospectives: see [retrospectives/README.md](./retrospectives/README.md) (Reflection / Troubleshooting / Avoidance).
- English filenames for new public docs; Chinese is fine inside the body.

## Archive index

See [`archive/README.md`](./archive/README.md).

## Templates

- [Issue template](../.github/ISSUE_TEMPLATE/提-issue-请使用这个模版.md)
- [Pull request template](../.github/PULL_REQUEST_TEMPLATE.md)
