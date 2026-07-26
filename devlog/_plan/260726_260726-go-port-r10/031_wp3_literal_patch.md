# 031 — WP3 literal patch appendix: Go-first launcher and bounded native update

Date: 2026-07-26  
Class: C4 docs-only release/runtime contract  
Owner plan: `030_go_only_launcher.md`  
Historical audit: `003_audit_round3_replan.md` (its shim-install wording is
superseded by current WP2 `021_wp2_literal_patch.md`)

## Scope lock

This appendix is the copy-paste implementation contract for WP3. It changes no
production file in this docs-only pass.

IN:

- reject symlinked/non-regular/non-executable native artifacts with `lstatSync`;
- fail closed on the six supported package targets instead of activating Bun;
- prove the Go path with a poison Bun binary and poison Bun installer;
- permit native replacement only when the release is same-channel, same-major,
  and strictly newer; equal is an explicit no-op before download;
- document and test bounded package/runtime version skew;
- replace Bun-launcher assumptions in the repository-wide test suite with
  native child signal-forwarding coverage;
- update source-development and install/package contracts while retaining Bun.

OUT:

- deleting `bun`, `src/**`, the explicit Bun package export, or legacy updater code;
- changing WP2's wrapper-only `codex-shim refresh` detection, guard, command, or tests;
- adding any fresh-launch shim repair that performs discovery or installation;
- changing release asset names, checksum trust, or `DownloadAndReplace`;
- cross-major native migration, stable/preview channel crossing, automatic npm
  package replacement, service/tray redesign, commit, push, or release.

## Behavioral invariants

1. A supported `(platform, arch)` is Darwin/Linux/Windows × amd64/arm64.
2. A supported installed launcher never reaches `require.resolve("bun/package.json")`,
   the Bun installer, or `src/cli/index.ts`. Missing, stale-version, symlinked, and
   non-executable Unix artifacts terminate with `opencodex: Go runtime ...`.
3. Unsupported installed hosts and source-fixture targets return `null` in
   `auto`; this is the retained automatic Bun bridge outside the six-platform
   native release promise. `OPENCODEX_RUNTIME=ts` cannot override the
   fail-closed rule on a supported target.
4. Windows requires a regular `.exe` file but does not apply Unix execute bits.
5. `ocx update --tag latest` accepts stable→stable only; `--tag preview` accepts
   preview→preview only. Candidate and current major must match.
6. Equal candidate is a successful no-op. Older, malformed, cross-channel, and
   cross-major candidates error before `downloadNativeUpdate`.
7. Native update replaces the current package-local executable path. The npm
   package metadata and launcher filename remain at the installed package version;
   the newer Go bytes may report a newer runtime version. This skew is supported
   only inside invariant 5 and requires `npm install -g @bitkyc08/opencodex@<tag>`
   for package-layout/launcher changes.
8. `bun: 1.3.14` remains installed and dormant for bridge recovery, explicit Bun
   package API use, and source development.
9. WP2 remains the sole shim-convergence owner: after native selection,
   `refreshLegacyCodexShim(goBinary)` may invoke only guarded wrapper-only
   `codex-shim refresh` before command forwarding. WP3 adds no shim install path,
   discovery, state migration, or replacement test.
10. Source CLI version tests execute `src/cli/index.ts`; the supported Node
    launcher is tested only with a package-local or explicit Go child. Its
    SIGINT/SIGTERM/SIGHUP contract forwards each signal to that child and waits
    for the child's exit.

## Literal unified patch

Apply this block from repository root only after the current WP1
(`011_wp1_literal_patch.md`) and current WP2 (`021_wp2_literal_patch.md`) patches
have been applied in that order. Every hunk below is generated against that exact
post-WP1+WP2 tree; it does not repeat either predecessor's production changes.
```diff
diff --git a/CONTRIBUTING.md b/CONTRIBUTING.md
index 87ccd331..c21d4959 100644
--- a/CONTRIBUTING.md
+++ b/CONTRIBUTING.md
@@ -20,8 +20,9 @@ For local development commands, architecture notes, and release workflow details
 contributing guide above instead of duplicating instructions here.
 
 Source development requires the `bun` CLI on your `PATH`. The published npm package bundles its own
-Bun runtime for end users, but contributor commands such as `bun install`, `bun run test`, and
-`bun run prepush` run from your local Bun installation.
+packaged Go CLI for supported targets. Bun remains an installed but dormant bridge dependency and
+powers the explicit Bun package API, while contributor commands such as `bun install`, `bun run test`,
+and `bun run prepush` run from your local Bun installation.
 
 ## Pre-push hook
 
diff --git a/README.md b/README.md
index 66808ae6..862ac518 100644
--- a/README.md
+++ b/README.md
@@ -88,12 +88,12 @@ flowchart LR
 | Linux (x64 / arm64) | Fully supported | systemd (user unit) |
 | Windows (x64) | Fully supported | Task Scheduler (hidden) / opt-in native service (`--native`, WinSW) |
 
-Requires [Node](https://nodejs.org) 18+. The Bun runtime is bundled automatically on `npm install` — no separate Bun install needed. All three platforms work natively (no WSL needed on Windows).
+Requires [Node](https://nodejs.org) 18+. Supported npm installs run the packaged Go binary. Bun remains an installed but dormant bridge dependency for old-updater recovery and the explicit package API; no separate Bun install is needed. All three platforms work natively (no WSL needed on Windows).
 
 ## Quick start
 
 ```bash
-# Install (bundles the Bun runtime automatically — only Node 18+ required)
+# Install (packaged Go CLI; only Node 18+ required)
 # Prefer a user-owned Node (nvm/fnm) — avoid `sudo npm install -g …`
 npm install -g @bitkyc08/opencodex
 
@@ -111,15 +111,15 @@ codex "Write a hello world in Rust"
 ```
 
 <details>
-<summary><b>"bundled Bun runtime is missing" / npm blocked Bun install scripts?</b></summary>
+<summary><b>npm blocked the dormant Bun bridge dependency?</b></summary>
 
 <br/>
 
-opencodex bundles the Bun runtime as a dependency and runs it via a Node
-launcher, so you do **not** need to install Bun yourself. If you see a
-"bundled Bun runtime is missing" error, the install skipped lifecycle scripts
-(including npm blocking bun's postinstall under `allowScripts`) or optional
-dependencies. Reinstall without those flags, allowing bun's install script:
+Supported installed `ocx` commands run the packaged Go binary; Bun is not on the
+normal CLI path. The npm package still carries Bun during the bridge for explicit
+programmatic API use and recovery by older updaters. You do **not** need to install
+Bun yourself. If npm blocked that dependency's lifecycle script, reinstall while
+allowing it so those bridge/API paths remain available:
 
 ```bash
 npm install -g --allow-scripts=bun @bitkyc08/opencodex   # no --ignore-scripts, no --omit=optional
@@ -319,6 +319,12 @@ ocx claude [args...]           # launch Claude Code wired to the proxy (model di
 ocx claude desktop             # save and apply the Claude Desktop four-family profile
 ocx service [install|start|stop|status|uninstall]   # install/update/start background service
 ocx update [--tag preview]     # update opencodex; preview installs stay on @preview
+On supported installed targets, `ocx update` replaces only the current packaged Go executable.
+It accepts a strictly newer release from the same channel and major; equal versions are a no-op,
+and downgrade, stable/preview crossing, malformed, or cross-major releases are rejected before
+download. The npm package metadata and launcher filename remain at the installed package version,
+so use `npm install -g @bitkyc08/opencodex@latest` (or `@preview`) for launcher or package-layout changes.
+
 ```
 
 ### Claude Desktop profile
@@ -505,7 +511,8 @@ lives in [`SECURITY.md`](./SECURITY.md).
 ## Development
 
 Source development requires the `bun` CLI on your `PATH`. This is separate from the published npm
-package's bundled Bun runtime, which is used only by installed `ocx` commands.
+package: supported installed `ocx` commands launch packaged Go, while Bun remains a dormant bridge
+dependency and powers the explicit Bun package API. Contributor commands use your local Bun installation.
 
 ```bash
 git clone https://github.com/lidge-jun/opencodex.git
diff --git a/bin/native-runtime.mjs b/bin/native-runtime.mjs
index a84fc222..ee0c7c83 100644
--- a/bin/native-runtime.mjs
+++ b/bin/native-runtime.mjs
@@ -1,4 +1,4 @@
-import { statSync } from "node:fs";
+import { lstatSync } from "node:fs";
 import { spawn } from "node:child_process";
 import { homedir } from "node:os";
 import { join, resolve } from "node:path";
@@ -9,6 +9,10 @@ function nativeTarget(platform, architecture) {
   return os && arch ? { os, arch } : null;
 }
 
+export function isSupportedNativeTarget(platform, architecture) {
+  return nativeTarget(platform, architecture) !== null;
+}
+
 export function nativeArtifactName(version, target) {
   return `ocx_${version}_${target.os}_${target.arch}${target.os === "windows" ? ".exe" : ""}`;
 }
@@ -21,7 +25,7 @@ function expandUserPath(raw) {
 
 function isExecutableFile(path, platform) {
   try {
-    const stat = statSync(path);
+    const stat = lstatSync(path);
     return stat.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0);
   } catch {
     return false;
diff --git a/bin/ocx.mjs b/bin/ocx.mjs
index fc141464..29a5e5df 100755
--- a/bin/ocx.mjs
+++ b/bin/ocx.mjs
@@ -2,9 +2,9 @@
 /**
  * opencodex npm bin launcher.
  *
- * Packaged native Go binaries take precedence when present. Until release
- * packaging includes them, this launcher preserves the existing TypeScript/Bun
- * runtime as an automatic fallback.
+ * Supported packaged targets require their exact native Go binary. The legacy
+ * TypeScript/Bun path remains only for bridge recovery and unsupported source
+ * fixtures; it is never an automatic fallback on a supported release target.
  */
 import { spawn, spawnSync } from "node:child_process";
 import { createRequire } from "node:module";
@@ -13,7 +13,7 @@ import { homedir } from "node:os";
 import { dirname, join, resolve } from "node:path";
 import { fileURLToPath } from "node:url";
 import { handoffWindowsTrayForUpdate, planWindowsTrayUpdate } from "../src/update/tray-update-plan.mjs";
-import { launchForwardingChild, resolveNativeGoBinary } from "./native-runtime.mjs";
+import { isSupportedNativeTarget, launchForwardingChild, resolveNativeGoBinary } from "./native-runtime.mjs";
 
 const PKG = "@bitkyc08/opencodex";
 const CODEX_SHIM_MARKER = "opencodex codex autostart shim";
@@ -391,7 +391,9 @@ function resolveBun() {
 }
 
 const goBinary = resolveGoBinary();
-if (goBinary) {
+if (!goBinary && isSupportedNativeTarget(process.platform, process.arch)) {
+  failGo("requires the exact packaged binary for this platform; reinstall the npm package.");
+} else if (goBinary) {
   refreshLegacyCodexShim(goBinary);
   launchForwardingChild(goBinary, process.argv.slice(2), "Go runtime");
 } else {
diff --git a/docs-site/src/content/docs/contributing.md b/docs-site/src/content/docs/contributing.md
index 4052613e..601b5177 100644
--- a/docs-site/src/content/docs/contributing.md
+++ b/docs-site/src/content/docs/contributing.md
@@ -6,7 +6,8 @@ description: Develop opencodex — setup, layout, conventions, and how to add a
 ## Setup
 
 Source development requires the `bun` CLI on your `PATH`. The published npm package bundles its own
-Bun runtime for users, but this checkout's scripts run through your local Bun installation.
+packaged Go CLI for supported targets. Bun remains an installed but dormant bridge dependency and
+powers the explicit Bun package API, while this checkout's scripts run through your local Bun installation.
 
 ```bash
 git clone https://github.com/lidge-jun/opencodex.git
diff --git a/go/internal/cli/update.go b/go/internal/cli/update.go
index 60555fcc..87686528 100644
--- a/go/internal/cli/update.go
+++ b/go/internal/cli/update.go
@@ -41,13 +41,18 @@ func runUpdate(ctx context.Context, args []string, streams IO) error {
 		if err != nil {
 			return fmt.Errorf("resolve %s release: %w", channel, err)
 		}
+		current := strings.TrimPrefix(strings.TrimSpace(Version), "v")
+		newer, err := updatepkg.ValidateNativeUpdate(current, artifact.Version, channel)
+		if err != nil {
+			return fmt.Errorf("refuse native update: %w", err)
+		}
 		if *destination == "" {
 			*destination, err = os.Executable()
 			if err != nil {
 				return err
 			}
 		}
-		if strings.TrimPrefix(Version, "v") == artifact.Version {
+		if !newer {
 			fmt.Fprintf(streams.Out, "Already on the latest %s release (v%s).\n", channel, artifact.Version)
 			return nil
 		}
@@ -58,7 +63,7 @@ func runUpdate(ctx context.Context, args []string, streams IO) error {
 		if err := downloadNativeUpdate(ctx, artifact.URL, artifact.SHA256, *destination); err != nil {
 			return err
 		}
-		fmt.Fprintf(streams.Out, "Updated %s to v%s (%s).\n", *destination, artifact.Version, artifact.Name)
+		fmt.Fprintf(streams.Out, "Updated native runtime %s to v%s (%s). Package metadata remains v%s; use npm for launcher or package-layout updates.\n", *destination, artifact.Version, artifact.Name, current)
 		return nil
 	}
 	if *url == "" || *sha == "" {
diff --git a/go/internal/cli/update_test.go b/go/internal/cli/update_test.go
index e1b9cc64..b8950fe3 100644
--- a/go/internal/cli/update_test.go
+++ b/go/internal/cli/update_test.go
@@ -19,6 +19,8 @@ import (
 func TestUpdateTagDryRunPlansNativeReleaseArtifact(t *testing.T) {
 	restore := stubNativeReleaseUpdate(t)
 	defer restore()
+	restoreVersion := setUpdateTestVersion("2.8.0-preview.1")
+	defer restoreVersion()
 	var output bytes.Buffer
 	destination := filepath.Join(t.TempDir(), "ocx")
 	if err := runUpdate(context.Background(), []string{"--tag", "preview", "--destination", destination, "--dry-run"}, IO{Out: &output, Err: &output}); err != nil {
@@ -32,6 +34,8 @@ func TestUpdateTagDryRunPlansNativeReleaseArtifact(t *testing.T) {
 }
 
 func TestUpdatePreviewDryRunResolvesManifestWithoutReplacingBinary(t *testing.T) {
+	restoreVersion := setUpdateTestVersion("2.9.0-preview.20260725")
+	defer restoreVersion()
 	const version = "2.9.1-preview.20260726"
 	digest := strings.Repeat("c", 64)
 	artifactName := updatepkg.ReleaseArtifactName(version, runtime.GOOS, runtime.GOARCH)
@@ -97,6 +101,8 @@ func TestUpdateRejectsUnknownTagWithoutExecution(t *testing.T) {
 func TestUpdateTagDownloadsVerifiedNativeArtifact(t *testing.T) {
 	restore := stubNativeReleaseUpdate(t)
 	defer restore()
+	restoreVersion := setUpdateTestVersion("2.8.0")
+	defer restoreVersion()
 	destination := filepath.Join(t.TempDir(), "ocx")
 	if err := os.WriteFile(destination, []byte("old"), 0o755); err != nil {
 		t.Fatal(err)
@@ -104,7 +110,7 @@ func TestUpdateTagDownloadsVerifiedNativeArtifact(t *testing.T) {
 	if err := runUpdate(context.Background(), []string{"--tag", "latest", "--destination", destination}, IO{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}); err != nil {
 		t.Fatal(err)
 	}
-	if got := string(mustReadFile(t, destination)); got != "downloaded:https://github.com/lidge-jun/opencodex/releases/download/v2.9.0-preview.1/ocx_2.9.0-preview.1_linux_amd64:"+strings.Repeat("a", 64) {
+	if got := string(mustReadFile(t, destination)); got != "downloaded:https://github.com/lidge-jun/opencodex/releases/download/v2.9.0/ocx_2.9.0_linux_amd64:"+strings.Repeat("a", 64) {
 		t.Fatalf("replacement=%q", got)
 	}
 }
@@ -128,11 +134,71 @@ func TestUpdateTagDoesNotReplaceMatchingVersion(t *testing.T) {
 	}
 }
 
+func TestRunDispatchesUpdateToBoundedNativeUpdater(t *testing.T) {
+	restore := stubNativeReleaseUpdate(t)
+	defer restore()
+	restoreVersion := setUpdateTestVersion("2.8.0")
+	defer restoreVersion()
+	destination := filepath.Join(t.TempDir(), "ocx")
+	var output bytes.Buffer
+	if code := Run(context.Background(), []string{"update", "--tag", "latest", "--destination", destination}, IO{Out: &output, Err: &output}); code != 0 {
+		t.Fatalf("dispatch exit=%d output=%s", code, output.String())
+	}
+	if got := string(mustReadFile(t, destination)); !strings.Contains(got, "/v2.9.0/ocx_2.9.0_linux_amd64") {
+		t.Fatalf("dispatch did not replace through native updater: %q", got)
+	}
+	for _, want := range []string{"Package metadata remains v2.8.0", "use npm for launcher or package-layout updates"} {
+		if !strings.Contains(output.String(), want) {
+			t.Fatalf("dispatch output missing %q: %s", want, output.String())
+		}
+	}
+}
+
+func TestUpdateRejectsUnsafeReleaseBeforeDownload(t *testing.T) {
+	tests := []struct {
+		name, current, candidate string
+		channel                  updatepkg.Channel
+	}{
+		{name: "downgrade", current: "2.8.2", candidate: "2.8.1", channel: updatepkg.ChannelLatest},
+		{name: "cross major", current: "2.8.2", candidate: "3.0.0", channel: updatepkg.ChannelLatest},
+		{name: "stable on preview", current: "2.8.2-preview.1", candidate: "2.8.2", channel: updatepkg.ChannelPreview},
+		{name: "preview on stable", current: "2.8.2", candidate: "2.8.3-preview.1", channel: updatepkg.ChannelLatest},
+		{name: "malformed", current: "2.8.2", candidate: "latest", channel: updatepkg.ChannelLatest},
+	}
+	for _, test := range tests {
+		t.Run(test.name, func(t *testing.T) {
+			previousResolve, previousDownload := resolveNativeReleaseArtifact, downloadNativeUpdate
+			previousVersion := Version
+			defer func() {
+				resolveNativeReleaseArtifact, downloadNativeUpdate, Version = previousResolve, previousDownload, previousVersion
+			}()
+			Version = test.current
+			resolveNativeReleaseArtifact = func(context.Context, updatepkg.Channel) (updatepkg.ReleaseArtifact, error) {
+				return updatepkg.ReleaseArtifact{Channel: test.channel, Version: test.candidate}, nil
+			}
+			downloads := 0
+			downloadNativeUpdate = func(context.Context, string, string, string) error {
+				downloads++
+				return nil
+			}
+			err := runUpdate(context.Background(), []string{"--tag", string(test.channel), "--destination", filepath.Join(t.TempDir(), "ocx")}, IO{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}})
+			if err == nil || downloads != 0 {
+				t.Fatalf("err=%v downloads=%d", err, downloads)
+			}
+		})
+	}
+}
+
 func stubNativeReleaseUpdate(t *testing.T) func() {
 	t.Helper()
 	previousResolve, previousDownload := resolveNativeReleaseArtifact, downloadNativeUpdate
-	resolveNativeReleaseArtifact = func(context.Context, updatepkg.Channel) (updatepkg.ReleaseArtifact, error) {
-		return updatepkg.ReleaseArtifact{Version: "2.9.0-preview.1", Name: "ocx_2.9.0-preview.1_linux_amd64", URL: "https://github.com/lidge-jun/opencodex/releases/download/v2.9.0-preview.1/ocx_2.9.0-preview.1_linux_amd64", SHA256: strings.Repeat("a", 64)}, nil
+	resolveNativeReleaseArtifact = func(_ context.Context, channel updatepkg.Channel) (updatepkg.ReleaseArtifact, error) {
+		version := "2.9.0"
+		if channel == updatepkg.ChannelPreview {
+			version = "2.9.0-preview.1"
+		}
+		name := "ocx_" + version + "_linux_amd64"
+		return updatepkg.ReleaseArtifact{Channel: channel, Version: version, Name: name, URL: "https://github.com/lidge-jun/opencodex/releases/download/v" + version + "/" + name, SHA256: strings.Repeat("a", 64)}, nil
 	}
 	downloadNativeUpdate = func(_ context.Context, sourceURL, digest, destination string) error {
 		return os.WriteFile(destination, []byte("downloaded:"+sourceURL+":"+digest), 0o755)
@@ -140,6 +206,12 @@ func stubNativeReleaseUpdate(t *testing.T) func() {
 	return func() { resolveNativeReleaseArtifact, downloadNativeUpdate = previousResolve, previousDownload }
 }
 
+func setUpdateTestVersion(version string) func() {
+	previous := Version
+	Version = version
+	return func() { Version = previous }
+}
+
 func mustReadFile(t *testing.T, path string) []byte {
 	t.Helper()
 	data, err := os.ReadFile(path)
diff --git a/go/internal/update/check.go b/go/internal/update/check.go
index 3e37a5e3..816b5e9b 100644
--- a/go/internal/update/check.go
+++ b/go/internal/update/check.go
@@ -110,6 +110,42 @@ func IsNewer(latest, current string, channel Channel) bool {
 	return leftStableOK && rightStableOK && greater(leftStable, rightStable)
 }
 
+// ValidateNativeUpdate bounds package/runtime skew. Native replacement may move
+// the Go bytes ahead of package metadata, but only inside one channel and major.
+// Equal versions are a no-op; every other accepted candidate is strictly newer.
+func ValidateNativeUpdate(current, candidate string, channel Channel) (bool, error) {
+	if err := ValidateChannel(channel); err != nil {
+		return false, err
+	}
+	current = strings.TrimPrefix(strings.TrimSpace(current), "v")
+	candidate = strings.TrimPrefix(strings.TrimSpace(candidate), "v")
+	var currentParts, candidateParts []int
+	var currentOK, candidateOK bool
+	if channel == ChannelLatest {
+		currentParts, currentOK = parseStable(current)
+		candidateParts, candidateOK = parseStable(candidate)
+	} else {
+		currentParts, currentOK = parsePreview(current)
+		candidateParts, candidateOK = parsePreview(candidate)
+	}
+	if !currentOK {
+		return false, fmt.Errorf("current version %q is incompatible with %s native updates", current, channel)
+	}
+	if !candidateOK {
+		return false, fmt.Errorf("candidate version %q is incompatible with %s native updates", candidate, channel)
+	}
+	if currentParts[0] != candidateParts[0] {
+		return false, fmt.Errorf("native update cannot cross major versions (%d to %d); update the npm package instead", currentParts[0], candidateParts[0])
+	}
+	if !greater(candidateParts, currentParts) {
+		if !greater(currentParts, candidateParts) {
+			return false, nil
+		}
+		return false, fmt.Errorf("native update candidate v%s is older than current v%s", candidate, current)
+	}
+	return true, nil
+}
+
 func parseStable(value string) ([]int, bool) {
 	return parseNumericVersion(value, 3, "")
 }
diff --git a/go/internal/update/release_test.go b/go/internal/update/release_test.go
index c0a23117..3ed10b34 100644
--- a/go/internal/update/release_test.go
+++ b/go/internal/update/release_test.go
@@ -78,6 +78,39 @@ func TestGitHubReleaseResolverSelectsChannelAndVerifiedArtifact(t *testing.T) {
 	}
 }
 
+func TestValidateNativeUpdateBoundsPackageRuntimeSkew(t *testing.T) {
+	tests := []struct {
+		name, current, candidate string
+		channel                  Channel
+		wantNewer                bool
+		wantError                string
+	}{
+		{name: "stable newer", current: "2.8.0", candidate: "2.8.1", channel: ChannelLatest, wantNewer: true},
+		{name: "preview newer", current: "2.8.1-preview.4", candidate: "2.8.1-preview.5", channel: ChannelPreview, wantNewer: true},
+		{name: "equal no-op", current: "v2.8.1", candidate: "2.8.1", channel: ChannelLatest},
+		{name: "downgrade", current: "2.8.1", candidate: "2.8.0", channel: ChannelLatest, wantError: "older than current"},
+		{name: "stable to preview", current: "2.8.0", candidate: "2.8.1-preview.1", channel: ChannelLatest, wantError: "incompatible with latest"},
+		{name: "preview to stable", current: "2.8.0-preview.1", candidate: "2.8.0", channel: ChannelPreview, wantError: "incompatible with preview"},
+		{name: "cross major", current: "2.9.9", candidate: "3.0.0", channel: ChannelLatest, wantError: "cannot cross major"},
+		{name: "malformed current", current: "development", candidate: "2.8.1", channel: ChannelLatest, wantError: "current version"},
+		{name: "malformed candidate", current: "2.8.0", candidate: "2.8", channel: ChannelLatest, wantError: "candidate version"},
+	}
+	for _, test := range tests {
+		t.Run(test.name, func(t *testing.T) {
+			newer, err := ValidateNativeUpdate(test.current, test.candidate, test.channel)
+			if newer != test.wantNewer {
+				t.Fatalf("newer=%t want=%t err=%v", newer, test.wantNewer, err)
+			}
+			if test.wantError == "" && err != nil {
+				t.Fatal(err)
+			}
+			if test.wantError != "" && (err == nil || !strings.Contains(err.Error(), test.wantError)) {
+				t.Fatalf("error=%v want substring %q", err, test.wantError)
+			}
+		})
+	}
+}
+
 func TestGitHubReleaseResolverRejectsUntrustedAssetHost(t *testing.T) {
 	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
 		payload := newReleasePayload("https://downloads.example.test", "v2.8.0", false, false)
diff --git a/package.json b/package.json
index a93f8f5d..6ebbe127 100644
--- a/package.json
+++ b/package.json
@@ -45,6 +45,7 @@
     "prepare:package": "bun scripts/prepare-package.ts",
     "prepare:native-package": "bun scripts/prepare-package.ts --native",
     "verify:native-package": "bun scripts/prepare-package.ts --verify-pack pack.json",
+    "test:native-launcher": "node --test scripts/ocx-native-launcher.test.mjs",
     "prepack": "bun run prepare:native-package && bun run prepare:package",
     "prepublishOnly": "bun run typecheck && bun run build:gui",
     "release": "bun scripts/release.ts",
diff --git a/scripts/ocx-native-launcher.test.mjs b/scripts/ocx-native-launcher.test.mjs
index 4c61d139..7aaace54 100644
--- a/scripts/ocx-native-launcher.test.mjs
+++ b/scripts/ocx-native-launcher.test.mjs
@@ -1,12 +1,12 @@
 import assert from "node:assert/strict";
-import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
+import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
 import { spawnSync } from "node:child_process";
 import { tmpdir } from "node:os";
 import { dirname, join } from "node:path";
 import { fileURLToPath } from "node:url";
 import test from "node:test";
 
-import { nativeArtifactName, resolveNativeGoBinary } from "../bin/native-runtime.mjs";
+import { isSupportedNativeTarget, nativeArtifactName, resolveNativeGoBinary } from "../bin/native-runtime.mjs";
 
 const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
 const launcher = join(root, "bin", "ocx.mjs");
@@ -28,8 +28,12 @@ function launcherFixture() {
   writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", type: "module", version: "2.9.0" }));
   writeFileSync(join(dir, "node_modules", "bun", "package.json"), JSON.stringify({ name: "bun", version: "1.3.14" }));
   const bun = join(dir, "node_modules", "bun", "bin", "bun");
-  writeFileSync(bun, "#!/bin/sh\nprintf 'ts:%s\\n' \"$*\" > \"$OCX_TEST_RESULT\"\nexit 19\n#" + "x".repeat(1_000_000));
+  writeFileSync(bun, "#!/bin/sh\nprintf 'bun-binary-ran\\n' > \"$OCX_POISON_RESULT\"\nexit 91\n#" + "x".repeat(1_000_000));
   chmodSync(bun, 0o755);
+  writeFileSync(
+    join(dir, "node_modules", "bun", "install.js"),
+    "require('node:fs').writeFileSync(process.env.OCX_POISON_RESULT, 'bun-installer-ran\\n'); process.exit(92);\n",
+  );
   const goOverride = join(dir, "override-go");
   writeFileSync(goOverride, "#!/bin/sh\nprintf 'go:%s\\n' \"$*\" > \"$OCX_TEST_RESULT\"\nexit 17\n");
   chmodSync(goOverride, 0o755);
@@ -43,12 +47,23 @@ function launcherFixture() {
 
 function runFixture(fixture, env) {
   const resultPath = join(fixture.dir, "result.txt");
+  const poisonPath = join(fixture.dir, "poison.txt");
   const result = spawnSync(process.execPath, [join(fixture.dir, "bin", "ocx.mjs"), "status", "--json"], {
     encoding: "utf8",
     timeout: 10_000,
-    env: { ...process.env, OPENCODEX_HOME: join(fixture.dir, "home"), OCX_TEST_RESULT: resultPath, ...env },
+    env: {
+      ...process.env,
+      OPENCODEX_HOME: join(fixture.dir, "home"),
+      OCX_TEST_RESULT: resultPath,
+      OCX_POISON_RESULT: poisonPath,
+      ...env,
+    },
   });
-  return { result, invocation: readFileSync(resultPath, "utf8") };
+  return {
+    result,
+    invocation: existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "",
+    poison: existsSync(poisonPath) ? readFileSync(poisonPath, "utf8") : "",
+  };
 }
 
 test("auto mode selects the exact package-local platform artifact", () => {
@@ -67,6 +82,72 @@ test("auto mode selects the exact package-local platform artifact", () => {
   }
 });
 
+test("supported target classification is exactly the six release targets", () => {
+  for (const platform of ["darwin", "linux", "win32"]) {
+    for (const architecture of ["x64", "arm64"]) {
+      assert.equal(isSupportedNativeTarget(platform, architecture), true, `${platform}/${architecture}`);
+    }
+  }
+  assert.equal(isSupportedNativeTarget("freebsd", "x64"), false);
+  assert.equal(isSupportedNativeTarget("linux", "riscv64"), false);
+});
+
+test("unsupported installed targets retain the explicit Bun bridge selection", () => {
+  const dir = mkdtempSync(join(tmpdir(), "ocx-native-unsupported-"));
+  try {
+    mkdirSync(join(dir, "native"));
+    assert.equal(isSupportedNativeTarget("freebsd", "x64"), false);
+    assert.equal(resolveNativeGoBinary({ here: dir, version: "2.9.0", env: {}, platform: "freebsd", architecture: "x64" }), null);
+    assert.equal(isSupportedNativeTarget("linux", "riscv64"), false);
+    assert.equal(resolveNativeGoBinary({ here: dir, version: "2.9.0", env: {}, platform: "linux", architecture: "riscv64" }), null);
+  } finally {
+    rmSync(dir, { recursive: true, force: true });
+  }
+});
+
+test("resolver rejects invalid mode, invalid override, stale artifact, and unsupported target", () => {
+  const dir = mkdtempSync(join(tmpdir(), "ocx-native-negative-"));
+  try {
+    mkdirSync(join(dir, "native"));
+    assert.throws(
+      () => resolveNativeGoBinary({ here: dir, version: "2.9.0", env: { OPENCODEX_RUNTIME: "bogus" }, platform: "linux", architecture: "amd64" }),
+      /selection must be one of/,
+    );
+    assert.throws(
+      () => resolveNativeGoBinary({ here: dir, version: "2.9.0", env: { OPENCODEX_GO_BINARY: join(dir, "missing") }, platform: "linux", architecture: "x64" }),
+      /override is not an executable file/,
+    );
+    const stale = join(dir, "native", nativeArtifactName("2.8.9", { os: "linux", arch: "amd64" }));
+    writeFileSync(stale, "stale");
+    chmodSync(stale, 0o755);
+    assert.equal(resolveNativeGoBinary({ here: dir, version: "2.9.0", env: {}, platform: "linux", architecture: "x64" }), null);
+    assert.equal(resolveNativeGoBinary({ here: dir, version: "2.9.0", env: {}, platform: "freebsd", architecture: "x64" }), null);
+  } finally {
+    rmSync(dir, { recursive: true, force: true });
+  }
+});
+
+test("resolver uses lstat, requires Unix execute bits, and accepts a regular Windows exe", { skip: process.platform === "win32" }, () => {
+  const dir = mkdtempSync(join(tmpdir(), "ocx-native-file-kind-"));
+  try {
+    mkdirSync(join(dir, "native"));
+    const unix = join(dir, "native", nativeArtifactName("2.9.0", { os: "linux", arch: "amd64" }));
+    writeFileSync(unix, "unix");
+    chmodSync(unix, 0o644);
+    assert.equal(resolveNativeGoBinary({ here: dir, version: "2.9.0", env: {}, platform: "linux", architecture: "x64" }), null);
+    chmodSync(unix, 0o755);
+    const link = join(dir, "native", nativeArtifactName("2.9.1", { os: "linux", arch: "amd64" }));
+    symlinkSync(unix, link);
+    assert.equal(resolveNativeGoBinary({ here: dir, version: "2.9.1", env: {}, platform: "linux", architecture: "x64" }), null);
+    const windows = join(dir, "native", nativeArtifactName("2.9.0", { os: "windows", arch: "amd64" }));
+    writeFileSync(windows, "windows");
+    chmodSync(windows, 0o644);
+    assert.equal(resolveNativeGoBinary({ here: dir, version: "2.9.0", env: {}, platform: "win32", architecture: "x64" }), windows);
+  } finally {
+    rmSync(dir, { recursive: true, force: true });
+  }
+});
+
 test("launcher executes an explicit Go binary and preserves argv and exit status", { skip: process.platform === "win32" }, () => {
   const dir = mkdtempSync(join(tmpdir(), "ocx-native-launcher-"));
   try {
@@ -97,27 +178,29 @@ test("forced Go runtime fails closed when its binary is unavailable", () => {
   assert.doesNotMatch(result.stderr, /Bun binary missing|bun dependency/i);
 });
 
-test("real launcher preserves all native and TypeScript selection quadrants", { skip: !hostTarget() || process.platform === "win32" }, () => {
+test("supported packaged launcher runs Go without executing poison Bun", { skip: !hostTarget() || process.platform === "win32" }, () => {
   const fixture = launcherFixture();
   try {
-    let observed = runFixture(fixture, {});
+    const observed = runFixture(fixture, {});
     assert.equal(observed.result.status, 17, observed.result.stderr);
     assert.equal(observed.invocation, "go:status --json\n", "packaged Go + no env must select Go");
+    assert.equal(observed.poison, "", "supported Go launch must not execute Bun or its installer");
+  } finally {
+    rmSync(fixture.dir, { recursive: true, force: true });
+  }
+});
 
+test("supported packaged launcher fails closed without Go and never executes poison Bun", { skip: !hostTarget() || process.platform === "win32" }, () => {
+  const fixture = launcherFixture();
+  try {
     unlinkSync(fixture.packagedGo);
-    observed = runFixture(fixture, {});
-    assert.equal(observed.result.status, 19, observed.result.stderr);
-    assert.match(observed.invocation, /^ts:.*src\/cli\/index\.ts status --json\n$/, "missing Go + no env must fall back to TypeScript");
-
-    observed = runFixture(fixture, { OPENCODEX_GO_BINARY: fixture.goOverride });
-    assert.equal(observed.result.status, 17, observed.result.stderr);
-    assert.equal(observed.invocation, "go:status --json\n", "explicit Go override must select Go");
-
-    copyFileSync(fixture.goOverride, fixture.packagedGo);
-    chmodSync(fixture.packagedGo, 0o755);
-    observed = runFixture(fixture, { OPENCODEX_RUNTIME: "ts", OPENCODEX_GO_BINARY: fixture.goOverride });
-    assert.equal(observed.result.status, 19, observed.result.stderr);
-    assert.match(observed.invocation, /^ts:.*src\/cli\/index\.ts status --json\n$/, "forced TypeScript must ignore available Go binaries");
+    for (const env of [{}, { OPENCODEX_RUNTIME: "ts" }]) {
+      const observed = runFixture(fixture, env);
+      assert.equal(observed.result.status, 1, observed.result.stderr);
+      assert.match(observed.result.stderr, /Go runtime requires the exact packaged binary/);
+      assert.equal(observed.invocation, "");
+      assert.equal(observed.poison, "", "fail-closed path must not execute Bun or its installer");
+    }
   } finally {
     rmSync(fixture.dir, { recursive: true, force: true });
   }
diff --git a/tests/cli-help.test.ts b/tests/cli-help.test.ts
index 31acc9bf..e9c26d1f 100644
--- a/tests/cli-help.test.ts
+++ b/tests/cli-help.test.ts
@@ -7,7 +7,6 @@ import { fileURLToPath } from "node:url";
 
 const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
 const cliPath = join(repoRoot, "src", "cli", "index.ts");
-const binPath = join(repoRoot, "bin", "ocx.mjs");
 
 function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
   return spawnSync(process.execPath, [cliPath, ...args], {
@@ -26,15 +25,6 @@ describe("CLI subcommand help", () => {
       expect(result.stdout.trim()).toMatch(/^opencodex \d+\.\d+\.\d+/);
       expect(result.stdout.trim().split("\n")).toHaveLength(1);
     }
-
-    const binResult = spawnSync(process.execPath, [binPath, "--version"], {
-      cwd: repoRoot,
-      env: process.env,
-      encoding: "utf8",
-    });
-    expect(binResult.status).toBe(0);
-    expect(binResult.stdout.trim()).toMatch(/^opencodex \d+\.\d+\.\d+/);
-    expect(binResult.stdout.trim().split("\n")).toHaveLength(1);
   });
 
   test("help command routes to subcommand help", () => {
diff --git a/tests/docs-bun-source-requirement.test.ts b/tests/docs-bun-source-requirement.test.ts
index a1b96889..b9fa0e43 100644
--- a/tests/docs-bun-source-requirement.test.ts
+++ b/tests/docs-bun-source-requirement.test.ts
@@ -2,8 +2,8 @@ import { expect, test } from "bun:test";
 
 /**
  * Every contributor entry point must say that building from source needs a local `bun`, and
- * must keep that separate from the bundled runtime that ships inside the npm package. Users
- * who install `ocx` never need their own Bun; contributors always do.
+ * must keep that separate from the packaged Go CLI and dormant Bun bridge in the npm package.
+ * Users who install `ocx` never need their own Bun; contributors always do.
  *
  * Each file is checked as one whole normalized paragraph rather than as scattered fragments.
  * Matching fragments independently across a whole file passes even after the explanatory
@@ -18,20 +18,23 @@ const CASES = [
     path: "../CONTRIBUTING.md",
     paragraph:
       "Source development requires the `bun` CLI on your `PATH`. The published npm package bundles its own"
-      + " Bun runtime for end users, but contributor commands such as `bun install`, `bun run test`, and"
-      + " `bun run prepush` run from your local Bun installation.",
+      + " packaged Go CLI for supported targets. Bun remains an installed but dormant bridge dependency and"
+      + " powers the explicit Bun package API, while contributor commands such as `bun install`, `bun run test`,"
+      + " and `bun run prepush` run from your local Bun installation.",
   },
   {
     path: "../README.md",
     paragraph:
       "Source development requires the `bun` CLI on your `PATH`. This is separate from the published npm"
-      + " package's bundled Bun runtime, which is used only by installed `ocx` commands.",
+      + " package: supported installed `ocx` commands launch packaged Go, while Bun remains a dormant bridge"
+      + " dependency and powers the explicit Bun package API. Contributor commands use your local Bun installation.",
   },
   {
     path: "../docs-site/src/content/docs/contributing.md",
     paragraph:
       "Source development requires the `bun` CLI on your `PATH`. The published npm package bundles its own"
-      + " Bun runtime for users, but this checkout's scripts run through your local Bun installation.",
+      + " packaged Go CLI for supported targets. Bun remains an installed but dormant bridge dependency and"
+      + " powers the explicit Bun package API, while this checkout's scripts run through your local Bun installation.",
   },
 ] as const;
 
@@ -45,7 +48,7 @@ function normalizedRequirementParagraph(text: string): string | undefined {
   return paragraph.replace(/\s+/g, " ").trim();
 }
 
-test("source development docs require a local Bun CLI while preserving the bundled-runtime distinction", async () => {
+test("source docs distinguish local Bun from packaged Go and the dormant Bun bridge", async () => {
   for (const entry of CASES) {
     const text = await Bun.file(new URL(entry.path, import.meta.url)).text();
     expect(normalizedRequirementParagraph(text)).toBe(entry.paragraph);
diff --git a/tests/install-scripts.test.ts b/tests/install-scripts.test.ts
index 1b0bf249..e0f24892 100644
--- a/tests/install-scripts.test.ts
+++ b/tests/install-scripts.test.ts
@@ -86,6 +86,7 @@ describe("install scripts", () => {
     expect(pkg.exports?.["."]?.bun).toBe("./src/index.ts");
     expect(pkg.exports?.["."]?.default).toBe("./bin/package-main.mjs");
     expect(pkg.dependencies?.zod).toBe("4.4.3");
+    expect(pkg.dependencies?.bun).toBe("1.3.14");
     expect(pkg.devDependencies?.typescript).toBe("5.9.3");
     expect(pkg.devDependencies?.["@types/bun"]).toBe("1.3.14");
     expect(pkg.scripts?.dev).toBe("bun run src/cli/index.ts start");
@@ -94,7 +95,9 @@ describe("install scripts", () => {
     expect(pkg.scripts?.["prepare:package"]).toBe("bun scripts/prepare-package.ts");
     expect(pkg.scripts?.["prepare:native-package"]).toBe("bun scripts/prepare-package.ts --native");
     expect(pkg.scripts?.["verify:native-package"]).toBe("bun scripts/prepare-package.ts --verify-pack pack.json");
+    expect(pkg.scripts?.["test:native-launcher"]).toBe("node --test scripts/ocx-native-launcher.test.mjs");
     expect(pkg.scripts?.prepack).toBe("bun run prepare:native-package && bun run prepare:package");
+    expect(pkg.files).toContain("bin");
     expect(pkg.files).toContain("assets/banner.png");
     expect(pkg.files).toContain("assets/architecture.png");
     expect(pkg.files).toContain("assets/claude-code-models.gif");
@@ -150,8 +153,9 @@ describe("install scripts", () => {
     expect(script).not.toContain("bun.sh/install.ps1");
   });
 
-  test("Node launcher handles npm self-update before starting Bun", async () => {
+  test("supported Node launcher is Go-first while Bun remains dormant for bridge recovery", async () => {
     const launcher = await readText("bin/ocx.mjs");
+    const nativeRuntime = await readText("bin/native-runtime.mjs");
 
     expect(launcher).toContain('process.argv[2] === "update"');
     expect(launcher).toContain('["install", "-g", `${PKG}@${tag}`]');
@@ -159,6 +163,14 @@ describe("install scripts", () => {
     expect(launcher).toContain("!isBunGlobalInstall()");
     expect(launcher).toContain("repairCodexShimIfNeeded()");
     expect(launcher).toContain("runNpmSelfUpdate()");
+    expect(launcher).toContain('spawnSync(goBinary, ["codex-shim", "refresh"]');
+    expect(launcher).toContain("refreshLegacyCodexShim(goBinary)");
+    expect(launcher).toContain('NATIVE_SHIM_REFRESH_GUARD = "OCX_NATIVE_SHIM_REFRESH"');
+    expect(launcher).not.toContain("OPENCODEX_SHIM_REPAIR_ACTIVE");
+    expect(launcher).toContain("!goBinary && isSupportedNativeTarget(process.platform, process.arch)");
+    expect(launcher.indexOf("const goBinary = resolveGoBinary()")).toBeLessThan(launcher.indexOf("const bun = resolveBun()"));
+    expect(nativeRuntime).toContain('import { lstatSync } from "node:fs"');
+    expect(nativeRuntime).toContain("stat.isFile() && (platform === \"win32\"");
   });
 
   test("release helper watches the workflow run it just dispatched", async () => {
diff --git a/tests/shutdown-launcher.test.ts b/tests/shutdown-launcher.test.ts
index 2ba68a2d..61bb6e51 100644
--- a/tests/shutdown-launcher.test.ts
+++ b/tests/shutdown-launcher.test.ts
@@ -1,21 +1,13 @@
 import { afterAll, describe, expect, test } from "bun:test";
 import { spawn, spawnSync, type ChildProcess } from "node:child_process";
-import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
-import { createServer } from "node:net";
+import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
 
 /**
- * Regression: `ocx start` + Ctrl-C must NOT orphan the Bun proxy.
- *
- * The bin/ocx.mjs launcher used a blocking spawnSync that did not forward signals,
- * so a signal delivered only to the launcher killed it and left the Bun child
- * serving forever (port bound, ocx.pid/runtime-port.json left behind, Codex config
- * not restored). The launcher now forwards SIGINT/SIGTERM/SIGHUP to the child and
- * waits for its graceful shutdown.
- *
- * POSIX-only (Windows has no real signal forwarding semantics) and requires `node`
- * on PATH to exercise the real launcher.
+ * The supported npm launcher is Go-only, but it is still the signal-owning
+ * parent process. A signal delivered to the launcher must reach the native
+ * child so the Go runtime can drain and run its own cleanup.
  */
 
 const BIN_OCX = join(import.meta.dir, "..", "bin", "ocx.mjs");
@@ -26,95 +18,58 @@ const spawned: ChildProcess[] = [];
 const tmpHomes: string[] = [];
 
 afterAll(() => {
-  for (const c of spawned) {
-    try { c.kill("SIGKILL"); } catch { /* already gone */ }
+  for (const child of spawned) {
+    try { child.kill("SIGKILL"); } catch { /* already gone */ }
   }
   for (const dir of tmpHomes) {
     try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
   }
 });
 
-function freePort(): Promise<number> {
-  return new Promise((resolve, reject) => {
-    const srv = createServer();
-    srv.on("error", reject);
-    srv.listen(0, "127.0.0.1", () => {
-      const addr = srv.address();
-      const port = typeof addr === "object" && addr ? addr.port : 0;
-      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
-    });
-  });
-}
-
-async function healthy(port: number): Promise<boolean> {
-  try {
-    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
-      signal: AbortSignal.timeout(800),
-    });
-    return res.ok;
-  } catch {
-    return false;
-  }
-}
-
-async function waitUntil(fn: () => Promise<boolean>, deadlineMs: number): Promise<boolean> {
+async function waitUntil(predicate: () => boolean, deadlineMs: number): Promise<boolean> {
   const end = Date.now() + deadlineMs;
   while (Date.now() < end) {
-    if (await fn()) return true;
-    await Bun.sleep(250);
+    if (predicate()) return true;
+    await Bun.sleep(50);
   }
   return false;
 }
 
-describe.skipIf(!runnable)("ocx launcher graceful shutdown", () => {
+describe.skipIf(!runnable)("ocx native launcher signal forwarding", () => {
   for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
-    test(
-      `${signal} to the launcher tears down the Bun proxy and restores Codex config (no orphan)`,
-      async () => {
-        const home = mkdtempSync(join(tmpdir(), "ocx-shutdown-"));
-        tmpHomes.push(home);
-        const port = await freePort();
-
-        // Seed a native Codex config so the proxy actually injects on start (injectCodexConfig
-        // no-ops when no config.toml exists) — this lets us prove the config is RESTORED.
-        const codexConfig = join(home, "config.toml");
-        writeFileSync(codexConfig, 'model = "gpt-5.1"\n');
-
-        const child = spawn("node", [BIN_OCX, "start", "--port", String(port)], {
-          stdio: "ignore",
-          env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: home },
-        });
-        spawned.push(child);
-
-        let exited = false;
-        child.on("exit", () => { exited = true; });
-
-        // 1. Proxy comes up + injected the Codex config (Design B root override on loopback).
-        const up = await waitUntil(() => healthy(port), 20_000);
-        expect(up).toBe(true);
-        expect(existsSync(join(home, "ocx.pid"))).toBe(true);
-        const injected = readFileSync(codexConfig, "utf8");
-        expect(injected).toContain("# Auto-injected by opencodex");
-        expect(injected).toContain(`openai_base_url = "http://127.0.0.1:${port}/v1"`);
-        expect(injected).not.toContain("model_providers.opencodex");
-
-        // 2. Signal ONLY the launcher PID (the exact orphan trigger).
-        child.kill(signal);
-
-        // 3. Launcher exits...
-        const launcherGone = await waitUntil(async () => exited, 15_000);
-        expect(launcherGone).toBe(true);
-
-        // 4. ...and the Bun proxy is gone (port freed) — the regression guard.
-        const portFreed = await waitUntil(async () => !(await healthy(port)), 10_000);
-        expect(portFreed).toBe(true);
-
-        // 5. Graceful cleanup ran: pid + runtime-port removed, Codex config restored.
-        expect(existsSync(join(home, "ocx.pid"))).toBe(false);
-        expect(existsSync(join(home, "runtime-port.json"))).toBe(false);
-        expect(readFileSync(codexConfig, "utf8")).not.toContain("opencodex");
-      },
-      45_000,
-    );
+    test(`${signal} reaches the packaged Go child`, async () => {
+      const home = mkdtempSync(join(tmpdir(), "ocx-native-signal-"));
+      tmpHomes.push(home);
+      const fakeGo = join(home, "ocx-go");
+      const ready = join(home, "ready");
+      const received = join(home, "received");
+      writeFileSync(fakeGo, `#!/bin/sh
+trap 'printf SIGINT > "$OCX_SIGNAL_RECEIVED"; exit 0' INT
+trap 'printf SIGTERM > "$OCX_SIGNAL_RECEIVED"; exit 0' TERM
+trap 'printf SIGHUP > "$OCX_SIGNAL_RECEIVED"; exit 0' HUP
+printf ready > "$OCX_SIGNAL_READY"
+while :; do sleep 1; done
+`);
+      chmodSync(fakeGo, 0o755);
+
+      const child = spawn("node", [BIN_OCX, "status"], {
+        stdio: "ignore",
+        env: {
+          ...process.env,
+          OPENCODEX_RUNTIME: "go",
+          OPENCODEX_GO_BINARY: fakeGo,
+          OCX_SIGNAL_READY: ready,
+          OCX_SIGNAL_RECEIVED: received,
+        },
+      });
+      spawned.push(child);
+      let exited = false;
+      child.on("exit", () => { exited = true; });
+
+      expect(await waitUntil(() => existsSync(ready), 5_000)).toBe(true);
+      child.kill(signal);
+      expect(await waitUntil(() => exited, 10_000)).toBe(true);
+      expect(readFileSync(received, "utf8")).toBe(signal);
+    }, 15_000);
   }
 });
```


The block is a standard three-line-context unified patch against the current
HEAD. Apply the extracted block without compatibility or recount flags:

```bash
git apply wp3.patch
```

## Activation matrix

| Conditional path | Trigger | Observable proof |
|---|---|---|
| exact supported artifact | fixture contains package-version host artifact | Go probe writes `go:status --json`; exit 17 |
| missing supported artifact | unlink exact artifact | exit 1; Go-runtime reinstall error; no poison file |
| forced TypeScript on supported target | `OPENCODEX_RUNTIME=ts` | same fail-closed result; no poison file |
| WP2 shim convergence preserved | WP2 source test seeds a legacy owned wrapper | one guarded `codex-shim refresh`, then requested Go command; no install/discovery |
| symlink rejection | exact-version path is symlink | resolver returns `null`; launcher case fails closed |
| Unix mode rejection | regular artifact mode `0644` | resolver returns `null` |
| Windows mode acceptance | regular `.exe` fixture mode `0644` | resolver returns exact `.exe` path |
| unsupported installed/source fallback | FreeBSD/x64 or Linux/riscv64 | resolver returns `null` in `auto`; Bun bridge remains eligible |
| equal native release | current == candidate | no-op text; download count zero |
| unsafe native release | older, malformed, channel-crossing, or major-crossing | error; download count zero |
| production dispatch | `Run(..., ["update", ...])` | package-local destination replaced and skew notice printed |
| launcher signals | Node launcher owns a fake Go child | SIGINT/SIGTERM/SIGHUP each reach the child and the launcher exits |

## Verification contract for implementation phase

Run in this order after sequentially applying current 011, current 021, then this
031 patch in a fresh checkout:

```bash
node --test scripts/ocx-native-launcher.test.mjs
cd go && go test ./internal/cli ./internal/update -count=1 && cd ..
bun test tests/ocx-launcher-source.test.ts tests/docs-bun-source-requirement.test.ts tests/install-scripts.test.ts tests/cli-help.test.ts tests/shutdown-launcher.test.ts
npm pack --json > pack.json
bun run verify:native-package
```

Then inspect `pack.json` and prove all of the following, not only command exit 0:

- exactly one package version appears in six native filenames plus one checksum file;
- `bin/ocx.mjs` and `bin/native-runtime.mjs` are present;
- all Unix binaries are executable and no native entry is a symlink;
- `bun` remains in `dependencies` and the package still exports `./src/index.ts`
  under the explicit `bun` condition;
- the supported host fixture succeeds with both poison paths armed and neither
  poison marker created;
- every unsafe update case records zero calls to `downloadNativeUpdate`.

Docs-only authoring proof on 2026-07-26 used a fresh checkout outside the
repository worktree: current 011 applied 4 diff fences in document order, current
021 applied 22 diff fences in document order, and the extracted 031 fence passed
plain `git apply --check` before plain `git apply`. Focused results were launcher
9/9, Go `internal/cli` and `internal/update` PASS, and the revised CLI/signal
contracts 15/15. The final full Bun suite is recorded in
`009_4_post_audit_canonical_validation.md`. No production file was edited in the
authoritative worktree for this proof.

## Implementation audit stop conditions

Stop and return to P instead of improvising if any of these is observed:

- a supported target needs Bun to pass a launcher test;
- the current build version is not a parseable release version in packaged binaries;
- a release channel intentionally promotes preview to stable in-place;
- a package-layout change is required for a proposed native-only update;
- `os.Executable()` does not resolve to the package-local binary selected by the
  Node launcher on any supported platform;
- current 011 or current 021 cannot be applied first in document order;
- WP1's staged package contract or WP2's guarded refresh contract differs from
  the post-WP1+WP2 baseline used by this appendix.
