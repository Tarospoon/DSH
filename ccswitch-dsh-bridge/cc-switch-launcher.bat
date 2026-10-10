@echo off
rem ============================================================
rem  CC Switch launcher: start the cc->DSH watcher (if not running),
rem  then open cc-switch. This bat is what the CC Switch shortcuts point to.
rem  NOTE: keep this file pure ASCII - non-ASCII comments break cmd.exe.
rem ============================================================
setlocal
set "NODE=C:\Program Files\nodejs\node.exe"
set "WATCH=D:\Agent working\DSH\ccswitch-dsh-bridge\watch-cc-to-dsh.mjs"
set "LOCK=D:\Agent working\DSH\ccswitch-dsh-bridge\.watcher.pid"
set "CC=D:\Users\CC Switch\cc-switch.exe"

rem ---- is the watcher already running? (lock file PID still alive) ----
set "RUNNING=0"
if exist "%LOCK%" (
  set /p WPID=<"%LOCK%"
  tasklist /FI "PID eq %WPID%" 2>nul | findstr /I "node.exe" >nul && set "RUNNING=1"
)
if "%RUNNING%"=="0" (
  rem stale lock or not running: clear lock, start watcher minimized
  del "%LOCK%" >nul 2>&1
  start "cc-dsh-watcher" /min "%NODE%" "%WATCH%"
)

rem ---- open cc-switch ----
start "" "%CC%"
endlocal
exit /b 0