/**
 * opencodex Download Capture — background service worker.
 *
 * `chrome.downloads.onCreated` is the earliest public hook a Manifest V3
 * extension gets for "a download just started" — there is no `onBeforeCreate`
 * that can veto one before the browser has begun writing bytes. So this
 * listener races the browser: it POSTs the download's real URL to opencodex's
 * local capture endpoint, and only on a successful queue does it cancel and
 * erase the browser's own copy, so the download exists in exactly one place —
 * opencodex's Downloading page, not two half-finished files.
 *
 * If opencodex is not reachable (not running, or captured request refused for
 * any reason) this deliberately fails OPEN: the browser's native download is
 * left completely alone rather than cancelled with nowhere for the bytes to
 * go. A user who has not started opencodex should see downloads work exactly
 * as they always have.
 *
 * ## The one real limitation, stated rather than hidden
 *
 * opencodex re-requests the URL itself, as a fresh unauthenticated `fetch()`.
 * For a public direct-download link that works exactly like clicking it in
 * the browser. For a URL that only resolves inside an authenticated session
 * (a signed-in file host, a URL carrying a short-lived signed token this
 * extension cannot see), opencodex's request can 403/404 where the browser's
 * own request would have succeeded — the same limitation every external
 * download manager (IDM, JDownloader, …) has, because none of them can see
 * the browser's cookie jar for an ordinary `downloads.onCreated` capture. See
 * `docs/FEATURE-INVENTORY.md` and the extension's own README for the honest
 * scope this leaves out.
 */

const DEFAULT_PORT = 10100;
/** Download ids this worker has already decided about — a service worker can
 *  receive the same event more than once across a restart, and re-capturing
 *  an id we already erased would be a spurious duplicate capture. */
const handled = new Set();

async function capturePort() {
  const { ocxPort } = await chrome.storage.local.get({ ocxPort: DEFAULT_PORT });
  const port = Number(ocxPort);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

function suggestedFilenameFromItem(item) {
  if (item.filename) {
    const parts = item.filename.split(/[\\/]/);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  try {
    const url = new URL(item.finalUrl || item.url);
    const last = decodeURIComponent(url.pathname.split("/").pop() || "");
    return last || undefined;
  } catch {
    return undefined;
  }
}

async function tryCapture(item) {
  const port = await capturePort();
  const body = {
    url: item.finalUrl || item.url,
    suggestedFilename: suggestedFilenameFromItem(item),
    pageUrl: item.referrer || undefined,
    mimeType: item.mime || undefined,
  };
  const res = await fetch(`http://127.0.0.1:${port}/api/downloads/capture`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok;
}

chrome.downloads.onCreated.addListener(item => {
  if (handled.has(item.id)) return;
  handled.add(item.id);
  void (async () => {
    let captured = false;
    try {
      captured = await tryCapture(item);
    } catch {
      // opencodex unreachable (not running, wrong port configured) — fail open below.
      captured = false;
    }
    if (!captured) return;
    try {
      await chrome.downloads.cancel(item.id);
    } catch {
      /* already finished or already gone — erase below still cleans it up */
    }
    try {
      await chrome.downloads.erase({ id: item.id });
    } catch {
      /* best-effort: worst case a partial/cancelled entry is left in Chrome's own download list */
    }
  })();
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});
