# Documentation Index

Public docs for [youdaonote-sync](https://github.com/h11128/youdaonote-sync).

## Living SOT (keep current)

| Doc | Purpose |
|-----|---------|
| [README](../README.md) | Install + E2E sync |
| [guides/configuration.md](./guides/configuration.md) | Config SOT — single directory, doctor, fields |
| [design/architecture.md](./design/architecture.md) | Component / pipeline / sequence diagrams |
| [rfc/RFC-001-deterministic-guardrails.md](./rfc/RFC-001-deterministic-guardrails.md) | Delete threshold, empty-cloud abort, audit log |

## Historical (frozen at document date)

| Directory | Contents |
|-----------|----------|
| [design/](./design/) | Current architecture + superseded designs (banner-marked) |
| [audits/](./audits/) | Point-in-time code/architecture audits |
| [migration/](./migration/) | Python → TypeScript migration artifacts |
| [retrospectives/](./retrospectives/) | Post-incident and post-task write-ups |
| [notes/](./notes/) | Out-of-scope notes (agent helpers, lessons) |
| [rfc/](./rfc/) | RFCs (status in header) |

## Conventions

Layout mirrors the myforge / Progress Engine taxonomy. No separate `archive/` directory — historical docs live alongside current ones in the same category, distinguished by a Historical banner at the top.

| Directory | Naming |
|-----------|--------|
| `guides/` | `kebab-case.md` |
| `design/` | `kebab-case.md` |
| `rfc/` | `RFC-NNN-kebab-case.md` (zero-padded) |
| `retrospectives/` | `YYYY-MM-DD-kebab-case.md` |
| `audits/` | `kebab-case.md` (usually dated in content) |
| `migration/` | `kebab-case.md` |
| `notes/` | `kebab-case.md` |

**Rules**

1. SOT docs (`guides/`, `design/architecture.md`, root README) must reflect current implementation.
2. Historical docs: keep original filename; add a one-line banner pointing to current docs. Do not rewrite to match today's code.
3. New retrospectives: follow [retrospectives/README.md](./retrospectives/README.md) (Reflection / Troubleshooting / Avoidance).
4. English filenames for new public docs; Chinese is fine inside the body.

## Templates

- [Issue template](../.github/ISSUE_TEMPLATE/提-issue-请使用这个模版.md)
- [Pull request template](../.github/PULL_REQUEST_TEMPLATE.md)
