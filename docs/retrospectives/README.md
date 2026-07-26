# Retrospectives

Use this folder for write-ups that still inform current practice (bugs fixed, process changes, guardrails added).

**Naming:** `YYYY-MM-DD-kebab-case.md`  
**Frozen history only:** historical retrospectives stay in this folder with a banner.

## Required sections (after a real incident / CI failure)

Per project practice (`jason-dev-practices`):

1. **Reflection** — Why time was burned (wrong evidence, wrong layer, incomplete “fix”).
2. **Troubleshooting** — Symptom → how to diagnose next time (commands, log keywords, artifacts).
3. **Avoidance** — Concrete guard so the class cannot recur silently (test, assert, checklist item). Name the file and proof command.

## Index

| Doc | Topic |
|-----|-------|
| [2026-03-note-table-incident.md](./2026-03-note-table-incident.md) | NOTE native-table vs pipe-text render failure |
