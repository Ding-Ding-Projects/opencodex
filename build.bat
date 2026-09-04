@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "ROOT=%~dp0"
set "SILENT_MODE="
if /i "%SILENT%"=="1" set "SILENT_MODE=1"
set "RUN_AFTER_BUILD="

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="/s" set "SILENT_MODE=1" & shift & goto parse
if /i "%~1"=="--silent" set "SILENT_MODE=1" & shift & goto parse
if /i "%~1"=="-s" set "SILENT_MODE=1" & shift & goto parse
if /i "%~1"=="--run" set "RUN_AFTER_BUILD=1" & shift & goto parse
echo [build] Unknown argument: "%~1"
exit /b 2

:parsed
pushd "%ROOT%" >nul 2>nul
if errorlevel 1 (
  echo [build] Cannot enter "%ROOT%".
  exit /b 1
)

call "%ROOT%download-dependencies.bat" /s
if errorlevel 1 goto failed

echo [build] Typechecking the proxy...
call bun run typecheck
if errorlevel 1 goto failed

echo [build] Building the dashboard and production package...
call bun run build:gui
if errorlevel 1 goto failed

if not exist "%ROOT%gui\dist\index.html" (
  echo [build] Build completed without gui\dist\index.html; refusing to claim success.
  goto failed
)
echo [build] Built gui\dist\index.html from commit:
for /f "delims=" %%H in ('git rev-parse HEAD 2^>nul') do echo [build] %%H

if defined SILENT_MODE goto success
if defined RUN_AFTER_BUILD goto run
choice /c YN /n /m "[build] Build complete. Run the proxy now? [Y/N] "
if errorlevel 2 goto success

:run
echo [build] Starting the proxy. Press Ctrl+C to stop it.
call bun run start
set "CODE=%ERRORLEVEL%"
goto finish

:success
set "CODE=0"
echo [build] Build complete.
goto finish

:failed
set "CODE=1"
echo [build] Build failed; no runnable result is being reported.

:finish
popd >nul 2>nul
if not defined SILENT_MODE if "%CODE%"=="1" pause
exit /b %CODE%
