@echo off
setlocal

set LOG_DIR=%~dp0..\logs
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

set LOG_FILE=%LOG_DIR%\scheduled-sync.log
set LOCK_FILE=%LOG_DIR%\sync.lock

9>"%LOCK_FILE%" (
    call :run_sync
) || (
    echo [%date:~0,4%-%date:~5,2%-%date:~8,2% %time:~0,8%] Sync is already running. Skipping. >> "%LOG_FILE%"
    exit /b 1
)

goto :eof

:run_sync
set TIMESTAMP=%date:~0,4%-%date:~5,2%-%date:~8,2% %time:~0,8%

echo ============================================ >> "%LOG_FILE%"
echo [%TIMESTAMP%] Starting scheduled sync >> "%LOG_FILE%"
echo ============================================ >> "%LOG_FILE%"

C:\nvm4w\nodejs\node.exe E:\Projects\youdaonote-sync\ts-src\dist\bin.js sync --git >> "%LOG_FILE%" 2>&1

set EXIT_CODE=%ERRORLEVEL%
set TIMESTAMP_END=%date:~0,4%-%date:~5,2%-%date:~8,2% %time:~0,8%
echo [%TIMESTAMP_END%] Finished with exit code %EXIT_CODE% >> "%LOG_FILE%"
echo. >> "%LOG_FILE%"

exit /b %EXIT_CODE%

