# Documentation Index

Public docs for [youdaonote-sync](https://github.com/h11128/youdaonote-sync).  
User-facing install, **config SOT**, and end-to-end sync: root [README](../README.md).

## Current

| Doc | Purpose |
|-----|---------|
| [rfc-deterministic-guardrails.md](./rfc-deterministic-guardrails.md) | Sync safety guardrails (delete threshold, empty-cloud abort, audit fields) |
| [note-table-incident-retrospective-2026-03.md](./note-table-incident-retrospective-2026-03.md) | NOTE table render incident: sample-first debug and acceptance gates |
| [typescript-rewrite-design.md](./typescript-rewrite-design.md) | Historical TS rewrite design (Python removed; keep for architecture reference) |

Runtime config is **only** the platform SOT (`config path` / `config doctor`) — never the repo `config/` folder.

## Archive

[`docs/archive/`](./archive/) holds point-in-time audits, Python-era reviews, and harness notes.  
Treat them as **historical snapshots**, not current setup instructions.

Notable archived items:

- [architecture-review-2026-03.md](./archive/architecture-review-2026-03.md) — 2026-03-20 review; many findings since fixed
- [cross-project-runner.md](./archive/cross-project-runner.md) — Cursor multi-project runner (not required to use this tool)
- [reviews/2026-03-29-ai-development-retrospective.md](./archive/reviews/2026-03-29-ai-development-retrospective.md) — agent workflow retrospective

## Contributing templates

- [Issue template](../.github/ISSUE_TEMPLATE/提-issue-请使用这个模版.md)
- [Pull request template](../.github/PULL_REQUEST_TEMPLATE.md)
