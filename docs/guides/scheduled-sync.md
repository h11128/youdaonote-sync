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
2. Runs `node …/dist/bin.js diagnose cache` (same channel as sync; NOT `npm run diagnose`, which broke under the non-interactive Task Scheduler process because the npm.cmd/npx/tsx shim chain could not resolve `npm-cli.js`)
3. Logs ISO timestamps and `Finished with exit code N (sync=… cache=…)`
4. Exits non-zero if sync **or** cache gate failed

## Encoding invariant (MUST)

`scheduled-sync.ps1` MUST be saved as **UTF-8 with BOM**. Windows PowerShell 5.1
(`powershell.exe`, what the task invokes) reads a BOM-less `.ps1` as the system
ANSI codepage (GBK on zh-CN), which corrupts any non-ASCII byte and breaks
parsing — the script silently fails with Task Scheduler return code
`0x80070001` and writes nothing to the log. The `.editorconfig` override
`*.ps1 -> charset = utf-8-bom` enforces this. Keep comments/strings ASCII-only
as defense-in-depth.

## Redirection invariant

Native stdout/stderr is appended via `cmd /c "… >> log 2>&1"` so node/npm UTF-8
bytes land verbatim. Do NOT use PS 5.1 `*>>` — it writes UTF-16 LE and corrupts
the log (mixed-encoding makes PE log probes fail).

## Deploy note (one-time)

If upgrading from a version that used `*>>`, `logs/scheduled-sync.log` may
contain UTF-16 LE bytes from the old runs. Continuing to append UTF-8 onto that
produces invalid UTF-8, which makes the PE probe (`read_to_string`) fail the
whole file. After deploying this fix, **truncate or delete
`logs/scheduled-sync.log` once** so the file starts clean UTF-8. Subsequent runs
keep it pure UTF-8.

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

XML import template (keep in sync with live task): [`../../scripts/scheduled-sync-task.xml`](../../scripts/scheduled-sync-task.xml) — after editing XML, re-import or use `Set-ScheduledTask` above.

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

## Diary `.md` + `.note` pair (official app shows two same titles)

The official app hides extensions. If the cloud folder has both
`2026年M月D日.md` and `2026年M月D日.note`, the UI shows two identical
「2026年M月D日」rows. That is a sync bug, not two real diaries.

How it happens: scheduled sync uploads local git `.md` as a **new**
markdown-domain file while the official-app `.note` already exists
(Youdao treats `.md` and `.note` as different names, so 20108 does not
fire). Log line looks like `↑ 内在世界/日记/2026/2026年8月13日.md`.

Prevention (in engine): cloud scan maps `.note` → local `.md` and prefers
`.note` on stem collision; cache snap restores `.note` name when domain is
NOTE; empty `file_id` in metadata forces a full listing; cache snaps hydrate
local-only paths by listing the parent with the same `.note`→`.md` identity
as a full scan (a listing that misses known sibling ids is treated as a stale
dir id and falls back to a full scan); upload uses the scanned file id/name/domain (update, never
create a second `foo.md`); any local `.md` still binds to a same-stem `.note`
if create would otherwise miss it.

Cleanup (never `deleteFile` a diary `.note`):

```bash
npx tsx scripts/merge-diary-md-note-pairs.mts
npx tsx scripts/merge-diary-md-note-pairs.mts --apply 2026年8月13日
```

`--apply` pushes local `.md` onto the `.note` (`restore --force`) then
deletes only the leftover cloud `.md`.

## Related

- Metadata rules: [sync-metadata-invariants](../reference/sync-metadata-invariants.md)
- Incident: [2026-08-09 postmortem](../postmortem/2026-08-09-pe-false-alert-and-empty-file-id.md)
