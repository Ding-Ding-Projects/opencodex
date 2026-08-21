---
title: Desktop updates
description: How the installed Windows desktop app checks, verifies, and applies unsigned Squirrel.Windows updates.
---

## What the installed app does

The installed Windows desktop app uses Electron's built-in Squirrel.Windows updater. It checks
once at startup and again on a bounded six-hour schedule. Source checkouts and browser sessions do
not start this updater. The dashboard can also request a manual check through its desktop bridge.

The feed is restricted to the HTTPS `update.electronjs.org` endpoint for this project (with a direct
GitHub release path allowed for controlled testing). Electron's update service resolves the current
project release assets, while Electron and Squirrel own the `RELEASES` parsing, package download,
SHA-1/size verification, and replacement transaction;
the desktop shell only exposes the resulting state. A malformed index, a package whose hash or size
does not match, an offline host, and an unexpected updater error remain visible as distinct states.

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

An unavailable feed does not stop the proxy or disable the dashboard. The banner reports the
offline state and offers a retry. A failed or corrupt package likewise leaves the current install
untouched; the user can retry after the release feed is repaired. No signing certificate or signing
secret is used: release installers and update packages are intentionally unsigned.

## Verification boundary

Focused tests cover the allowlisted feed boundary, fake Squirrel event transport, startup versus
scheduled checks, cancellation, corrupt/hash failures, explicit installation, and the ready banner
actions. The actual installed artifact still needs a packaged Windows run against a published
release asset to prove the full Electron/Squirrel download and replacement path; source tests do
not claim that artifact-only proof.
