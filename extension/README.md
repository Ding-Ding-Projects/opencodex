# opencodex Download Capture (browser extension)

Sends this browser's downloads to the opencodex desktop app's own Downloading
page instead of saving them here, so a Start-download decision, a live
progress surface and an always-on-top completion notice all happen inside
opencodex — see `docs/FEATURE-INVENTORY.md`'s "Browser-extension download
capture" row for the full contract this implements.

## Install (unpacked — this extension is never signed or packaged as a `.crx`)

Code signing is permanently out of scope for this project (see the repository's
shared instructions), and that includes browser-extension package signatures.
This extension therefore ships only as an **unpacked** directory — the
supported, always-available Chromium install path — never as a signed `.crx`.

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer
   mode**.
2. Click **Load unpacked** and select this `extension/` directory.
3. Click the extension's toolbar icon to open its settings and confirm the
   port opencodex is listening on (the app's status bar shows it; the default
   is `10100`). **Test connection** confirms the extension can actually reach
   the running app before you rely on it.

## What it does

`background.js` listens for `chrome.downloads.onCreated` — the earliest public
hook Manifest V3 gives an extension for "a download just started". For each
one it POSTs the download's URL, suggested filename, source page and MIME type
to opencodex's local `POST /api/downloads/capture` endpoint
(`src/server/management/download-routes.ts`, loopback-gated exactly like the
PDF and converter routes). If — and only if — that capture is accepted does it
cancel and erase the browser's own copy of the download, so the file exists in
exactly one place: opencodex's Downloading page, which shows the real transfer
progress and lets you pause, resume or cancel it.

**If opencodex is not running, or the request is refused for any reason, the
capture fails open**: the browser's native download is left completely alone.
Nothing about a normal download changes when opencodex is not open.

## The one real limitation

opencodex performs its own fresh, unauthenticated `fetch()` of the captured
URL — it does not, and cannot, see this browser's cookie jar. A public direct
download link works exactly as it would in the browser. A URL that only
resolves inside a signed-in session (a file host you are logged into, a
short-lived signed link) can be refused by opencodex's request even though the
browser's own request would have succeeded. This is the same limitation every
external download manager has (IDM, JDownloader, and the rest) for the same
structural reason — none of them can read the browser's session for an
ordinary `downloads.onCreated`-based capture — and it is recorded here rather
than left for someone to discover the hard way.

## Privacy

The only network call this extension ever makes is the loopback `fetch()`
above, to the port you configured, and the `/healthz` check the options page's
**Test connection** button uses. Nothing is sent anywhere else; there is no
telemetry, no analytics and no third-party host permission.
