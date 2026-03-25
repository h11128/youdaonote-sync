---
name: debug-note-table-render
description: Debug NOTE table rendering failures by enforcing sample-first comparison, render-contract checks, and three-gate acceptance. Use when users report "desktop/web client render error", "发生了一些错误", table display mismatch, or NOTE native-table vs pipe-text issues.
---

# Debug NOTE Table Render

## Scope

Use this skill for bugs where markdown-to-note conversion appears successful but client rendering fails or is inconsistent.

## Required Inputs

- `known_good_path`
- `known_bad_path`
- `target_paths[]`
- client surface (`desktop` or `web`)

Do not proceed without confirmed good/bad samples from the user.

## Workflow

1. **Sample lock**
   - Confirm good/bad paths with user.
   - Confirm both are observed in the same client surface.
2. **Structure diagnosis**
   - Run `diagnose check-note-tables` on good/bad and targets.
   - Record shape evidence (`native-table` vs `pipe-text`, `t/tr/tc/pipe` counts).
3. **Render contract check**
   - Compare required NOTE table contract fields:
     - node types: `t`, `tr`, `tc`
     - attrs: `cw`, `rh`, `version`
   - Prioritize missing contract fields over broad byte-level diff.
4. **Minimal fix**
   - Apply the smallest converter/metadata fix that closes the contract gap.
   - Avoid broad refactors until contract is satisfied.
5. **Three-gate acceptance**
   - Structure gate: shape is correct on cloud readback.
   - Sync gate: `sync --dry-run --push` has no unexpected pending targets.
   - Render gate: client spot check passes on at least 2 high-risk files.

## Strategy Switch Rule

If the user corrects sample definitions (for example, swaps good/bad), stop current analysis and restart from Step 1 with new samples.

## Subagent Usage

Use subagents for parallel evidence only:

- Agent A: shape and contract comparison
- Agent B: sync dry-run and pending-kind analysis
- Agent C: render validation plan

Do not run parallel mutating fixes in the same directory.

## Deliverables

Return all of:

- Root cause tied to contract mismatch
- Commands executed
- Evidence from the three gates
- Remaining risks and rollback path

## Output Template

```markdown
## Root Cause
- ...

## Evidence
- Structure: ...
- Sync dry-run: ...
- Render spot check: ...

## Fix Applied
- ...

## Remaining Risk
- ...
```

## References

- See detailed checklist in [reference.md](reference.md)
