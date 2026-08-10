@echo off
REM Compatibility wrapper — Task Scheduler should prefer scheduled-sync.ps1 directly.
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0scheduled-sync.ps1"
exit /b %ERRORLEVEL%
