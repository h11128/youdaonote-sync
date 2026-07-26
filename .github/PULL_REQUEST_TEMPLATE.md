# PR Title

<!-- Keep title specific and outcome-oriented -->

## Summary

- What changed and why
- Scope boundaries (what is intentionally not changed)

## Risk

- Main risk introduced by this PR
- Rollback plan

## Evidence

Use [README diagnose](../README.md#常用诊断) when applicable. For NOTE table render issues, see [incident retrospective](../docs/retrospectives/2026-03-note-table-incident.md).

### Shape Evidence

<!-- Required for converter/render changes -->
- Command:
- Result:
- Notes:

### Dry-run Evidence

<!-- Required for sync-impacting changes -->
- Command:
- Result:
- Notes:

### Desktop Spot Check

<!-- Required for NOTE render incidents -->
- File A:
- File B:
- Result:

## Test Plan

- [ ] Targeted unit tests
- [ ] Build/typecheck
- [ ] Lint
- [ ] Manual verification completed

## Checklist

- [ ] I confirmed sample definitions (`known_good` / `known_bad`) for render-related fixes
- [ ] I validated render contract fields when format conversion is involved
- [ ] I attached evidence for structure + sync + render gates when applicable
- [ ] I updated public docs (`README.md` / `docs/`) if user-facing behavior or commands changed
