# Silent scheduled Youdao sync + metadata health gate.
# Registered as Task Scheduler job YoudaoNoteSync (no console flash).
# Docs: docs/guides/scheduled-sync.md - prefer this over .local-scripts/*.
#
# Encoding note: this file MUST be UTF-8 with BOM. Windows PowerShell 5.1
# (powershell.exe) reads BOM-less .ps1 as the system ANSI codepage (GBK on
# zh-CN), which corrupts any non-ASCII byte and breaks parsing. The .editorconfig
# override `*.ps1 -> charset = utf-8-bom` keeps this invariant.
#
# Redirection note: PS 5.1 `*>>` writes UTF-16 LE, which would corrupt the log
# (node emits UTF-8). We route native stdout/stderr through `cmd /c ... >> log 2>&1`
# so raw UTF-8 bytes are appended unchanged. The log is read as UTF-8 by the PE
# probe, so it must stay pure UTF-8 (no BOM mid-file, no UTF-16).
param(
    [string]$RepoRoot = "E:\Projects\youdaonote-sync"
)

$ErrorActionPreference = "Stop"
$logDir = Join-Path $RepoRoot "logs"
$logFile = Join-Path $logDir "scheduled-sync.log"
$lockFile = Join-Path $logDir "sync.lock"
$node = "C:\nvm4w\nodejs\node.exe"
$binJs = Join-Path $RepoRoot "ts-src\dist\bin.js"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

function Write-Log([string]$msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    [System.IO.File]::AppendAllText($logFile, "[$ts] $msg`n", $utf8NoBom)
}

# Run a native command, appending its UTF-8 stdout+stderr to the log verbatim
# via cmd.exe redirection (avoids PS 5.1 UTF-16 LE `*>>` corruption).
function Invoke-Logged([string]$workDir, [string]$exe, [string]$argString) {
    $cmd = "cd /d `"$workDir`" && `"$exe`" $argString >> `"$logFile`" 2>&1"
    & cmd.exe /c $cmd
    return $LASTEXITCODE
}

# Exclusive lock via open-for-write (same idea as bat `9>` redirection).
$lockStream = $null
try {
    $lockStream = [System.IO.File]::Open(
        $lockFile,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::Write,
        [System.IO.FileShare]::None
    )
} catch {
    Write-Log "Sync is already running. Skipping."
    exit 1
}

try {
    Write-Log "============================================"
    Write-Log "Starting scheduled sync"
    Write-Log "============================================"

    if (-not (Test-Path $node)) {
        Write-Log "ERROR: missing $node - check nvm4w / node install"
        exit 1
    }
    if (-not (Test-Path $binJs)) {
        Write-Log "ERROR: missing $binJs - run npm run build in ts-src"
        exit 1
    }

    $syncExit = Invoke-Logged $RepoRoot $node "`"$binJs`" sync --git"

    # Fail-closed metadata gate (empty file_id but local -> exit 1).
    # Invoke diagnose via the built dist/bin.js (same channel as sync) rather
    # than `npm run diagnose`, so the scheduled task does not depend on the
    # npm.cmd/npx/tsx shim chain resolving correctly under a non-interactive
    # Task Scheduler process (it broke: npm-cli.js lookup failed in ts-src).
    $cacheExit = Invoke-Logged $RepoRoot $node "`"$binJs`" diagnose cache"

    $final = 0
    if ($syncExit -ne 0) { $final = $syncExit }
    elseif ($cacheExit -ne 0) { $final = $cacheExit }

    Write-Log "Finished with exit code $final (sync=$syncExit cache=$cacheExit)"
    exit $final
} finally {
    if ($lockStream) {
        $lockStream.Dispose()
    }
}
