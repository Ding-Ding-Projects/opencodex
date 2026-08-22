@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "ROOT=%~dp0"
set "SILENT_MODE="
if /i "%SILENT%"=="1" set "SILENT_MODE=1"

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="/s" set "SILENT_MODE=1" & shift & goto parse
if /i "%~1"=="--silent" set "SILENT_MODE=1" & shift & goto parse
if /i "%~1"=="-s" set "SILENT_MODE=1" & shift & goto parse
echo [build-installer] Unknown argument: "%~1"
exit /b 2

:parsed
pushd "%ROOT%" >nul 2>nul
if errorlevel 1 (
  echo [build-installer] Cannot enter "%ROOT%".
  exit /b 1
)

call "%ROOT%download-dependencies.bat" /s
if errorlevel 1 goto failed
call "%ROOT%build.bat" /s
if errorlevel 1 goto failed

if exist "%ROOT%dist-desktop" rmdir /s /q "%ROOT%dist-desktop"
if exist "%ROOT%dist-desktop" (
  echo [build-installer] Could not clear stale dist-desktop output.
  goto failed
)

echo [build-installer] Packaging the unsigned Squirrel.Windows installer...
call npx --yes electron-builder@26.15.3 --win --publish never
if errorlevel 1 goto failed

set "SETUP="
set "RELEASES="
set "NUPKG="
for /r "%ROOT%dist-desktop" %%F in (*Setup*.exe) do if not defined SETUP set "SETUP=%%F"
for /r "%ROOT%dist-desktop" %%F in (RELEASES) do if not defined RELEASES set "RELEASES=%%F"
for /r "%ROOT%dist-desktop" %%F in (*.nupkg) do if not defined NUPKG set "NUPKG=%%F"
if not defined SETUP (
  echo [build-installer] Setup.exe was not produced under dist-desktop.
  goto failed
)
if not defined RELEASES (
  echo [build-installer] RELEASES was not produced under dist-desktop.
  goto failed
)
if not defined NUPKG (
  echo [build-installer] No full .nupkg was produced under dist-desktop.
  goto failed
)

set "OCX_SETUP=%SETUP%"
set "OCX_NUPKG=%NUPKG%"
for /f "delims=" %%S in ('pwsh.exe -NoProfile -Command "(Get-AuthenticodeSignature -LiteralPath $env:OCX_SETUP).Status"') do set "SIGNATURE=%%S"
if not "%SIGNATURE%"=="NotSigned" (
  echo [build-installer] Setup executable signature status is "%SIGNATURE%"; signing is prohibited.
  goto failed
)
for /f "delims=" %%H in ('pwsh.exe -NoProfile -Command "(Get-FileHash -LiteralPath $env:OCX_SETUP -Algorithm SHA256).Hash"') do set "SETUP_SHA256=%%H"
for /f "delims=" %%H in ('pwsh.exe -NoProfile -Command "(Get-FileHash -LiteralPath $env:OCX_NUPKG -Algorithm SHA256).Hash"') do set "NUPKG_SHA256=%%H"
if not defined SETUP_SHA256 (
  echo [build-installer] Could not calculate the Setup.exe SHA-256.
  goto failed
)
if not defined NUPKG_SHA256 (
  echo [build-installer] Could not calculate the full nupkg SHA-256.
  goto failed
)
for /f "delims=" %%H in ('git rev-parse HEAD 2^>nul') do set "BUILD_COMMIT=%%H"
echo [build-installer] Commit: %BUILD_COMMIT%
echo [build-installer] Setup.exe: %SETUP%
echo [build-installer] Setup SHA-256: %SETUP_SHA256%
echo [build-installer] Full nupkg: %NUPKG%
echo [build-installer] Full nupkg SHA-256: %NUPKG_SHA256%
echo [build-installer] Unsigned installer verified; Windows may show an unknown-publisher warning.
set "CODE=0"
goto finish

:failed
set "CODE=1"
echo [build-installer] Installer build failed; no artifact is being reported as valid.

:finish
popd >nul 2>nul
if not defined SILENT_MODE if "%CODE%"=="1" pause
exit /b %CODE%
