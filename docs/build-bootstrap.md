# Build bootstrap

The repository root now has one reproducible bootstrap path for a fresh checkout:

```text
download-dependencies.bat /s
build.bat /s
build-installer.bat /s
```

`download-dependencies.bat` is idempotent. It uses the user-scoped Windows package
manager when Bun or Node.js is absent, refreshes the current process `PATH`, verifies
Bun `1.3.14` and Node.js `18+`, then runs `bun install --frozen-lockfile` in both the
root and `gui/` workspaces. It never changes machine-wide `PATH`, installs a signing
credential, or prints a credential.

`build.bat` calls the bootstrap script, runs the proxy typecheck, runs the supported
dashboard/package build, and refuses success unless `gui/dist/index.html` exists. A
normal interactive invocation asks whether to start the proxy after the build. Use
`/s`, `--silent`, or `SILENT=1` for a non-interactive build; `--run` starts it without
asking when not silent.

`build-installer.bat` rebuilds from the same path, removes only the generated
`dist-desktop` directory, invokes the pinned `electron-builder@26.15.3` Squirrel
Windows route with `--publish never`, and validates `Setup.exe`, `RELEASES`, a full
`.nupkg`, SHA-256 values, and an unsigned Authenticode status. It reports the source
commit and artifact paths. The installer is intentionally unsigned, so Windows may
show its unknown-publisher or SmartScreen warning. The script never requests or
invokes signing.

The shell equivalents support the Bun-based source build on Unix-like hosts. The
packaged desktop target is Windows-only; `build-installer.sh` exits with that exact
boundary instead of pretending to create an installer for an unsupported platform.

## Dependency manifest

`build-dependencies.json` is the hand-written inventory consumed by this documentation
and by focused regression tests. It records the pinned Bun version, the Node.js minimum,
the electron-builder version, canonical sources, both workspace lockfile installs, and
the expected development and installer output locations. Package-manager metadata is
verified by the package manager; the scripts independently verify the installed tool
versions and produced artifacts.

## Failure recovery

Every phase stops on its first non-zero command and names the phase and exit code. A
failed dependency install leaves the prior valid install in place. A failed build or
packaging command is never converted into a success by stale output: the installer
script clears the exact generated output directory before packaging and checks each
required artifact afterwards.
