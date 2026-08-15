---
title: Browser-extension download capture
description: An unpacked browser extension hands downloads to opencodex's own Downloading page instead of the browser's — a real streaming transfer engine and three real surfaces, fail-open by design, with one honest gap named plainly.
---

opencodex can take over your browser's downloads: a small extension you load into Chrome or Edge
hands each one to opencodex's own **Downloading** page instead of the browser's built-in download
bar, so a Start-download decision, live transfer progress with pause/resume/cancel, and an
always-on-top completion notice all happen inside opencodex. This page covers all three pieces —
the extension, the transfer engine underneath it, and the surfaces that show you what is happening
— and, per this project's own honesty rule, exactly what has and has not actually been verified yet.

## Install (unpacked — this extension is never signed or packaged as a `.crx`)

Code signing is permanently out of scope for this project, and that includes browser-extension
package signatures. **There is no packaged, downloadable build of this extension yet** — it ships
only as source, inside the opencodex repository's `extension/` directory, loaded the same way any
unpacked Chromium extension is loaded in developer mode:

1. Get the `extension/` directory (a checkout of the opencodex repository has it).
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension/` directory.
4. Click the extension's toolbar icon to open its settings and confirm the port opencodex is
   listening on — the app's status bar shows it; the default is **10100**. **Test connection**
   confirms the extension can actually reach the running app before you rely on it.

## How a capture works

`background.js`'s service worker listens for `chrome.downloads.onCreated` — the earliest hook
Manifest V3 gives an extension for "a download just started"; there is no `onBeforeCreate` that
could veto one before the browser starts writing bytes. For each new download it POSTs the real URL,
a filename derived from the item or its URL, the source page, and the MIME type to opencodex's local
`POST /api/downloads/capture`. **Only on a 2xx response** does it `chrome.downloads.cancel` and
`.erase` the browser's own copy, so the file ends up in exactly one place — opencodex's Downloading
page — rather than as two half-finished copies.

**If opencodex is not reachable for any reason — not running, wrong port configured, the capture
request refused — this deliberately fails open.** The browser's native download proceeds completely
untouched. A user who has not started opencodex sees downloads work exactly as they always have.

## The Start-download decision dialog

A capture only ever creates a `queued` record — nothing is written to disk yet. The Start dialog is
the one and only path from `queued` into `downloading`: **Confirm** calls
`POST /api/downloads/:id/confirm` (optionally overriding the destination directory or filename, both
still sanitized), which is what actually begins the transfer; **Cancel** leaves it queued and never
started. Nothing downloads until this dialog is answered, or the CLI's `confirm` command is run.

## The Downloading page

A distinct page — not a background table row. Active transfers and finished history sit in their own
sections, with a real progress bar (indeterminate when the total is genuinely unknown, such as a
chunked response with no `Content-Length`), bytes/rate/ETA, and pause/resume/cancel/remove wired to
the real transfer. Nothing here simulates progress: every number is `bytesReceived`/`bytesTotal` read
straight off the manager's own record. The page has its own regex-capable search, like every other
list in the app.

`resumeDownload` sends a real `Range` header when a prior response has already proven the server
honours one, continuing where the transfer left off; when it does not, it correctly restarts from
byte zero — resetting the received-byte counter too, not just the file on disk.

## The completion surface

Inside the Electron desktop app, both the Start dialog and the completion notice are real OS-level
**always-on-top** popup windows (`setAlwaysOnTop(true, "screen-saver")`), not an in-app overlay, so
they can float above the actual browser window the download started in. They load the same build the
dashboard serves. The completion popup auto-dismisses after **8 seconds**, except on an `error`
result, which stays open until you close it — the same non-blocking-notification rule the rest of the
app follows.

Outside Electron (a plain browser tab open on the dashboard), there is no way for a web page to make
itself float above another application — this is stated plainly rather than pretended away. The
fallback there is the closest accessible equivalent: a non-modal anchored dialog for the Start
decision, and a notification-centre toast for completion.

## From the CLI

```bash
ocx downloads capture <url> [--name <file>] [--page <url>]   # queue a capture, as the extension would
ocx downloads list
ocx downloads show <id>
ocx downloads confirm <id> [--dir <path>] [--name <file>]    # the explicit action that starts the transfer
ocx downloads cancel <id>
ocx downloads pause <id>
ocx downloads resume <id>
ocx downloads remove <id>
```

Every subcommand is a thin client over the same `/api/downloads/*` routes the extension and the
dashboard use, with `--json` for machine-readable output — the same headless-parity discipline `ocx
pdf` and `ocx convert` already follow.

## From the API

```
POST   /api/downloads/capture        { url, suggestedFilename?, pageUrl?, mimeType? } -> DownloadRecord
GET    /api/downloads                                                                 -> { records }
GET    /api/downloads/:id                                                             -> DownloadRecord
POST   /api/downloads/:id/confirm    { destinationDir?, filename? }                   -> DownloadRecord
POST   /api/downloads/:id/cancel                                                       -> DownloadRecord
POST   /api/downloads/:id/pause                                                        -> DownloadRecord
POST   /api/downloads/:id/resume                                                       -> DownloadRecord
DELETE /api/downloads/:id                                                              -> { ok: true }
```

Every route is refused the instant the management proxy is reachable from the LAN
(`requireLoopbackListener`), the same as PDF Tools and the converter — several of these routes write
to the local filesystem. Reaching this prefix from the extension needed one deliberate, narrow
widening of the origin check: `isAllowedDownloadCaptureOrigin` accepts a `chrome-extension://` /
`moz-extension://` / `edge-extension://` Origin **only** for the `/api/downloads/*` prefix, and only
while the listener is loopback-bound. An ordinary web page's real `https://` origin is still refused
on this same prefix — that Origin value is browser-assigned to the installed extension's own
background context and cannot be forged by page-context JavaScript.

## Configuration

The only setting is the extension's own options page: the port opencodex is listening on (default
`10100`, matching the app's own default management-proxy port), saved to `chrome.storage.local`, with
a **Test connection** button that calls opencodex's `/healthz` endpoint and confirms it is actually
opencodex answering (checking the reported `service` field) rather than some other process that
happens to be listening on that port.

## Failure modes

| Symptom | Cause |
| --- | --- |
| Downloads behave exactly as before, nothing captured | opencodex is not running, or is on a different port than the extension is configured for — this is the designed fail-open behaviour, not a bug |
| A capture is refused with `invalid-url` | The URL could not be parsed |
| A capture is refused with `unsupported-protocol` | Anything other than `http:`/`https:` — `file:`, `data:`, and `blob:` are refused so a "download" can never become a local-file read |
| A capture is refused with `url-too-long` | Over 4,000 characters |
| A capture is refused with `queue-full` | The bounded download-record history is at capacity |
| A download sits in `error` | The real cause is a plain sentence on the record, never a stack trace — check `GET /api/downloads/:id` |
| A resumed download restarts from the beginning | The server did not honour a `Range` request on the retry; the byte counter is reset to match, not left stale |
| A signed-in file host's link fails to download | opencodex re-fetches the URL itself with no cookies — see the session-cookie limitation below |
| Nothing happens for 30 seconds, then it errors | `STALL_TIMEOUT_MS` — the manager gives up on a peer that stopped sending bytes |

### The one real limitation: no browser cookie jar

opencodex performs its own fresh, **unauthenticated** `fetch()` of the captured URL — it does not,
and structurally cannot, see the browser's cookie jar. A public direct-download link works exactly as
it would in the browser. A URL that only resolves inside a signed-in session (a file host you are
logged into, a short-lived signed link) can be refused by opencodex's request even though the
browser's own request would have succeeded. Every external download manager (IDM, JDownloader, and
the rest) has this same limitation for the same structural reason — none of them can read the
browser's session for an ordinary `downloads.onCreated`-based capture.

## Security considerations

- **Never signed, unpacked only.** Consistent with this project's permanent no-signing policy; there
  is no `.crx` and no extension private key anywhere in this repository.
- **Protocol allowlist.** Only `http:` and `https:` URLs are ever fetched; `file:`, `data:`, and
  `blob:` are refused outright.
- **Filename sanitization.** `sanitizeFilename` strips path separators and `..` segments (via
  `basename`), every character Windows treats specially, control characters, trailing dots/spaces,
  and rejects the Windows reserved device names (`CON`, `NUL`, `COM1`, …) — a suggested name that
  sanitizes to nothing falls back to `download`.
- **Loopback-gated mutating routes.** Capture, confirm, cancel, pause, resume, and remove all refuse
  the instant the proxy is reachable from the LAN — the same discipline PDF Tools and the converter
  use for their own filesystem-writing routes.
- **The extension-origin widening is deliberately narrow.** It applies only to the
  `/api/downloads/*` prefix, only while loopback-bound, and only to an Origin value no web page can
  forge — it is not a general relaxation of the app's CORS story.
- **Bounded history.** The download-record list caps at 300 entries and prunes the oldest *finished*
  records down to 250 when it is hit; an active transfer is never pruned out from under itself.
- **No telemetry.** The only network calls the extension itself ever makes are the loopback capture
  POST and the options page's health check. Nothing is sent anywhere else, and there is no analytics
  or third-party host permission — `host_permissions` in `manifest.json` names only
  `http://127.0.0.1/*` and `http://localhost/*`.

## Verification

- `tests/downloads-manager.test.ts` — **22 tests**, against real loopback `Bun.serve` sockets for
  every flow including pause/resume, where a second chunk is held back by a real server-side delay so
  the pause window is genuine rather than timed by guesswork. Includes the resume-from-byte-zero
  regression: an earlier version of this code left the byte counter at its stale pre-resume value on
  a non-appending restart, caught by a test asserting the post-resume count, fixed, and now watched.
- `tests/download-routes.test.ts` — **12 tests**.
- `tests/downloads-extension-origin.test.ts` — **8 tests**, including proof that the same extension
  origin is refused on an unrelated route.
- `tests/cli-downloads.test.ts` — **10 tests**.
- `gui/tests/downloads-page.test.tsx` — **6 tests**; `gui/tests/download-popup-route.test.ts` —
  **6 tests**, for the popup route parser.

All new copy is localized in both `m3.ts` and `yue.ts`, covered by `gui/tests/i18n-voice-and-locales.test.ts`.

## What has not been verified yet

**No real built-artifact capture of the three states exists.** Every claim above is proven by the
tests listed, against the real manager, routes, CLI, and React tree — and by reading the extension's
own source against the Chromium extensions platform documentation — but nobody has installed the
unpacked extension in a real browser, triggered a real download, and photographed the Start dialog,
the Downloading page, and the completion popup from that live flow. That is the single largest piece
of work this feature has left, named here rather than rounded up to done. See
`docs/FEATURE-INVENTORY.md`'s "Browser-extension download capture" row for the exact accounting.

## Suggested articles

- [PDF tools](/guides/pdf-tools) and [File converter](/guides/file-converter) — the other two
  locally-gated, filesystem-writing surfaces this feature's loopback-gating pattern is drawn from.
- [Export & bulk actions](/guides/export-and-bulk-actions) — the app's other real file-writing
  surface, including its own atomic-write discipline.
- [Web dashboard](/guides/web-dashboard) — the tabbed shell the Downloading page lives inside.
- [CLI reference](/reference/cli) — every `ocx` command, including the rest of `downloads`.
