# Debug NOTE Table Render Reference

## High-Risk Signals

- Desktop shows "发生了一些错误"
- Good/bad files render differently with similar markdown source
- Reupload completed but render still broken
- `native-table` count is non-zero but client still fails

## Evidence Checklist

- [ ] Good and bad samples confirmed by user
- [ ] `diagnose check-note-tables` outputs captured for both samples
- [ ] Contract fields (`t/tr/tc`, `cw/rh/version`) compared
- [ ] Fix validated with `diagnose verify-note`
- [ ] `sync --dry-run --push` checked for target set
- [ ] Spot check performed on at least two risky files

## Minimal Contract Notes (NOTE tables)

- Top-level table block type must be `t`
- Row blocks must be `tr`
- Cell blocks must be `tc`
- Table attrs should include:
  - `cw`: column widths
  - `rh`: row heights
  - `version`

When contract is violated, fix contract first; do not optimize formatting details before render recovers.

## Incident Metrics

Track for each incident:

- `T1` sample confirmation delay
- `T2` root-cause identification delay
- `T3` fix-to-acceptance delay
- number of rework cycles after initial fix

Use these metrics to evaluate whether this skill actually reduces debug time.
