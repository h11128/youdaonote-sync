# Documentation Index

Public docs for [youdaonote-sync](https://github.com/h11128/youdaonote-sync).

## Living SOT (keep current)

| Doc | Purpose |
|-----|---------|
| [README](../README.md) | Install + E2E sync |
| [guides/configuration.md](./guides/configuration.md) | Config SOT — single directory, doctor, fields |
| [guides/youdao-api.md](./guides/youdao-api.md) | Youdao private API (auth, push/download, fileId) |
| [design/architecture.md](./design/architecture.md) | Component / pipeline / classify Decision Table |
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

Layout mirrors a standard docs taxonomy (`guides/`, `design/`, `rfc/`, `retrospectives/`). No separate `archive/` directory — historical docs live alongside current ones in the same category, distinguished by a Historical banner at the top.

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
2. Historical docs: keep content frozen; add a one-line banner pointing to current docs. Filenames may be renamed only to match the naming table above (e.g. retrospectives → `YYYY-MM-DD-…`). Do not rewrite body text to match today's code.
3. New retrospectives: follow [retrospectives/README.md](./retrospectives/README.md) (Reflection / Troubleshooting / Avoidance).
4. English filenames for new public docs; Chinese is fine inside the body.

## Templates

- [Issue template](../.github/ISSUE_TEMPLATE/提-issue-请使用这个模版.md)
- [Pull request template](../.github/PULL_REQUEST_TEMPLATE.md)
