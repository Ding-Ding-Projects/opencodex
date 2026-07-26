# 021 — WP2 literal patch appendix: immutable pre-bridge runtime rebake

This appendix is the literal implementation contract for `020_update_transition.md`.
It covers immutable pre-bridge owner rebake, executable old-process transition proof,
future-run update hardening, and first-fresh-launch shim convergence. Apply the hunks
in order after `011_wp1_literal_patch.md`. The cached old shim is safe because the
bridge release retains package-local Bun; the first later invocation through the new
Node launcher asks the packaged Go executable to refresh the owned wrapper without
discovering Codex on `PATH`.

## 1. NEW `src/lib/runtime-entry.ts` — complete content

```diff
diff --git a/src/lib/runtime-entry.ts b/src/lib/runtime-entry.ts
new file mode 100644
--- /dev/null
+++ b/src/lib/runtime-entry.ts
@@ -0,0 +1,35 @@
+import { execFileSync } from "node:child_process";
+import { lstatSync, readFileSync } from "node:fs";
+import { join } from "node:path";
+
+export interface DurableRuntimeEntry { runtime: string; cli: string }
+
+function nodeExecutable(): string {
+  return execFileSync(process.platform === "win32" ? "where.exe" : "which", ["node"], {
+    encoding: "utf8", windowsHide: true, env: process.env,
+  }).split(/\r?\n/, 1)[0]!.trim();
+}
+
+export function packagedNativeBinary(root: string, platform = process.platform, arch = process.arch): string | null {
+  const os = ({ darwin: "darwin", linux: "linux", win32: "windows" } as Partial<Record<NodeJS.Platform, string>>)[platform];
+  const goarch = ({ x64: "amd64", arm64: "arm64" } as Partial<Record<string, string>>)[arch];
+  if (!os || !goarch) return null;
+  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
+  if (!version) return null;
+  const path = join(root, "bin", "native", `ocx_${version}_${os}_${goarch}${os === "windows" ? ".exe" : ""}`);
+  try {
+    const stat = lstatSync(path);
+    if (!stat.isFile() || stat.isSymbolicLink()) return null;
+    if (platform !== "win32" && (stat.mode & 0o111) === 0) return null;
+    return path;
+  } catch { return null; }
+}
+
+export function preferredDurableRuntime(
+  root: string,
+  fallback: DurableRuntimeEntry,
+): DurableRuntimeEntry {
+  return packagedNativeBinary(root)
+    ? { runtime: nodeExecutable(), cli: join(root, "bin", "ocx.mjs") }
+    : fallback;
+}
```

The helper deliberately returns the Node launcher rather than the native executable.
That keeps the persisted entry stable across package replacement while the launcher
selects the version-matched native artifact on every start.

## 2. Durable TypeScript entry owners

### `src/service.ts`

```diff
diff --git a/src/service.ts b/src/service.ts
--- a/src/service.ts
+++ b/src/service.ts
@@ -11,5 +11,6 @@ import { stripGrokConfig } from "./grok/inject";
 import { isWslRuntime } from "./codex/home";
 import { durableBunPath, durableBunRuntime } from "./lib/bun-runtime";
+import { preferredDurableRuntime } from "./lib/runtime-entry";
 import { isProcessAlive, stopProxy } from "./lib/process-control";
 import { serviceApiTokenFilePath } from "./lib/service-secrets";
 import { defaultWinswEntry, installWinswService, startWinswService, stopWinswService, statusWinswRaw, uninstallWinswService, winswStatusSummary, WINSW_SERVICE_ID, WINSW_SHA256, WINSW_VERSION } from "./lib/winsw";
@@ -27,6 +28,13 @@ export type ServiceBackend = "scheduler" | "native";
 function cliEntry(): { bun: string; cli: string } {
   // Bake the bundled Bun (npm global prefix, survives `ocx update`) rather than
   // a transient system Bun, so launchd/systemd/schtasks keep resolving even if a
-  // standalone Bun is later removed. The CLI entry lives at src/cli/index.ts.
-  return { bun: durableBunPath(), cli: join(import.meta.dir, "cli", "index.ts") };
+  // standalone Bun is later removed. Prefer the immutable Node launcher once a
+  // version-matched packaged native artifact exists.
+  return serviceRuntimeEntry();
+}
+
+export function serviceRuntimeEntry(packageRoot = join(import.meta.dir, "..")): { bun: string; cli: string } {
+  const fallback = { runtime: durableBunPath(), cli: join(import.meta.dir, "cli", "index.ts") };
+  const entry = preferredDurableRuntime(packageRoot, fallback);
+  return { bun: entry.runtime, cli: entry.cli };
 }
```

The exported pure owner is the same path used by `cliEntry`; it exists so the
immutable-pre-bridge fixture can execute the newly installed owner without invoking a
real host service manager.

```diff
diff --git a/src/service.ts b/src/service.ts
--- a/src/service.ts
+++ b/src/service.ts
@@ -250,8 +250,8 @@ function writeServiceApiTokenFile(): string | null {
   return path;
 }
 
-export function buildPlist(): string {
-  const { bun, cli } = cliEntry();
+export function buildPlist(entry = cliEntry()): string {
+  const { bun, cli } = entry;
   const log = logPath();
   const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
   const codexHome = process.env.CODEX_HOME?.trim();
@@ -743,8 +743,8 @@ function unitPath(): string {
   return join(unitDir(), `${TASK}.service`);
 }
 
-export function buildUnit(): string {
-  const { bun, cli } = cliEntry();
+export function buildUnit(entry = cliEntry()): string {
+  const { bun, cli } = entry;
   const log = logPath();
   const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
   const codexHome = systemdEnvironmentAssignment("CODEX_HOME", process.env.CODEX_HOME?.trim());
```

### `src/tray/windows.ts`

```diff
diff --git a/src/tray/windows.ts b/src/tray/windows.ts
--- a/src/tray/windows.ts
+++ b/src/tray/windows.ts
@@ -5,6 +5,7 @@ import { homedir } from "node:os";
 import { join, resolve } from "node:path";
 import { expandUserPath, getConfigDir } from "../config";
 import { durableBunPath } from "../lib/bun-runtime";
+import { preferredDurableRuntime } from "../lib/runtime-entry";
 import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
 
 const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
@@ -80,9 +81,15 @@ function currentCodexHome(): string {
 }
 
 function currentEntry(): WindowsTrayEntry {
+  return windowsTrayRuntimeEntry();
+}
+
+export function windowsTrayRuntimeEntry(packageRoot = join(import.meta.dir, "..", "..")): WindowsTrayEntry {
+  const fallback = { runtime: durableBunPath(), cli: join(import.meta.dir, "..", "cli", "index.ts") };
+  const entry = preferredDurableRuntime(packageRoot, fallback);
   return {
-    bun: durableBunPath(),
-    cli: join(import.meta.dir, "..", "cli", "index.ts"),
+    bun: entry.runtime,
+    cli: entry.cli,
     script: installedTrayScriptPath(),
     codexHome: currentCodexHome(),
     opencodexHome: getConfigDir(),
```

### `src/codex/shim.ts`

```diff
diff --git a/src/codex/shim.ts b/src/codex/shim.ts
--- a/src/codex/shim.ts
+++ b/src/codex/shim.ts
@@ -20,6 +20,7 @@ import {
 import { getConfigDir } from "../config";
 import { durableBunPath } from "../lib/bun-runtime";
 import { isProcessAlive } from "../lib/process-control";
+import { preferredDurableRuntime } from "../lib/runtime-entry";
 import { serviceApiTokenFilePath } from "../lib/service-secrets";
 import { windowsEnvIndirectBatchValue } from "../lib/win-paths";
 import { isWslRuntime, wslAutomountRoot } from "./home";
@@ -118,8 +119,9 @@ export type CodexShimAutoRestoreResult =
   | { status: "restored"; message: string };
 
 function cliEntry(): { bun: string; cli: string } {
-  // Bundled Bun path (survives `ocx update`); all three shim builders
-  // (Unix / Windows cmd / Windows PowerShell) receive it via this entry.
-  // This module lives in src/codex/, the CLI entry in src/cli/index.ts.
-  return { bun: durableBunPath(), cli: join(import.meta.dir, "..", "cli", "index.ts") };
+  // A pre-bridge process may have cached this module, so Bun remains the safe
+  // fallback. Freshly loaded owners persist the immutable Node launcher.
+  const fallback = { runtime: durableBunPath(), cli: join(import.meta.dir, "..", "cli", "index.ts") };
+  const entry = preferredDurableRuntime(join(import.meta.dir, "..", ".."), fallback);
+  return { bun: entry.runtime, cli: entry.cli };
 }
```

The legacy `bun` field names remain unchanged in service/tray state and builders for
serialization compatibility. Their values become absolute Node paths only when the
exact package-version native artifact is present.

## 3. Fresh launcher shim convergence — `bin/ocx.mjs`

```diff
diff --git a/bin/ocx.mjs b/bin/ocx.mjs
--- a/bin/ocx.mjs
+++ b/bin/ocx.mjs
@@ -16,5 +16,8 @@ import { launchForwardingChild, resolveNativeGoBinary } from "./native-runtime.mjs";
 
 const PKG = "@bitkyc08/opencodex";
+const CODEX_SHIM_MARKER = "opencodex codex autostart shim";
+const CODEX_SHIM_MAX_BYTES = 1024 * 1024;
+const NATIVE_SHIM_REFRESH_GUARD = "OCX_NATIVE_SHIM_REFRESH";
 const require = createRequire(import.meta.url);
 const here = dirname(fileURLToPath(import.meta.url));
 const cliPath = join(here, "..", "src", "cli", "index.ts");
@@ -75,6 +78,40 @@ function configDir() {
   return resolve(raw ? expandUserPath(raw) : join(homedir(), ".opencodex"));
 }
 
+function legacyCodexShimNeedsRefresh() {
+  if (process.env[NATIVE_SHIM_REFRESH_GUARD] === "1") return false;
+  try {
+    const statePath = join(configDir(), "codex-shim.json");
+    const stateInfo = statSync(statePath);
+    if (!stateInfo.isFile() || stateInfo.size > CODEX_SHIM_MAX_BYTES) return false;
+    const state = JSON.parse(readFileSync(statePath, "utf8"));
+    if (typeof state?.wrapperPath !== "string" || typeof state?.backupPath !== "string") return false;
+    const wrapperInfo = statSync(state.wrapperPath);
+    if (!wrapperInfo.isFile() || wrapperInfo.size > CODEX_SHIM_MAX_BYTES) return false;
+    const wrapper = readFileSync(state.wrapperPath, "utf8");
+    return wrapper.includes(CODEX_SHIM_MARKER)
+      && /[\\/]src[\\/]cli[\\/]index\.ts(?:["']|\s)/.test(wrapper);
+  } catch {
+    return false;
+  }
+}
+
+function refreshLegacyCodexShim(goBinary) {
+  if (!legacyCodexShimNeedsRefresh()) return;
+  const env = { ...process.env, [NATIVE_SHIM_REFRESH_GUARD]: "1" };
+  const result = spawnSync(goBinary, ["codex-shim", "refresh"], {
+    stdio: "inherit",
+    windowsHide: true,
+    env,
+  });
+  if (result.status !== 0) {
+    console.warn(
+      `opencodex: Codex shim runtime refresh failed (${result.status ?? "unknown exit"}); ` +
+      "continuing with the retained Bun bridge. Try: ocx codex-shim refresh",
+    );
+  }
+}
+
 function shouldRepairCodexShim() {
   return existsSync(join(configDir(), "codex-shim.json"));
 }
@@ -90,10 +127,12 @@ function repairCodexShimIfNeeded() {
   if (!shouldRepairCodexShim()) return;
   const launcher = fileURLToPath(import.meta.url);
-  const res = spawnSync(process.execPath, [launcher, "codex-shim", "install"], {
+  // Loading the freshly installed launcher performs the guarded, owner-only
+  // Go refresh above. --version never enters PATH discovery or installation.
+  const res = spawnSync(process.execPath, [launcher, "--version"], {
     stdio: "inherit",
     windowsHide: true,
   });
   if (res.status !== 0) {
-    console.warn(`opencodex: Codex shim repair failed (${res.status ?? "unknown exit"}). Try: ocx codex-shim install`);
+    console.warn(`opencodex: Codex shim runtime refresh failed (${res.status ?? "unknown exit"}). Try: ocx codex-shim refresh`);
   }
 }
@@ -353,5 +392,6 @@ function resolveBun() {
 
 const goBinary = resolveGoBinary();
 if (goBinary) {
+  refreshLegacyCodexShim(goBinary);
   launchForwardingChild(goBinary, process.argv.slice(2), "Go runtime");
 } else {
```

Neither the first fresh-launcher invocation nor the legacy npm updater's post-install
probe invokes `codex-shim install`. The updater reloads the replaced launcher with
`--version`; launcher startup performs the same guarded owner-only refresh before the
side-effect-free version command reaches Go. Neither path searches `PATH` or renames a
Codex executable. The guard prevents recursion, and a non-zero refresh result is only a
warning because the retained Bun wrapper remains runnable.

## 4. Go-owned wrapper refresh

### `go/internal/codex/shim.go`

```diff
diff --git a/go/internal/codex/shim.go b/go/internal/codex/shim.go
--- a/go/internal/codex/shim.go
+++ b/go/internal/codex/shim.go
@@ -207,6 +207,58 @@ func InstallCodexShim(options ShimInstallOptions) (ShimState, error) {
 	return state, nil
 }
 
+// RefreshCodexShimRuntime rewrites an existing OpenCodex-owned wrapper to call
+// openCodexPath. It never discovers Codex on PATH, moves the backup, or changes
+// shim state; the retained backup remains the real Codex executable.
+func RefreshCodexShimRuntime(statePath, openCodexPath, tokenFile, goos string) (bool, error) {
+	if strings.TrimSpace(openCodexPath) == "" {
+		return false, errors.New("opencodex executable path is required")
+	}
+	state, err := readShimState(statePath)
+	if err != nil {
+		if os.IsNotExist(err) {
+			return false, nil
+		}
+		return false, err
+	}
+	wrapperInfo, err := os.Lstat(state.WrapperPath)
+	if err != nil || !wrapperInfo.Mode().IsRegular() || !isShimFile(state.WrapperPath) {
+		return false, errors.New("wrapper path is no longer an owned OpenCodex shim")
+	}
+	backupInfo, err := os.Lstat(state.BackupPath)
+	if err != nil {
+		return false, fmt.Errorf("inspect Codex backup: %w", err)
+	}
+	if !backupInfo.Mode().IsRegular() {
+		return false, errors.New("Codex backup is not a regular file")
+	}
+	if goos == "" {
+		goos = state.Platform
+	}
+	if goos == "" {
+		goos = runtime.GOOS
+	}
+	if goos == "win32" {
+		goos = "windows"
+	}
+	extension := strings.ToLower(filepath.Ext(state.WrapperPath))
+	var script string
+	switch {
+	case goos != "windows" || extension == "":
+		script = BuildUnixShimWithToken(state.BackupPath, openCodexPath, tokenFile)
+	case extension == ".ps1":
+		script = "\ufeff" + BuildPowerShellShim(state.BackupPath, openCodexPath)
+	case extension == ".cmd" || extension == ".bat":
+		script = BuildWindowsShim(state.BackupPath, openCodexPath)
+	default:
+		return false, fmt.Errorf("unsupported owned shim extension %q", extension)
+	}
+	if err := atomicWriteFile(state.WrapperPath, []byte(script), 0o755); err != nil {
+		return false, err
+	}
+	return true, nil
+}
+
 func UninstallCodexShim(statePath string) (bool, error) {
 	state, err := readShimState(statePath)
 	if err != nil {
```

### `go/internal/cli/lifecycle_extended.go`

```diff
diff --git a/go/internal/cli/lifecycle_extended.go b/go/internal/cli/lifecycle_extended.go
--- a/go/internal/cli/lifecycle_extended.go
+++ b/go/internal/cli/lifecycle_extended.go
@@ -74,7 +74,7 @@ func shimStatePath() (string, error) {
 
 func runCodexShim(args []string, streams IO) error {
 	if len(args) != 1 {
-		return fmt.Errorf("usage: ocx codex-shim <install|status|uninstall|remove>")
+		return fmt.Errorf("usage: ocx codex-shim <install|refresh|status|uninstall|remove>")
 	}
 	statePath, err := shimStatePath()
 	if err != nil {
@@ -96,6 +96,29 @@ func runCodexShim(args []string, streams IO) error {
 			fmt.Fprintln(streams.Out, "Codex autostart shim is not installed.")
 		}
 		return nil
+	case "refresh":
+		executable, err := os.Executable()
+		if err != nil {
+			return err
+		}
+		dir, err := configDir()
+		if err != nil {
+			return err
+		}
+		tokenPath := filepath.Join(dir, "service-api-token")
+		if info, err := os.Lstat(tokenPath); err != nil || !info.Mode().IsRegular() {
+			tokenPath = ""
+		}
+		refreshed, err := codex.RefreshCodexShimRuntime(statePath, executable, tokenPath, runtime.GOOS)
+		if err != nil {
+			return err
+		}
+		if refreshed {
+			fmt.Fprintln(streams.Out, "Codex autostart shim runtime refreshed.")
+		} else {
+			fmt.Fprintln(streams.Out, "Codex autostart shim is not installed.")
+		}
+		return nil
 	case "install":
 		realCodex, err := codex.FindCodexOnPath(os.Getenv("PATH"), runtime.GOOS)
 		if err != nil {
@@ -117,6 +140,6 @@ func runCodexShim(args []string, streams IO) error {
 		fmt.Fprintf(streams.Out, "Codex autostart shim installed at %s.\n", state.WrapperPath)
 		return nil
 	default:
-		return fmt.Errorf("usage: ocx codex-shim <install|status|uninstall|remove>")
+		return fmt.Errorf("usage: ocx codex-shim <install|refresh|status|uninstall|remove>")
 	}
 }
```

## 5. Future-run hardening for update owners

These hunks are **not first-transition proof**. The first-transition receipt is the
immutable old-process fixture in section 6: it retains the old updater's
`process.execPath + replaced src/cli/index.ts` calls and proves that those calls load
the newly installed service/tray owners. The following changes only make updater code
from the bridge release and later invoke the fresh Node launcher directly on future
runs.

### `src/update/index.ts` — future-run hardening only

```diff
diff --git a/src/update/index.ts b/src/update/index.ts
--- a/src/update/index.ts
+++ b/src/update/index.ts
@@ -20,5 +20,13 @@ export const PKG = "@bitkyc08/opencodex";
 const HERE = dirname(fileURLToPath(import.meta.url)); // .../opencodex/src/update
 
+function nodeBin(): string {
+  return process.platform === "win32" ? "node.exe" : "node";
+}
+
+function packageLauncherPath(): string {
+  return join(HERE, "..", "..", "bin", "ocx.mjs");
+}
+
 export type Installer = "bun" | "npm" | "source";
 export type Channel = "latest" | "preview";
 
@@ -254,23 +262,20 @@ export async function runUpdate(): Promise<void> {
   if (r.status === 0) {
     console.log(`\n✅ Updated${latest ? ` to v${latest}` : ""}.`);
-    // Re-bake the bundled Bun path into the Codex autostart shim on every
-    // platform when one is installed (refresh-only; never installs fresh).
-    try {
-      const { isCodexShimInstalled, installCodexShim } = await import("../codex/shim");
-      if (isCodexShimInstalled()) {
-        const result = installCodexShim();
-        if (result.installed) console.log(`🔧 ${result.message}`);
-      }
-    } catch (e) {
-      console.warn(`⚠️  Shim repair skipped: ${e instanceof Error ? e.message : e}`);
+    const postInstallLauncher = packageLauncherPath();
+    const shim = spawnSync(nodeBin(), [postInstallLauncher, "codex-shim", "refresh"], {
+      stdio: "inherit",
+      windowsHide: true,
+    });
+    if (shim.status !== 0) {
+      console.warn("⚠️  Shim repair skipped; retained Bun remains valid until the next fresh ocx invocation.");
     }
     if (trayWasInstalled) {
-      const trayArgs = [process.argv[1], ...planWindowsTrayUpdate({ installed: trayWasInstalled, running: trayWasRunning }).installArgs];
-      const tray = spawnSync(process.execPath, trayArgs, { stdio: "inherit", windowsHide: true });
+      const trayArgs = [postInstallLauncher, ...planWindowsTrayUpdate({ installed: trayWasInstalled, running: trayWasRunning }).installArgs];
+      const tray = spawnSync(nodeBin(), trayArgs, { stdio: "inherit", windowsHide: true });
       if (tray.status === 0) {
         console.log("🔧 Refreshed Windows tray startup paths.");
       } else {
         console.warn("⚠️  Windows tray refresh failed. Run 'ocx tray install'.");
-        if (trayWasRunning) spawnSync(process.execPath, [process.argv[1], "tray", "start"], { stdio: "ignore", windowsHide: true });
+        if (trayWasRunning) spawnSync(nodeBin(), [postInstallLauncher, "tray", "start"], { stdio: "ignore", windowsHide: true });
       }
     }
@@ -297,6 +305,6 @@ export async function runUpdate(): Promise<void> {
       try {
         const svcStdio = updateChildStdio();
-        const svc = spawnSync(process.execPath, [process.argv[1], ...serviceReinstallArgs()], {
+        const svc = spawnSync(nodeBin(), [postInstallLauncher, ...serviceReinstallArgs()], {
           stdio: svcStdio,
           encoding: svcStdio === "pipe" ? "utf8" : undefined,
           windowsHide: true,
@@ -316,7 +324,7 @@ export async function runUpdate(): Promise<void> {
             console.warn("   Run 'ocx service install' as administrator to refresh the background service.");
             const env = { ...process.env };
             delete env.OCX_SERVICE;
-            const child = spawn(process.execPath, [process.argv[1], "start", "--port", String(capturedListen.port)], {
+            const child = spawn(nodeBin(), [postInstallLauncher, "start", "--port", String(capturedListen.port)], {
               detached: true,
               stdio: "ignore",
               windowsHide: true,
```

The pre-replacement stop remains `process.execPath + process.argv[1]`; only commands
after successful package replacement switch to the new package launcher.

### `src/update/job.ts` — future-run hardening only

```diff
diff --git a/src/update/job.ts b/src/update/job.ts
--- a/src/update/job.ts
+++ b/src/update/job.ts
@@ -176,12 +176,10 @@ export function restartCommand(
   const svcArgs = serviceInstalled ? [launcher, ...(serviceArgs ?? ["service", "install"])] : startArgs;
-  if (installer === "npm") {
+  if (installer === "npm" || installer === "bun") {
     const bin = nodeBin();
     const args = svcArgs;
     return { mode, bin, args, display: formatCommand(bin, args) };
   }
-  // bun/source installs: restart via the current runtime executable + package launcher (both real
-  // .exe files), NOT the `ocx.cmd` shim. Spawning a `.cmd` shell-less throws EINVAL on Windows
-  // Node/Bun ≥18.20/20.12 (CVE-2024-27980 hardening) — the same class the npm path (nodeBin) avoids.
+  // Source checkouts have no package-native boundary and keep their source runtime.
   const bin = process.execPath;
   const args = svcArgs;
   return { mode, bin, args, display: formatCommand(bin, args) };
@@ -579,9 +577,10 @@ export async function runGuiUpdateWorker(
 
     if (trayWasInstalled) {
-      const trayArgs = [process.argv[1], ...planWindowsTrayUpdate({ installed: trayWasInstalled, running: trayWasRunning }).installArgs];
-      const tray = runLoggedCommand(job, process.execPath, trayArgs, 20_000);
+      const launcher = packageLauncherPath();
+      const trayArgs = [launcher, ...planWindowsTrayUpdate({ installed: trayWasInstalled, running: trayWasRunning }).installArgs];
+      const tray = runLoggedCommand(job, nodeBin(), trayArgs, 20_000);
       if (tray.status !== 0) {
         updateJob(job, {}, "Windows tray refresh failed; run 'ocx tray install'.");
-        if (trayWasRunning) runLoggedCommand(job, process.execPath, [process.argv[1], "tray", "start"], 15_000);
+        if (trayWasRunning) runLoggedCommand(job, nodeBin(), [launcher, "tray", "start"], 15_000);
       }
     }
```

## 6. Immutable old-process first-transition proof

This is the H3 receipt. The fixture captures the old updater's runtime and argv before
replacement, replaces the package-local CLI/native files, and then executes those
unchanged calls. The replacement CLI is a thin test probe only; it imports and executes
the actual newly installed `serviceRuntimeEntry`/`windowsTrayRuntimeEntry` owners and
their real builders. No host service manager, registry, launchd, or systemd state is
mutated.

### NEW `tests/prebridge-runtime-rebake.test.ts` — complete content

```diff
diff --git a/tests/prebridge-runtime-rebake.test.ts b/tests/prebridge-runtime-rebake.test.ts
new file mode 100644
--- /dev/null
+++ b/tests/prebridge-runtime-rebake.test.ts
@@ -0,0 +1,123 @@
+import { describe, expect, test } from "bun:test";
+import { execFileSync, spawnSync } from "node:child_process";
+import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
+import { pathToFileURL } from "node:url";
+
+type Receipt = {
+  argv: string[];
+  entry: { bun: string; cli: string };
+  native: string;
+  persisted: string[];
+};
+
+function nativeTarget(version: string): { name: string; os: string; arch: string } {
+  const os = process.platform === "win32" ? "windows" : process.platform;
+  const arch = process.arch === "x64" ? "amd64" : "arm64";
+  return { name: `ocx_${version}_${os}_${arch}${os === "windows" ? ".exe" : ""}`, os, arch };
+}
+
+describe("immutable pre-bridge updater runtime rebake", () => {
+  test.skipIf(!["darwin", "linux", "win32"].includes(process.platform) || !["x64", "arm64"].includes(process.arch))(
+    "old process.execPath plus replaced src CLI calls execute new service/tray owners and persist Node launcher to Go",
+    () => {
+      const root = mkdtempSync(join(tmpdir(), "ocx-prebridge-rebake-"));
+      try {
+        const packageRoot = join(root, "package");
+        const cli = join(packageRoot, "src", "cli", "index.ts");
+        const nativeDir = join(packageRoot, "bin", "native");
+        const launcher = join(packageRoot, "bin", "ocx.mjs");
+        const receipts = join(root, "receipts");
+        mkdirSync(join(packageRoot, "src", "cli"), { recursive: true });
+        mkdirSync(nativeDir, { recursive: true });
+        mkdirSync(receipts, { recursive: true });
+
+        // Immutable pre-bridge capture: these values are fixed before replacement.
+        writeFileSync(cli, "throw new Error('old package CLI must be replaced before invocation');\n");
+        const oldRuntime = process.execPath;
+        const oldServiceCall = [cli, "service", "install"];
+        const oldTrayCall = [cli, "tray", "install", "--no-start"];
+
+        // Replacement changes package files only; captured runtime/argv stay byte-for-byte old.
+        const version = "9.8.7";
+        const target = nativeTarget(version);
+        const native = join(nativeDir, target.name);
+        writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ type: "module", version }));
+        writeFileSync(launcher, "#!/usr/bin/env node\n", { mode: 0o755 });
+        writeFileSync(native, "native", { mode: 0o755 });
+        chmodSync(launcher, 0o755);
+        chmodSync(native, 0o755);
+
+        const serviceURL = pathToFileURL(join(import.meta.dir, "..", "src", "service.ts")).href;
+        const trayURL = pathToFileURL(join(import.meta.dir, "..", "src", "tray", "windows.ts")).href;
+        const nativeRuntimeURL = pathToFileURL(join(import.meta.dir, "..", "bin", "native-runtime.mjs")).href;
+        writeFileSync(cli, `
+import { writeFileSync } from "node:fs";
+import { join } from "node:path";
+const root = process.env.OCX_FIXTURE_PACKAGE_ROOT;
+const receiptDir = process.env.OCX_FIXTURE_RECEIPTS;
+const command = process.argv[2];
+const { resolveNativeGoBinary } = await import(${JSON.stringify(nativeRuntimeURL)});
+const version = JSON.parse(await Bun.file(join(root, "package.json")).text()).version;
+const native = resolveNativeGoBinary({ here: join(root, "bin"), version });
+if (command === "service") {
+  const { buildPlist, buildUnit, buildWindowsServiceScript, serviceRuntimeEntry } = await import(${JSON.stringify(serviceURL)});
+  const entry = serviceRuntimeEntry(root);
+  writeFileSync(join(receiptDir, "service.json"), JSON.stringify({
+    argv: process.argv.slice(1), entry, native,
+    persisted: [buildPlist(entry), buildUnit(entry), buildWindowsServiceScript(entry)],
+  }));
+} else if (command === "tray") {
+  const { buildWindowsTrayRunCommand, windowsTrayRuntimeEntry } = await import(${JSON.stringify(trayURL)});
+  const entry = windowsTrayRuntimeEntry(root);
+  writeFileSync(join(receiptDir, "tray.json"), JSON.stringify({
+    argv: process.argv.slice(1), entry, native,
+    persisted: [buildWindowsTrayRunCommand(entry, "C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe")],
+  }));
+} else {
+  throw new Error("unexpected fixture command: " + command);
+}
+`);
+
+        const opencodexHome = join(root, "opencodex-home");
+        const codexHome = join(root, "codex-home");
+        mkdirSync(opencodexHome, { recursive: true });
+        mkdirSync(codexHome, { recursive: true });
+        const env = {
+          ...process.env,
+          OPENCODEX_HOME: opencodexHome,
+          CODEX_HOME: codexHome,
+          OCX_FIXTURE_PACKAGE_ROOT: packageRoot,
+          OCX_FIXTURE_RECEIPTS: receipts,
+        };
+        const service = spawnSync(oldRuntime, oldServiceCall, { env, encoding: "utf8" });
+        const tray = spawnSync(oldRuntime, oldTrayCall, { env, encoding: "utf8" });
+        expect({ status: service.status, stderr: service.stderr }).toEqual({ status: 0, stderr: "" });
+        expect({ status: tray.status, stderr: tray.stderr }).toEqual({ status: 0, stderr: "" });
+
+        const serviceReceipt = JSON.parse(readFileSync(join(receipts, "service.json"), "utf8")) as Receipt;
+        const trayReceipt = JSON.parse(readFileSync(join(receipts, "tray.json"), "utf8")) as Receipt;
+        const expectedNode = execFileSync(process.platform === "win32" ? "where.exe" : "which", ["node"], {
+          encoding: "utf8", windowsHide: true, env,
+        }).split(/\r?\n/, 1)[0]!.trim();
+
+        expect(serviceReceipt.argv[0]).toBe(realpathSync(oldServiceCall[0]));
+        expect(serviceReceipt.argv.slice(1)).toEqual(oldServiceCall.slice(1));
+        expect(trayReceipt.argv[0]).toBe(realpathSync(oldTrayCall[0]));
+        expect(trayReceipt.argv.slice(1)).toEqual(oldTrayCall.slice(1));
+        for (const receipt of [serviceReceipt, trayReceipt]) {
+          expect(receipt.entry).toMatchObject({ bun: expectedNode, cli: launcher });
+          expect(receipt.native).toBe(native);
+          for (const persisted of receipt.persisted) {
+            expect(persisted).toContain(expectedNode);
+            expect(persisted).toContain(launcher);
+            expect(persisted).not.toContain("src/cli/index.ts");
+          }
+        }
+      } finally {
+        rmSync(root, { recursive: true, force: true });
+      }
+    },
+  );
+});
```

The service receipt covers launchd plist, systemd unit, and Windows service script;
the tray receipt covers the persisted HKCU Run command. The native resolver receipt
closes the second edge of the chain: persisted absolute Node → package launcher → exact
version-matched Go binary.

## 7. Future-run hardening tests

### `tests/update-job.test.ts`

```diff
diff --git a/tests/update-job.test.ts b/tests/update-job.test.ts
--- a/tests/update-job.test.ts
+++ b/tests/update-job.test.ts
@@ -1,5 +1,5 @@
 import { afterEach, beforeEach, describe, expect, test } from "bun:test";
-import { mkdirSync, rmSync, writeFileSync } from "node:fs";
+import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
 import {
@@ -101,5 +101,25 @@ describe("GUI update execution decisions", () => {
     });
   });
 
+  test("future npm/Bun service and proxy restarts use the fresh Node package launcher", () => {
+    for (const installer of ["npm", "bun"] as const) {
+      const service = restartCommand(true, installer, "/pkg/bin/ocx.mjs", 10100, ["service", "install", "--native"]);
+      expect(service.bin).toMatch(/^node(?:\.exe)?$/);
+      expect(service.args).toEqual(["/pkg/bin/ocx.mjs", "service", "install", "--native"]);
+      const proxy = restartCommand(false, installer, "/pkg/bin/ocx.mjs", 10100);
+      expect(proxy.bin).toMatch(/^node(?:\.exe)?$/);
+      expect(proxy.args).toEqual(["/pkg/bin/ocx.mjs", "start", "--port", "10100"]);
+    }
+    expect(restartCommand(false, "source", "/checkout/bin/ocx.mjs").bin).toBe(process.execPath);
+  });
+
+  test("future GUI tray repair and failure restoration use Node plus the package launcher", () => {
+    const source = readFileSync(join(import.meta.dir, "..", "src", "update", "job.ts"), "utf8");
+    expect(source).toContain("const launcher = packageLauncherPath()");
+    expect(source).toContain("runLoggedCommand(job, nodeBin(), trayArgs, 20_000)");
+    expect(source).toContain('runLoggedCommand(job, nodeBin(), [launcher, "tray", "start"], 15_000)');
+    expect(source).not.toContain("runLoggedCommand(job, process.execPath, trayArgs, 20_000)");
+  });
+
   test("proxy restart pins --port so post-update start does not hop to an ephemeral port", () => {
     const proxy = restartCommand(false, "npm", "/pkg/bin/ocx.mjs", 10100);
```

### `tests/update-stop-first.test.ts`

```diff
diff --git a/tests/update-stop-first.test.ts b/tests/update-stop-first.test.ts
--- a/tests/update-stop-first.test.ts
+++ b/tests/update-stop-first.test.ts
@@ -23,5 +23,19 @@ describe("update stops the running proxy before replacing files", () => {
     expect(abortAt).toBeLessThan(stopAt);
   });
 
+  test("future direct updater keeps old stop argv but uses fresh launcher for every post-replacement repair", () => {
+    expect(updateSource.match(/process\.argv\[1\]/g)).toHaveLength(1);
+    expect(updateSource).toContain('spawnSync(process.execPath, [process.argv[1], "stop"]');
+    expect(updateSource).toContain('spawnSync(nodeBin(), [postInstallLauncher, "codex-shim", "refresh"]');
+    expect(updateSource).toContain("spawnSync(nodeBin(), trayArgs");
+    expect(updateSource).toContain('spawnSync(nodeBin(), [postInstallLauncher, "tray", "start"]');
+    expect(updateSource).toContain('spawnSync(nodeBin(), [postInstallLauncher, ...serviceReinstallArgs()]');
+    expect(updateSource).toContain('spawn(nodeBin(), [postInstallLauncher, "start", "--port"');
+    const installAt = updateSource.indexOf("const r = spawnSync(target.bin, cmdArgs");
+    for (const marker of ["postInstallLauncher", '"codex-shim", "refresh"', "trayArgs", "serviceReinstallArgs()", '"start", "--port"']) {
+      expect(updateSource.lastIndexOf(marker)).toBeGreaterThan(installAt);
+    }
+  });
+
   test("npm launcher update path stops via its own launcher path before npm install", () => {
     expect(launcherSource).toContain('spawnSync(process.execPath, [launcher, "stop"]');
```

### `tests/update-tray-handoff.test.ts`

```diff
diff --git a/tests/update-tray-handoff.test.ts b/tests/update-tray-handoff.test.ts
--- a/tests/update-tray-handoff.test.ts
+++ b/tests/update-tray-handoff.test.ts
@@ -62,4 +62,17 @@ describe("Windows tray update handoff contract", () => {
       expect(source).toContain("installArgs");
     }
   });
+
+  test("all post-replacement tray lanes route through a fresh launcher and retain failure restoration", () => {
+    const root = join(import.meta.dir, "..");
+    const direct = readFileSync(join(root, "src", "update", "index.ts"), "utf8");
+    const worker = readFileSync(join(root, "src", "update", "job.ts"), "utf8");
+    const launcher = readFileSync(join(root, "bin", "ocx.mjs"), "utf8");
+    expect(direct).toContain("spawnSync(nodeBin(), trayArgs");
+    expect(direct).toContain('[postInstallLauncher, "tray", "start"]');
+    expect(worker).toContain("runLoggedCommand(job, nodeBin(), trayArgs");
+    expect(worker).toContain('[launcher, "tray", "start"]');
+    expect(launcher).toContain("trayBeforeUpdate.restoreOnFailure");
+    expect(launcher).toContain("runTrayLifecycle(launcher, \"start\")");
+  });
 });
```

## 8. Exact named owner/shim test hunks

### `tests/bun-runtime.test.ts`

```diff
diff --git a/tests/bun-runtime.test.ts b/tests/bun-runtime.test.ts
--- a/tests/bun-runtime.test.ts
+++ b/tests/bun-runtime.test.ts
@@ -1,8 +1,10 @@
-import { describe, it, expect, afterAll } from "bun:test";
-import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
+import { describe, it, test, expect, afterAll } from "bun:test";
+import { execFileSync } from "node:child_process";
+import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
 import { isRealBunBinary, bundledBunPath, durableBunPath, durableBunRuntime, overrideBunPath } from "../src/lib/bun-runtime";
+import { packagedNativeBinary, preferredDurableRuntime } from "../src/lib/runtime-entry";
 
 const tmp = mkdtempSync(join(tmpdir(), "ocx-bun-runtime-"));
 const previousOverride = process.env.OPENCODEX_BUN_PATH;
@@ -77,3 +79,84 @@ describe("bundledBunPath / durableBunPath", () => {
     else expect(durable).toBe(process.execPath);
   });
 });
+
+function runtimeFixture(name: string, version = "9.8.7"): { root: string; native: string } {
+  const root = join(tmp, name);
+  mkdirSync(join(root, "bin", "native"), { recursive: true });
+  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
+  const os = process.platform === "win32" ? "windows" : process.platform;
+  const arch = process.arch === "x64" ? "amd64" : "arm64";
+  return {
+    root,
+    native: join(root, "bin", "native", `ocx_${version}_${os}_${arch}${os === "windows" ? ".exe" : ""}`),
+  };
+}
+
+describe("preferredDurableRuntime", () => {
+  const fallback = { runtime: "/retained/bun", cli: "/retained/src/cli/index.ts" };
+
+  test("selects absolute Node plus the package launcher for an exact executable native artifact", () => {
+    const fixture = runtimeFixture("supported");
+    writeFileSync(fixture.native, "native", { mode: 0o755 });
+    chmodSync(fixture.native, 0o755);
+
+    expect(packagedNativeBinary(fixture.root)).toBe(fixture.native);
+    const expectedNode = execFileSync(process.platform === "win32" ? "where.exe" : "which", ["node"], {
+      encoding: "utf8",
+      windowsHide: true,
+    }).split(/\r?\n/, 1)[0]!.trim();
+    expect(preferredDurableRuntime(fixture.root, fallback)).toEqual({
+      runtime: expectedNode,
+      cli: join(fixture.root, "bin", "ocx.mjs"),
+    });
+  });
+
+  test("keeps the retained Bun entry for missing, stale-version, and non-executable artifacts", () => {
+    const missing = runtimeFixture("missing");
+    expect(preferredDurableRuntime(missing.root, fallback)).toEqual(fallback);
+
+    const stale = runtimeFixture("stale");
+    const staleName = fixtureName(stale.native).replace("9.8.7", "9.8.6");
+    writeFileSync(join(stale.root, "bin", "native", staleName), "stale", { mode: 0o755 });
+    expect(preferredDurableRuntime(stale.root, fallback)).toEqual(fallback);
+
+    if (process.platform !== "win32") {
+      const nonExecutable = runtimeFixture("non-executable");
+      writeFileSync(nonExecutable.native, "native", { mode: 0o644 });
+      chmodSync(nonExecutable.native, 0o644);
+      expect(preferredDurableRuntime(nonExecutable.root, fallback)).toEqual(fallback);
+    }
+  });
+
+  test.skipIf(process.platform === "win32")("rejects a symlinked native artifact", () => {
+    const fixture = runtimeFixture("symlink");
+    const target = join(fixture.root, "real-native");
+    writeFileSync(target, "native", { mode: 0o755 });
+    symlinkSync(target, fixture.native);
+    expect(packagedNativeBinary(fixture.root)).toBeNull();
+    expect(preferredDurableRuntime(fixture.root, fallback)).toEqual(fallback);
+  });
+
+  test.skipIf(process.platform === "win32")("surfaces Node lookup failure instead of persisting a relative command", () => {
+    const fixture = runtimeFixture("node-lookup-failure");
+    writeFileSync(fixture.native, "native", { mode: 0o755 });
+    chmodSync(fixture.native, 0o755);
+    const fakePath = join(tmp, "node-lookup-path");
+    mkdirSync(fakePath, { recursive: true });
+    const which = join(fakePath, "which");
+    writeFileSync(which, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
+    chmodSync(which, 0o755);
+    const oldPath = process.env.PATH;
+    try {
+      process.env.PATH = fakePath;
+      expect(() => preferredDurableRuntime(fixture.root, fallback)).toThrow();
+    } finally {
+      if (oldPath === undefined) delete process.env.PATH;
+      else process.env.PATH = oldPath;
+    }
+  });
+});
+
+function fixtureName(path: string): string {
+  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
+}
```

### `tests/service.test.ts`

```diff
diff --git a/tests/service.test.ts b/tests/service.test.ts
--- a/tests/service.test.ts
+++ b/tests/service.test.ts
@@ -47,5 +47,16 @@ function expectTextToContainPath(text: string, path: string): void {
   expect(pathVariants(path).some(candidate => text.includes(candidate))).toBe(true);
 }
 
+describe("durable service runtime entry", () => {
+  test("keeps the Bun fallback but delegates packaged native persistence to the Node launcher", async () => {
+    const service = await readText("src/service.ts");
+    expect(service).toContain('import { preferredDurableRuntime } from "./lib/runtime-entry"');
+    expect(service).toContain('export function serviceRuntimeEntry(packageRoot = join(import.meta.dir, ".."))');
+    expect(service).toContain('const fallback = { runtime: durableBunPath(), cli: join(import.meta.dir, "cli", "index.ts") }');
+    expect(service).toContain("preferredDurableRuntime(packageRoot, fallback)");
+    expect(service).toContain("return { bun: entry.runtime, cli: entry.cli }");
+  });
+});
+
 describe("service listen-port bake", () => {
   test("resolveServiceListenPort prefers override, then OCX_BAKE_PORT, then config", () => {
```

### `tests/windows-tray.test.ts`

```diff
diff --git a/tests/windows-tray.test.ts b/tests/windows-tray.test.ts
--- a/tests/windows-tray.test.ts
+++ b/tests/windows-tray.test.ts
@@ -22,5 +22,15 @@ const entry: WindowsTrayEntry = {
 };
 
 describe("Windows tray packaging and command safety", () => {
+  test("persists the Node launcher when a packaged native artifact is available", () => {
+    const source = readFileSync(join(import.meta.dir, "..", "src", "tray", "windows.ts"), "utf8");
+    expect(source).toContain('import { preferredDurableRuntime } from "../lib/runtime-entry"');
+    expect(source).toContain('export function windowsTrayRuntimeEntry(packageRoot = join(import.meta.dir, "..", ".."))');
+    expect(source).toContain('const fallback = { runtime: durableBunPath(), cli: join(import.meta.dir, "..", "cli", "index.ts") }');
+    expect(source).toContain("preferredDurableRuntime(packageRoot, fallback)");
+    expect(source).toContain("bun: entry.runtime");
+    expect(source).toContain("cli: entry.cli");
+  });
+
   test("uses fixed argv for the hidden PowerShell host", () => {
     const args = windowsTrayProcessArgs(entry);
```

### `tests/codex-shim.test.ts`

```diff
diff --git a/tests/codex-shim.test.ts b/tests/codex-shim.test.ts
--- a/tests/codex-shim.test.ts
+++ b/tests/codex-shim.test.ts
@@ -49,5 +49,13 @@ function withInstalledShim(run: (paths: {
 }
 
 describe("Codex autostart shim", () => {
+  test("freshly loaded shim ownership prefers Node launcher while cached owners retain Bun fallback", () => {
+    const source = readFileSync(join(import.meta.dir, "..", "src", "codex", "shim.ts"), "utf8");
+    expect(source).toContain('import { preferredDurableRuntime } from "../lib/runtime-entry"');
+    expect(source).toContain('const fallback = { runtime: durableBunPath(), cli: join(import.meta.dir, "..", "cli", "index.ts") }');
+    expect(source).toContain('preferredDurableRuntime(join(import.meta.dir, "..", ".."), fallback)');
+    expect(source).toContain("return { bun: entry.runtime, cli: entry.cli }");
+  });
+
   test("builds a Unix shim that starts ocx before execing Codex", () => {
     const script = buildUnixCodexShim("/usr/local/bin/codex-real", "/usr/local/bin/bun", "/opt/opencodex/src/cli.ts");
```

### `tests/ocx-launcher-source.test.ts`

```diff
diff --git a/tests/ocx-launcher-source.test.ts b/tests/ocx-launcher-source.test.ts
--- a/tests/ocx-launcher-source.test.ts
+++ b/tests/ocx-launcher-source.test.ts
@@ -1,5 +1,7 @@
 import { describe, expect, test } from "bun:test";
-import { readFileSync } from "node:fs";
+import { spawnSync } from "node:child_process";
+import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
+import { tmpdir } from "node:os";
 import { join } from "node:path";
 
 /**
@@ -23,4 +25,67 @@ describe("ocx.mjs npm launcher (source invariants)", () => {
     expect(source).toContain('if (explicit === "preview" || explicit === "latest") return explicit;');
     expect(source).not.toMatch(/if \(tagIndex !== -1 && process\.argv\[tagIndex \+ 1\]\) return process\.argv/);
   });
+
+  test("legacy npm convergence reloads the fresh launcher without entering shim install", () => {
+    expect(source).toContain('spawnSync(process.execPath, [launcher, "--version"]');
+    expect(source).not.toContain('[launcher, "codex-shim", "install"]');
+    expect(source).toContain('spawnSync(goBinary, ["codex-shim", "refresh"]');
+  });
+
+  test.skipIf(process.platform === "win32" || !["darwin", "linux"].includes(process.platform) || !["x64", "arm64"].includes(process.arch))("refreshes a legacy owned shim before forwarding and continues when refresh fails", () => {
+    const fixture = mkdtempSync(join(tmpdir(), "ocx-native-shim-refresh-"));
+    try {
+      const bin = join(fixture, "bin");
+      const nativeDir = join(bin, "native");
+      const updateDir = join(fixture, "src", "update");
+      const home = join(fixture, "home");
+      mkdirSync(nativeDir, { recursive: true });
+      mkdirSync(updateDir, { recursive: true });
+      mkdirSync(home, { recursive: true });
+      copyFileSync(join(import.meta.dir, "..", "bin", "ocx.mjs"), join(bin, "ocx.mjs"));
+      copyFileSync(join(import.meta.dir, "..", "bin", "native-runtime.mjs"), join(bin, "native-runtime.mjs"));
+      copyFileSync(
+        join(import.meta.dir, "..", "src", "update", "tray-update-plan.mjs"),
+        join(updateDir, "tray-update-plan.mjs"),
+      );
+      const version = "9.8.7";
+      writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "module", version }));
+      const os = process.platform;
+      const arch = process.arch === "x64" ? "amd64" : "arm64";
+      const native = join(nativeDir, `ocx_${version}_${os}_${arch}`);
+      const log = join(fixture, "calls.log");
+      writeFileSync(native, `#!/bin/sh
+printf '%s\\n' "$*" >> "$OCX_TEST_LOG"
+if [ "$1 $2" = "codex-shim refresh" ] && [ "$OCX_TEST_REFRESH_FAIL" = "1" ]; then exit 23; fi
+exit 0
+`, { mode: 0o755 });
+      chmodSync(native, 0o755);
+
+      const wrapper = join(fixture, "codex");
+      const backup = join(fixture, "codex.opencodex-real");
+      writeFileSync(wrapper, "#!/bin/sh\n# opencodex codex autostart shim\n'/retained/bun' '/pkg/src/cli/index.ts' ensure\n");
+      writeFileSync(backup, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
+      writeFileSync(join(home, "codex-shim.json"), JSON.stringify({
+        platform: process.platform,
+        wrapperPath: wrapper,
+        backupPath: backup,
+      }));
+      const launcher = join(bin, "ocx.mjs");
+      const env = { ...process.env, PATH: "", OPENCODEX_HOME: home, OCX_TEST_LOG: log };
+      const success = spawnSync(process.execPath, [launcher, "status"], { env, encoding: "utf8" });
+      expect(success.status).toBe(0);
+      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["codex-shim refresh", "status"]);
+
+      writeFileSync(log, "");
+      const failed = spawnSync(process.execPath, [launcher, "models"], {
+        env: { ...env, OCX_TEST_REFRESH_FAIL: "1" },
+        encoding: "utf8",
+      });
+      expect(failed.status).toBe(0);
+      expect(failed.stderr).toContain("continuing with the retained Bun bridge");
+      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["codex-shim refresh", "models"]);
+    } finally {
+      rmSync(fixture, { recursive: true, force: true });
+    }
+  });
 });
```

### `go/internal/codex/integration_parity_test.go`

```diff
diff --git a/go/internal/codex/integration_parity_test.go b/go/internal/codex/integration_parity_test.go
--- a/go/internal/codex/integration_parity_test.go
+++ b/go/internal/codex/integration_parity_test.go
@@ -50,4 +50,77 @@ func TestShimInstallIsIdempotentAndRestoresBackup(t *testing.T) {
 	}
 }
 
+func TestRefreshCodexShimRuntimeRewritesOnlyOwnedWrapper(t *testing.T) {
+	dir := t.TempDir()
+	wrapper := filepath.Join(dir, "codex")
+	backup := filepath.Join(dir, "codex.opencodex-real")
+	statePath := filepath.Join(dir, "codex-shim.json")
+	legacy := []byte("#!/bin/sh\n# " + shimMarker + "\n'/retained/bun' '/pkg/src/cli/index.ts' ensure\n")
+	original := []byte("#!/bin/sh\necho native\n")
+	if err := os.WriteFile(wrapper, legacy, 0o755); err != nil {
+		t.Fatal(err)
+	}
+	if err := os.WriteFile(backup, original, 0o755); err != nil {
+		t.Fatal(err)
+	}
+	stateBytes, _ := json.Marshal(ShimState{Platform: "linux", WrapperPath: wrapper, BackupPath: backup})
+	if err := os.WriteFile(statePath, stateBytes, 0o600); err != nil {
+		t.Fatal(err)
+	}
+	beforeState := append([]byte(nil), stateBytes...)
+	changed, err := RefreshCodexShimRuntime(statePath, "/new/package/bin/ocx", "/home/user/.opencodex/service-api-token", "linux")
+	if err != nil || !changed {
+		t.Fatalf("refresh = %v, %v", changed, err)
+	}
+	refreshed, _ := os.ReadFile(wrapper)
+	backupAfter, _ := os.ReadFile(backup)
+	stateAfter, _ := os.ReadFile(statePath)
+	if !strings.Contains(string(refreshed), "/new/package/bin/ocx") || !strings.Contains(string(refreshed), backup) || strings.Contains(string(refreshed), "/retained/bun") {
+		t.Fatalf("refreshed wrapper = %s", refreshed)
+	}
+	if !bytes.Equal(backupAfter, original) || !bytes.Equal(stateAfter, beforeState) {
+		t.Fatal("refresh changed the backup or state")
+	}
+}
+
+func TestRefreshCodexShimRuntimeRejectsForeignWrapperAndUnsafeBackup(t *testing.T) {
+	for _, test := range []struct {
+		name       string
+		owned      bool
+		makeBackup func(string) error
+	}{
+		{name: "foreign wrapper", makeBackup: func(path string) error { return os.WriteFile(path, []byte("native"), 0o755) }},
+		{name: "missing backup", owned: true, makeBackup: func(string) error { return nil }},
+		{name: "backup directory", owned: true, makeBackup: func(path string) error { return os.Mkdir(path, 0o700) }},
+	} {
+		t.Run(test.name, func(t *testing.T) {
+			dir := t.TempDir()
+			wrapper := filepath.Join(dir, "codex")
+			backup := filepath.Join(dir, "codex.opencodex-real")
+			statePath := filepath.Join(dir, "codex-shim.json")
+			body := "foreign wrapper\n"
+			if test.owned {
+				body = "#!/bin/sh\n# " + shimMarker + "\nlegacy\n"
+			}
+			if err := os.WriteFile(wrapper, []byte(body), 0o755); err != nil {
+				t.Fatal(err)
+			}
+			if err := test.makeBackup(backup); err != nil {
+				t.Fatal(err)
+			}
+			stateBytes, _ := json.Marshal(ShimState{Platform: "linux", WrapperPath: wrapper, BackupPath: backup})
+			if err := os.WriteFile(statePath, stateBytes, 0o600); err != nil {
+				t.Fatal(err)
+			}
+			if changed, err := RefreshCodexShimRuntime(statePath, "/new/ocx", "", "linux"); err == nil || changed {
+				t.Fatalf("refresh = %v, %v", changed, err)
+			}
+			after, _ := os.ReadFile(wrapper)
+			if string(after) != body {
+				t.Fatalf("wrapper mutated: %q", after)
+			}
+		})
+	}
+}
+
 func TestInjectBranchSelectionAndIdempotency(t *testing.T) {
```

Add the missing `bytes` import used by the first test:

```diff
diff --git a/go/internal/codex/integration_parity_test.go b/go/internal/codex/integration_parity_test.go
--- a/go/internal/codex/integration_parity_test.go
+++ b/go/internal/codex/integration_parity_test.go
@@ -1,6 +1,7 @@
 package codex
 
 import (
+	"bytes"
 	"database/sql"
 	"encoding/json"
 	"net/http"
```

### `go/internal/cli/lifecycle_extended_test.go`

```diff
diff --git a/go/internal/cli/lifecycle_extended_test.go b/go/internal/cli/lifecycle_extended_test.go
--- a/go/internal/cli/lifecycle_extended_test.go
+++ b/go/internal/cli/lifecycle_extended_test.go
@@ -6,6 +6,7 @@ import (
 	"encoding/json"
 	"os"
 	"path/filepath"
+	"runtime"
 	"strings"
 	"testing"
 
@@ -50,4 +51,45 @@ func TestCodexShimStatusUsesScopedStatePath(t *testing.T) {
 	}
 }
 
+func TestCodexShimRefreshUsesOwnedStateWithoutPATHDiscovery(t *testing.T) {
+	home := t.TempDir()
+	t.Setenv("OPENCODEX_HOME", home)
+	t.Setenv("PATH", "")
+	extension := ""
+	platform := runtime.GOOS
+	if runtime.GOOS == "windows" {
+		extension = ".cmd"
+	}
+	wrapper := filepath.Join(home, "codex"+extension)
+	backup := filepath.Join(home, "codex.opencodex-real"+extension)
+	statePath := filepath.Join(home, "codex-shim.json")
+	if err := os.WriteFile(wrapper, []byte("# opencodex codex autostart shim\nlegacy src/cli/index.ts\n"), 0o755); err != nil {
+		t.Fatal(err)
+	}
+	if err := os.WriteFile(backup, []byte("native\n"), 0o755); err != nil {
+		t.Fatal(err)
+	}
+	state, _ := json.Marshal(map[string]string{
+		"platform": platform, "wrapperPath": wrapper, "backupPath": backup,
+	})
+	if err := os.WriteFile(statePath, state, 0o600); err != nil {
+		t.Fatal(err)
+	}
+	var output bytes.Buffer
+	if err := runCodexShim([]string{"refresh"}, IO{Out: &output}); err != nil {
+		t.Fatal(err)
+	}
+	executable, err := os.Executable()
+	if err != nil {
+		t.Fatal(err)
+	}
+	refreshed, err := os.ReadFile(wrapper)
+	if err != nil {
+		t.Fatal(err)
+	}
+	if !strings.Contains(output.String(), "runtime refreshed") || !strings.Contains(string(refreshed), executable) {
+		t.Fatalf("output=%q wrapper=%q", output.String(), refreshed)
+	}
+}
+
 func TestSyncCacheWritesExpiredCacheFromCatalog(t *testing.T) {
```

## 9. Go update-planner parity

The TS bridge moves both npm and Bun package installs to the fresh Node launcher.
The native dry-run planner is part of the strict differential matrix and must make
the same distinction while preserving source-checkout runtime execution.

```diff
diff --git a/go/internal/update/planning.go b/go/internal/update/planning.go
--- a/go/internal/update/planning.go
+++ b/go/internal/update/planning.go
@@ -152,7 +152,7 @@ func BuildRestartPlan(installer Installer, runtimeExecutable, launcher string, s
 		args = append([]string{launcher}, serviceArgs...)
 	}
 	bin := runtimeExecutable
-	if installer == InstallerNPM {
+	if installer == InstallerNPM || installer == InstallerBun {
 		bin = executableName("node")
 	}
 	return RestartPlan{Mode: mode, Command: Command{Bin: bin, Args: args}}
diff --git a/go/internal/update/planning_test.go b/go/internal/update/planning_test.go
--- a/go/internal/update/planning_test.go
+++ b/go/internal/update/planning_test.go
@@ -25,13 +25,17 @@ func TestDetectInstaller(t *testing.T) {
 
 func TestRestartPlanningAndHealthConfirmation(t *testing.T) {
 	proxy := BuildRestartPlan(InstallerBun, "/runtime/ocx", "/pkg/cli", false, 12000, nil)
-	if proxy.Mode != RestartProxy || proxy.Command.Bin != "/runtime/ocx" || strings.Join(proxy.Command.Args, " ") != "/pkg/cli start --port 12000" {
+	if proxy.Mode != RestartProxy || !strings.HasSuffix(proxy.Command.Bin, "node") || strings.Join(proxy.Command.Args, " ") != "/pkg/cli start --port 12000" {
 		t.Fatalf("proxy plan = %#v", proxy)
 	}
 	service := BuildRestartPlan(InstallerNPM, "/ignored", "/pkg/cli", true, 12000, []string{"service", "install", "--native"})
 	if service.Mode != RestartService || !strings.HasSuffix(service.Command.Bin, "node") || strings.Join(service.Command.Args, " ") != "/pkg/cli service install --native" {
 		t.Fatalf("service plan = %#v", service)
 	}
+	source := BuildRestartPlan(InstallerSource, "/runtime/ocx", "/checkout/bin/ocx.mjs", false, 12000, nil)
+	if source.Command.Bin != "/runtime/ocx" || strings.Join(source.Command.Args, " ") != "/checkout/bin/ocx.mjs start --port 12000" {
+		t.Fatalf("source plan = %#v", source)
+	}
 	if !IsSourceBuildVersion(" 0.0.0 ") || IsSourceBuildVersion("2.8.0") {
 		t.Fatal("source build detection mismatch")
 	}
```

## 10. Coverage map and required verification

| `020` promise | Literal implementation and receipt |
| --- | --- |
| version-matched durable runtime | section 1 + `preferredDurableRuntime` tests |
| service owner persistence | section 2 + immutable old-process service receipt (plist, unit, Windows script) |
| tray owner persistence | section 2 + immutable old-process tray Run-command receipt |
| direct updater bridge | section 6 old-call receipt; section 5 direct updater hunk is future-run hardening only |
| GUI worker bridge | section 6 old-call receipt; section 5 worker hunk is future-run hardening only |
| cached old shim | section 3 fresh launcher guard + section 4 Go wrapper-only refresh |
| no Codex PATH discovery during refresh | launcher fixture with empty `PATH` + `TestCodexShimRefreshUsesOwnedStateWithoutPATHDiscovery` |
| refresh failure safety | launcher fixture proves requested command still runs on retained Bun |
| strict update planning parity | section 9 + `TestTypeScriptAndGoUpdateDryRunPlanning` |

```bash
bun test --isolate tests/prebridge-runtime-rebake.test.ts tests/bun-runtime.test.ts tests/service.test.ts tests/windows-tray.test.ts tests/codex-shim.test.ts tests/ocx-launcher-source.test.ts tests/update-job.test.ts tests/update-stop-first.test.ts tests/update-tray-handoff.test.ts
cd go
go test ./internal/codex ./internal/cli ./internal/update -count=1
go test ./test/parity -run TestTypeScriptAndGoUpdateDryRunPlanning -count=1
```

Acceptance requires the named launcher test to show the exact call order
`codex-shim refresh` then the requested command with an empty `PATH`, plus a zero exit
for the requested command when refresh itself exits non-zero. The Go tests must prove
that wrapper-only refresh leaves both backup and state byte-identical and refuses a
foreign wrapper, missing backup, and non-regular backup without mutation.
