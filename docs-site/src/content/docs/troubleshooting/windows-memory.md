---
title: Windows Memory Growth
description: How the packaged Go runtime avoids the Bun proxy memory issue on supported Windows installs, and when Bun can still run.
---

Supported Windows npm installations now run the exact package-local Go binary on both x64 and arm64.
The small Node launcher validates that binary before starting the proxy. As a result, the normal
installed proxy no longer runs inside Bun and is not exposed to the Bun-native memory growth reported
in issue [#314](https://github.com/lidge-jun/opencodex/issues/314).

This is a runtime replacement, not a claim that the upstream Bun bugs were fixed. It also does not mean
the npm package has removed every Bun-related file or dependency.

## When Bun can still run

The `bun` dependency remains installed but dormant during ordinary commands on supported Windows hosts.
It is retained for a few bounded compatibility paths:

- an older `ocx update` implementation installing the package that switches the runtime to Go;
- a one-time refresh of a legacy Codex shim, after the packaged Go artifact has already been validated;
- callers that explicitly use opencodex's Bun package API;
- the compatibility bridge on an unsupported OS/architecture target; and
- source development, which still uses a locally installed Bun CLI.

Memory behavior on those paths is still Bun behavior. Removing the dependency is deferred until the
old-updater and legacy-shim migration window can be closed; the Go cutover does not claim otherwise.

## The historical Bun issue

Older installed versions ran the proxy on bundled Bun 1.3.14. Long Windows streaming sessions could
grow to many gigabytes of RSS because of upstream runtime behavior rather than a JavaScript-level leak
in opencodex:

| Bun issue | State (checked 2026-07-23) |
|---|---|
| [#28035](https://github.com/oven-sh/bun/issues/28035) — `fetch()` receive backpressure not coupled to JS consumption | Fixed by [PR #29831](https://github.com/oven-sh/bun/pull/29831); the first carrying release was not verified for the old bundled runtime |
| [#32111](https://github.com/oven-sh/bun/issues/32111) — crash when a client aborts an async-pull stream | Fix [PR #32120](https://github.com/oven-sh/bun/pull/32120) merged 2026-06-21; the crash was not Windows-specific |
| [PR #31654](https://github.com/oven-sh/bun/pull/31654) — `node:net` socket handle leak | Still open when last checked |

The previous watchdog, runtime diagnostics, and alternate stream mode remain useful when intentionally
running a Bun bridge or an older release, but they are mitigations for that runtime rather than the
normal supported npm path.

## What to check

Run `ocx --version` and `ocx doctor` from the installed package. On Windows x64 or arm64, a current npm
package should select its exact Go artifact. If it reports a compatibility bridge, first confirm that
the package and host architecture match and reinstall the same release channel:

```powershell
npm install -g @bitkyc08/opencodex@latest
# or, if this installation follows preview:
npm install -g @bitkyc08/opencodex@preview
```

Do not install a separate Bun runtime to repair a missing or invalid Go artifact. Supported packaged
launches fail closed instead of silently falling back to Bun. Please report the package version, Windows
architecture, launcher error, and the scalar-only memory section from `ocx doctor` on
[#314](https://github.com/lidge-jun/opencodex/issues/314); do not include tokens, request bodies, or
account identifiers.
