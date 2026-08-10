# Silent scheduled Youdao sync + metadata health gate.
# Registered as Task Scheduler job YoudaoNoteSync (no console flash).
# Docs: docs/guides/scheduled-sync.md — prefer this over .local-scripts/*.
param(
    [string]$RepoRoot = "E:\Projects\youdaonote-sync"
)

$ErrorActionPreference = "Stop"
$logDir = Join-Path $RepoRoot "logs"
$logFile = Join-Path $logDir "scheduled-sync.log"
$lockFile = Join-Path $logDir "sync.lock"
$node = "C:\nvm4w\nodejs\node.exe"
$binJs = Join-Path $RepoRoot "ts-src\dist\bin.js"
$tsSrc = Join-Path $RepoRoot "ts-src"

if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

function Write-Log([string]$msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $logFile -Value "[$ts] $msg" -Encoding UTF8
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

    if (-not (Test-Path $binJs)) {
        Write-Log "ERROR: missing $binJs — run npm run build in ts-src"
        exit 1
    }

    $syncExit = 0
    & $node $binJs sync --git *>> $logFile
    if ($LASTEXITCODE -ne $null) { $syncExit = $LASTEXITCODE }

    # Fail-closed metadata gate (empty file_id but local → exit 1).
    $cacheExit = 0
    Push-Location $tsSrc
    try {
        & npm.cmd run diagnose -- cache *>> $logFile
        if ($LASTEXITCODE -ne $null) { $cacheExit = $LASTEXITCODE }
    } finally {
        Pop-Location
    }

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
