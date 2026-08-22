---
title: Desktop updates
description: How the installed Windows desktop app checks, verifies, and applies unsigned Squirrel.Windows updates.
---

## What the installed app does

The installed Windows desktop app uses Electron's built-in Squirrel.Windows updater. It checks
once at startup and again on a bounded six-hour schedule. Source checkouts and browser sessions do
not start this updater. The dashboard can also request a manual check through its desktop bridge.

The feed is restricted to exact HTTPS project shapes: the versioned
`update.electronjs.org/Ding-Ding-Projects/opencodex/win32-x64/<version>/` path, the project's
`releases/latest/download/` directory, or one tagged `releases/download/<tag>/` directory. User
info, ports, search strings, fragments, encoded path components, and path-normalization tricks are
rejected before Electron is called. The small `assertAllowedDesktopFeed` and RELEASES/package
helpers are source-level checks for configuration and test coverage; the production Electron and
Squirrel.Windows updater remains authoritative for release-index parsing, package download,
SHA-1/size verification, and the replacement transaction. A malformed index, a package whose hash
or size does not match, an offline host, and an unexpected updater error remain visible as distinct
states.

## User-visible states

The dashboard keeps a non-blocking banner for an available, downloading, ready, failed, offline,
cancelled, or corrupt update. A ready banner names the exact version, links to its release notes,
warns that the Squirrel.Windows artifact is unsigned and may trigger an Unknown Publisher or
SmartScreen warning, and offers **Restart to install update** plus **Later**.

The app never restarts itself when a download finishes. Restarting is an explicit action. The
desktop shell asks the user to save work before calling `quitAndInstall`, and cancellation leaves
the current app running. If installation is not ready, the bridge refuses the action instead of
pretending that a restart happened.

## Offline and recovery behavior

An unavailable feed does not stop the proxy or disable the dashboard. The updater backend is
registered before proxy startup, so even a proxy startup failure leaves the recovery shell, state
IPC, manual retry, and bounded schedule available. If initial feed setup or a first check throws,
the failed state is published, a later manual start/check retries, and the schedule remains active.
The banner reports the offline state and offers a retry. A failed or corrupt package likewise leaves
the current install untouched; the user can retry after the release feed is repaired. No signing
certificate or signing secret is used: release installers and update packages are intentionally
unsigned.

## Verification boundary

Focused tests cover the allowlisted feed boundary, fake Squirrel event transport, startup versus
scheduled checks, cancellation, corrupt/hash failures, explicit installation, and the ready banner
actions. The actual installed artifact still needs a packaged Windows run against a published
release asset to prove the full Electron/Squirrel download and replacement path; source tests do
not claim that artifact-only proof.
