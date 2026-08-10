# Scheduled Youdao sync (Windows)

How the daily `YoudaoNoteSync` Task Scheduler job is supposed to run.
This is the ops SOT for scripts under `scripts/` — not `.local-scripts/`.

## What runs

| Piece | Path / name |
|---|---|
| Task name | `YoudaoNoteSync` |
| Entry (preferred) | `scripts/scheduled-sync.ps1` via `powershell.exe -WindowStyle Hidden` |
| Compat wrapper | `scripts/scheduled-sync.bat` → same PS1 |
| Log | `logs/scheduled-sync.log` |
| Lock | `logs/sync.lock` (skip if already running) |
| Node bin | `ts-src/dist/bin.js` (`npm run build` in `ts-src` required) |

The PS1:

1. Runs `node …/dist/bin.js sync --git`
2. Runs `npm run diagnose -- cache` (fail-closed on empty `file_id` but local)
3. Logs ISO timestamps and `Finished with exit code N (sync=… cache=…)`
4. Exits non-zero if sync **or** cache gate failed

Progress Engine (PE) parses that log. Missing log on another host → monitor skip, **not** “同步失败: Log file not found”. Exit 0 with `Sync complete: … N errors` → unhealthy.

## Register / retarget

Silent (no console flash):

```powershell
$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File E:\Projects\youdaonote-sync\scripts\scheduled-sync.ps1' `
  -WorkingDirectory 'E:\Projects\youdaonote-sync'
$task = Get-ScheduledTask -TaskName 'YoudaoNoteSync'
Set-ScheduledTask -TaskName 'YoudaoNoteSync' -Action $action `
  -Trigger $task.Triggers -Settings $task.Settings -Principal $task.Principal
```

XML import template (keep in sync with live task): [`../scripts/scheduled-sync-task.xml`](../../scripts/scheduled-sync-task.xml) — after editing XML, re-import or use `Set-ScheduledTask` above.

## Verify

```powershell
(Get-ScheduledTask -TaskName YoudaoNoteSync).Actions | Format-List Execute,Arguments,WorkingDirectory
Get-Content E:\Projects\youdaonote-sync\logs\scheduled-sync.log -Tail 40
```

```bash
cd E:/Projects/youdaonote-sync/ts-src
npm run diagnose -- cache
```

Expect: Action points at `scripts\scheduled-sync.ps1`; log lines use `[yyyy-MM-dd HH:mm:ss]`; `empty file_id but local: 0`.

## Do not

- Point the task at `.local-scripts/scheduled-sync.bat` (deprecated wrapper)
- Use visible `cmd.exe` / `python.exe` that flashes every run
- Treat PE “Log file not found” style alerts as sync API failure (fixed; report PE probe bugs separately)

## Related

- Metadata rules: [sync-metadata-invariants](../reference/sync-metadata-invariants.md)
- Incident: [2026-08-09 postmortem](../postmortem/2026-08-09-pe-false-alert-and-empty-file-id.md)
