@echo off
rem ---------------------------------------------------------------------------
rem run.bat - build and run opencodex on Windows without reading package.json
rem first. Double-click it, or call it from any terminal.
rem
rem This is a front door, not a second build system. Every step below invokes a
rem script package.json already defines, so a double-click, a terminal and CI run
rem the same commands; anything that cannot be expressed as one of those scripts
rem belongs in package.json rather than here.
rem
rem The decisions that are not obvious from the code:
rem
rem   Directory. The script pins itself to its own folder with pushd on the
rem   script path. Explorer starts a double-clicked batch file with whatever
rem   current directory it feels like, and a terminal user may sit anywhere in
rem   the tree, while every command below assumes the repository root.
rem
rem   Exit codes. Batch carries on after a failed command, so each step stores
rem   its exit code and jumps to :failed on anything but zero. Without that, a
rem   Vite build that died still ends with "starting the proxy" and serves the
rem   previous dashboard - the one lie this file must never tell. The comparison
rem   is against zero rather than "if errorlevel 1", which means "1 or more" and
rem   would wave through the negative exit codes Windows reports for a crash.
rem
rem   Skipped rebuilds. The dashboard build is skipped while gui\dist is newer
rem   than everything it is built from; scripts\gui-dist-fresh.ts answers that
rem   question and its own header explains how. A Vite build on every start is
rem   slow enough that people would go back to running the raw scripts, which is
rem   what this file exists to replace. "run.bat build" and --force never ask.
rem
rem   Prerequisites. Only bun is checked for. Every step runs through it,
rem   including the Vite build and both TypeScript checks, so there is no Node
rem   gate to write. The Bun runtime bundled inside the published npm package is
rem   a different thing that belongs to installed ocx commands; it cannot build a
rem   source checkout.
rem
rem   Pausing. A window opened by double-click closes the instant the script
rem   ends, taking the error message with it. Explorer is the only launcher that
rem   starts cmd.exe with a doubled quote after /c (measured: cmd /c ""C:\...\
rem   run.bat" "), so :maybe_pause looks for exactly that and pauses only then.
rem   A terminal, a CI job and cmd /c invocations never carry it, and setting
rem   OCX_RUN_NO_PAUSE turns the pause off outright.
rem ---------------------------------------------------------------------------

setlocal

pushd "%~dp0"
if errorlevel 1 (
    echo [run.bat] Could not enter the repository folder. Nothing was run.
    exit /b 1
)

set "COMMAND="
set "FORCE="
set "BUN_VERSION="
set "STEP="
set "CODE=0"

rem Flags are accepted on either side of the command, because "run.bat --force
rem build" is what a hand reaches for as often as "run.bat build --force".
:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--force" goto :arg_force
if /i "%~1"=="-f" goto :arg_force
if defined COMMAND goto :arg_surplus
set "COMMAND=%~1"
shift
goto :parse_args

:arg_force
set "FORCE=1"
shift
goto :parse_args

rem Quoted on the way out: an argument is user input, and an unquoted echo of
rem something containing & would run the rest of it as a command.
:arg_surplus
echo [run.bat] Unexpected extra argument: "%~1"
echo.
call :print_help
set "CODE=1"
goto :finish

:args_done
if not defined COMMAND set "COMMAND=run"

if /i "%COMMAND%"=="help" goto :do_help
if /i "%COMMAND%"=="--help" goto :do_help
if /i "%COMMAND%"=="-h" goto :do_help
if /i "%COMMAND%"=="/?" goto :do_help

rem The command is validated before the toolchain is, so a typo gets told it is
rem a typo instead of a lecture about installing bun.
set "VALID="
if /i "%COMMAND%"=="run" set "VALID=1"
if /i "%COMMAND%"=="build" set "VALID=1"
if /i "%COMMAND%"=="dev" set "VALID=1"
if /i "%COMMAND%"=="test" set "VALID=1"
if not defined VALID goto :unknown_command

where bun >nul 2>nul
if errorlevel 1 goto :no_bun
for /f "delims=" %%V in ('bun --version 2^>nul') do set "BUN_VERSION=%%V"
if defined BUN_VERSION echo [run.bat] bun %BUN_VERSION%

if /i "%COMMAND%"=="build" goto :do_build
if /i "%COMMAND%"=="dev" goto :do_dev
if /i "%COMMAND%"=="test" goto :do_test
goto :do_run

rem --------------------------------------------------------------------------
rem run: dependencies, a dashboard build only if one is owed, then the proxy.
rem --------------------------------------------------------------------------
:do_run
call :install_root
if not "%CODE%"=="0" goto :failed
if defined FORCE goto :do_run_build

call bun scripts\gui-dist-fresh.ts
rem Any non-zero answer means rebuild, including the checker crashing. Building
rem something already current wastes a minute; skipping a build that was owed
rem serves yesterday's dashboard and looks like a bug in the source change.
if not "%ERRORLEVEL%"=="0" goto :do_run_build
echo [run.bat] Dashboard is current; skipping the build.
goto :do_run_start

:do_run_build
call :build_gui
if not "%CODE%"=="0" goto :failed

:do_run_start
echo.
echo [run.bat] Starting the proxy. The dashboard is on http://localhost:10100
echo [run.bat] Press Ctrl+C to stop it.
echo.
set "STEP=bun run start"
call bun run start
set "CODE=%ERRORLEVEL%"
rem Not routed through :failed: Ctrl+C is how this command is meant to end, and
rem the exit code it leaves behind is not a build failure to report as one. The
rem code is still propagated, whatever it is.
echo.
echo [run.bat] The proxy exited with code %CODE%.
goto :finish

rem --------------------------------------------------------------------------
rem build: the dashboard, unconditionally.
rem --------------------------------------------------------------------------
:do_build
call :install_root
if not "%CODE%"=="0" goto :failed
call :build_gui
if not "%CODE%"=="0" goto :failed
echo.
echo [run.bat] Dashboard built into gui\dist.
goto :finish

rem --------------------------------------------------------------------------
rem dev: no production build at all - Vite serves the dashboard from source.
rem --------------------------------------------------------------------------
:do_dev
call :install_root
if not "%CODE%"=="0" goto :failed
call :install_gui
if not "%CODE%"=="0" goto :failed

rem Two long-running processes, so the dev server gets its own window. Sharing
rem one console (start /b) interleaves two streams of Vite and proxy output that
rem cannot be told apart afterwards, and leaves no way to stop one of them. The
rem window is /k so a dev server that dies on startup leaves its reason on
rem screen instead of vanishing.
echo.
echo [run.bat] Starting the Vite dev server in a second window...
start "opencodex dashboard (Vite dev server)" cmd /k bun run dev:gui
echo [run.bat] Starting the proxy here. Ctrl+C stops the proxy; close the other
echo [run.bat] window to stop the dev server.
echo.
set "STEP=bun run dev:proxy"
call bun run dev:proxy
set "CODE=%ERRORLEVEL%"
echo.
echo [run.bat] The proxy exited with code %CODE%.
goto :finish

rem --------------------------------------------------------------------------
rem test: cheapest checks first. The proxy suite runs for minutes, so a broken
rem type or a broken dashboard test must not be found on the far side of it.
rem --------------------------------------------------------------------------
:do_test
call :install_root
if not "%CODE%"=="0" goto :failed
call :install_gui
if not "%CODE%"=="0" goto :failed

set "STEP=bun run typecheck"
echo.
echo [run.bat] Typechecking the proxy...
call bun run typecheck
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" goto :failed

rem tsc -b, not tsc --noEmit: gui\tsconfig.json is a solution file with no
rem inputs of its own, so --noEmit there typechecks nothing at all and passes.
set "STEP=bun x tsc -b (gui)"
echo.
echo [run.bat] Typechecking the dashboard...
pushd gui
call bun x tsc -b
set "CODE=%ERRORLEVEL%"
popd
if not "%CODE%"=="0" goto :failed

set "STEP=bun run test (gui)"
echo.
echo [run.bat] Running the dashboard tests...
pushd gui
call bun run test
set "CODE=%ERRORLEVEL%"
popd
if not "%CODE%"=="0" goto :failed

set "STEP=bun run test"
echo.
echo [run.bat] Running the proxy tests. This is the long one...
call bun run test
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" goto :failed

echo.
echo [run.bat] Typechecks and both test suites passed.
goto :finish

rem --------------------------------------------------------------------------
rem Steps. Each one leaves its exit code in CODE and its name in STEP, which is
rem all :failed needs to report honestly which command stopped the run.
rem --------------------------------------------------------------------------
:install_root
set "STEP=bun install"
echo.
echo [run.bat] Installing proxy dependencies...
rem call, not a bare invocation: bun may be an npm-installed bun.cmd shim, and
rem batch hands control to another .cmd permanently unless it is called.
call bun install
set "CODE=%ERRORLEVEL%"
goto :eof

:install_gui
set "STEP=bun install (gui)"
echo.
echo [run.bat] Installing dashboard dependencies...
pushd gui
call bun install
set "CODE=%ERRORLEVEL%"
popd
goto :eof

rem build:gui installs the dashboard's own dependencies with a frozen lockfile
rem and prepares the package afterwards, so it is not paired with :install_gui.
:build_gui
set "STEP=bun run build:gui"
echo.
echo [run.bat] Building the dashboard...
call bun run build:gui
set "CODE=%ERRORLEVEL%"
goto :eof

rem --------------------------------------------------------------------------
rem Endings.
rem --------------------------------------------------------------------------
:no_bun
echo.
echo [run.bat] bun was not found on your PATH.
echo [run.bat] Building opencodex from source needs the Bun CLI:
echo.
echo [run.bat]     npm install -g bun
echo.
echo [run.bat] Then open a new terminal, or double-click this file again, so
echo [run.bat] the updated PATH is picked up.
echo [run.bat] Users who installed ocx from npm never need this: that package
echo [run.bat] carries its own Bun runtime, which cannot build a checkout.
set "CODE=1"
goto :finish

:unknown_command
echo [run.bat] Unknown command: "%COMMAND%"
echo.
call :print_help
set "CODE=1"
goto :finish

:do_help
call :print_help
set "CODE=0"
goto :finish

:print_help
echo opencodex - build and run on Windows
echo.
echo   run.bat            Install dependencies, build the dashboard if it is out
echo                      of date, then start the proxy on http://localhost:10100
echo   run.bat build      Install dependencies and build the dashboard, always
echo   run.bat dev        Skip the production build: start the proxy, and the
echo                      Vite dev server in a second window
echo   run.bat test       Typecheck and run the proxy and dashboard test suites
echo   run.bat help       This text
echo.
echo   --force, -f        Rebuild the dashboard even when it looks up to date
echo.
echo Every step runs a script from package.json. bun must be on your PATH;
echo see the Development section of README.md.
goto :eof

:failed
echo.
echo [run.bat] %STEP% failed with exit code %CODE%. Stopping here.
goto :finish

:maybe_pause
if defined OCX_RUN_NO_PAUSE goto :eof
rem The quotes around the expansion are not decoration: cmdcmdline is an
rem arbitrary command line, and an unquoted echo of one containing & or | would
rem run part of it.
echo "%cmdcmdline%" | findstr /i /c:"/c \"\"" >nul 2>nul
if errorlevel 1 goto :eof
echo.
pause
goto :eof

:finish
popd
call :maybe_pause
exit /b %CODE%
