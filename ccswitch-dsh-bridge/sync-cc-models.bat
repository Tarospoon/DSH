@echo off
setlocal
set "NODE=C:\Program Files\nodejs\node.exe"
set "SCRIPT=D:\Agent working\DSH\ccswitch-dsh-bridge\sync-cc-models.mjs"

"%NODE%" "%SCRIPT%" --apply
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo Sync finished. Restart DSH to refresh the model list.
) else (
  echo Sync failed. No automatic cleanup was performed.
)
echo.
pause
exit /b %RC%
