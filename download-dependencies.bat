@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem Bootstrap every build dependency from a fresh Windows checkout. This file is
rem deliberately idempotent: warm installs are version-checked and reused.
set "ROOT=%~dp0"
set "SILENT_MODE="
if /i "%SILENT%"=="1" set "SILENT_MODE=1"

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="/s" set "SILENT_MODE=1" & shift & goto parse
if /i "%~1"=="--silent" set "SILENT_MODE=1" & shift & goto parse
if /i "%~1"=="-s" set "SILENT_MODE=1" & shift & goto parse
echo [download-dependencies] Unknown argument: "%~1"
exit /b 2

:parsed
pushd "%ROOT%" >nul 2>nul
if errorlevel 1 (
  echo [download-dependencies] Cannot enter "%ROOT%".
  exit /b 1
)

call :refresh_path
call :ensure_winget_tools
if errorlevel 1 goto failed
call :refresh_path

call :verify_bun
if errorlevel 1 goto failed
call :verify_node
if errorlevel 1 goto failed

call :install_workspace "."
if errorlevel 1 goto failed
call :install_workspace "gui"
if errorlevel 1 goto failed

echo [download-dependencies] Dependencies are ready.
set "CODE=0"
goto finish

:ensure_winget_tools
set "NEED_WINGET="
where bun >nul 2>nul
if errorlevel 1 set "NEED_WINGET=1"
where node >nul 2>nul
if errorlevel 1 set "NEED_WINGET=1"
if defined NEED_WINGET (
  where winget >nul 2>nul
  if errorlevel 1 (
    echo [download-dependencies] winget is required to bootstrap Bun and Node.js on a fresh Windows install.
    echo [download-dependencies] Install App Installer from Microsoft, then rerun this script.
    exit /b 1
  )
)

where bun >nul 2>nul
if errorlevel 1 (
  echo [download-dependencies] Bun is missing; installing the pinned Bun package with winget...
  winget install --id Oven-sh.Bun --scope user --accept-source-agreements --accept-package-agreements --silent
  if errorlevel 1 (
    echo [download-dependencies] Bun installation failed. The exact winget exit code was %errorlevel%.
    exit /b 1
  )
)

where node >nul 2>nul
if errorlevel 1 (
  echo [download-dependencies] Node.js is missing; installing the user-scoped LTS package with winget...
  winget install --id OpenJS.NodeJS.LTS --scope user --accept-source-agreements --accept-package-agreements --silent
  if errorlevel 1 (
    echo [download-dependencies] Node.js installation failed. The exact winget exit code was %errorlevel%.
    exit /b 1
  )
)
exit /b 0

:refresh_path
set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%USERPROFILE%\.bun\bin;%PATH%"
exit /b 0

:verify_bun
where bun >nul 2>nul
if errorlevel 1 (
  echo [download-dependencies] Bun is still unavailable after bootstrap. PATH was refreshed for the current process.
  exit /b 1
)
for /f "delims=" %%V in ('bun --version 2^>nul') do set "BUN_VERSION=%%V"
if not "%BUN_VERSION%"=="1.3.14" (
  echo [download-dependencies] Bun 1.3.14 is required; found "%BUN_VERSION%".
  exit /b 1
)
echo [download-dependencies] Bun %BUN_VERSION% verified.
exit /b 0

:verify_node
where node >nul 2>nul
if errorlevel 1 (
  echo [download-dependencies] Node.js is still unavailable after bootstrap.
  exit /b 1
)
for /f "delims=" %%V in ('node --version 2^>nul') do set "NODE_VERSION=%%V"
for /f "tokens=1 delims=v." %%M in ("%NODE_VERSION%") do set "NODE_MAJOR=%%M"
if not defined NODE_MAJOR (
  echo [download-dependencies] Could not parse Node.js version "%NODE_VERSION%".
  exit /b 1
)
if %NODE_MAJOR% LSS 18 (
  echo [download-dependencies] Node.js 18 or newer is required; found "%NODE_VERSION%".
  exit /b 1
)
echo [download-dependencies] Node.js %NODE_VERSION% verified.
exit /b 0

:install_workspace
set "WORKSPACE=%~1"
echo [download-dependencies] Installing %WORKSPACE% dependencies with the frozen lockfile...
pushd "%WORKSPACE%" >nul
call bun install --frozen-lockfile
set "CODE=%ERRORLEVEL%"
popd >nul
if not "%CODE%"=="0" (
  echo [download-dependencies] bun install failed in %WORKSPACE% with exit code %CODE%.
  exit /b %CODE%
)
exit /b 0

:failed
set "CODE=1"

:finish
popd >nul 2>nul
if not defined SILENT_MODE if not "%CODE%"=="0" pause
exit /b %CODE%
