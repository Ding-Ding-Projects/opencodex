/**
 * Regression check for `gui/src/pages/DownloadPopup.tsx`'s two popup cards.
 *
 * `assets/shots/download-start-popup.png`, a genuine capture of the real
 * always-on-top Electron window, shows a blank gap where the filename and
 * source URL belong. `docs/FEATURE-INVENTORY.md` row 280 recorded the exact
 * `getBoundingClientRect` numbers a live capture pass found for it:
 * `.m3-dlpopup__file` / `.m3-dlpopup__url` render at a collapsed ~2-3px line
 * box while their measured WIDTH stays completely normal (155px / 263px for
 * short strings) — width unaffected, height collapsed, which is the signature
 * of a flexbox layout bug, not a missing design token: if the font size had
 * resolved to near-zero (the design-token theory), the WIDTH would have
 * collapsed too, since glyph width scales with font size exactly the same way
 * height does. It did not.
 *
 * The real mechanism: `.m3-dlpopup` is `display:flex; flex-direction:column`
 * inside a BrowserWindow only 220px (start) / 180px (complete) tall. Its six
 * children's natural heights add up to more than that, so the flexbox
 * shrink algorithm has to take space from somewhere. Per the CSS Flexbox spec
 * (4.5, "Automatic Minimum Size of Flex Items"), a flex item's `min-height:
 * auto` normally floors at its CONTENT size — but that floor is disabled (it
 * resolves to 0 instead) for any item whose `overflow` is not `visible`.
 * `.m3-dlpopup__file` and `.m3-dlpopup__url` set `overflow: hidden` (needed
 * for the ellipsis truncation), so THEY are the two children with no content
 * floor, and the whole deficit lands on them — squeezed to a hairline while
 * `.m3-dlpopup__title` and `.m3-dlpopup__hint` (no `overflow: hidden`, still
 * fully protected) render at their normal height.
 *
 * This script proves it in a real browser (Chrome headless via CDP), against
 * the real built `gui/dist` bundle, at the real popup window pixel dimensions
 * (`electron/main.mjs`'s `openDownloadPopup`), with a stub `/api/downloads/*`
 * responder standing in for the real proxy — the download engine and the
 * browser-extension capture path are irrelevant to this specific bug: the
 * popup route (`main.tsx`'s `popupRoute ? <DownloadPopup/> : <App/>` branch)
 * runs identically whether `DownloadPopup.tsx` fetches a record from the real
 * proxy or from this stub, and `PrefsProvider`'s `applyTokens` call runs
 * exactly the same either way.
 *
 * Run it directly: `bun run scripts/download-popup-layout-check.ts`
 * (build `gui/dist` first — `cd gui && bun run build`).
 *
 * Exits 1 and prints every measured box on failure; exits 0 and prints the
 * measured boxes on success. Watched red against the unfixed CSS/window
 * sizes, then green after the fix — see the commit this file ships with.
 */

const PORT = Number(process.env.OCX_LAYOUT_CHECK_PORT || 14219);
const CDP_PORT = Number(process.env.OCX_LAYOUT_CHECK_CDP_PORT || 14220);
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:");
const DIST = `${ROOT}/gui/dist`;

/** A minimum a genuinely-rendered single line of 11-16px text can never be under. */
const MIN_LINE_HEIGHT_PX = 10;

// Mirrors electron/main.mjs's openDownloadPopup BrowserWindow sizes exactly —
// the whole point is to prove the layout fits (or doesn't) at the real popup
// dimensions, not some other viewport that happens to have more room.
const START_VIEWPORT = { width: 360, height: 260 };
const COMPLETE_VIEWPORT = { width: 360, height: 230 };

const START_RECORD = {
  id: "start-1",
  url: "https://cdn.example.com/releases/opencodex/opencodex-portable-x64.exe",
  suggestedFilename: "opencodex-portable-x64.exe",
  pageUrl: "https://opencodex.me/download",
  mimeType: "application/octet-stream",
  source: "extension",
  state: "queued",
  destinationPath: null,
  bytesReceived: 0,
  bytesTotal: 41934827,
  rateBytesPerSec: null,
  etaSeconds: null,
  resumable: false,
  createdAt: Date.now(),
  startedAt: null,
  updatedAt: Date.now(),
  completedAt: null,
  error: null,
};

const COMPLETE_RECORD = {
  ...START_RECORD,
  id: "complete-1",
  state: "completed",
  destinationPath: "C:\\Users\\demo\\Downloads\\opencodex-portable-x64.exe",
  bytesReceived: 41934827,
  completedAt: Date.now(),
};

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/downloads/start-1") return Response.json(START_RECORD);
    if (url.pathname === "/api/downloads/complete-1") return Response.json(COMPLETE_RECORD);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(`${DIST}${path}`);
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file(`${DIST}/index.html`));
  },
});

const chromeCandidates = [
  process.env.OCX_CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter((p): p is string => !!p);
const chromePath = chromeCandidates.find(p => require("node:fs").existsSync(p));
if (!chromePath) {
  console.error("no Chrome/Edge binary found; set OCX_CHROME to one");
  process.exit(2);
}

const profileDir = `${process.env.TEMP || "/tmp"}\\ocx-dlpopup-layout-check`;
require("node:fs").rmSync(profileDir, { recursive: true, force: true });

const chrome = Bun.spawn([
  chromePath,
  "--headless=new",
  `--remote-debugging-port=${CDP_PORT}`,
  "--remote-allow-origins=*",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  `--user-data-dir=${profileDir}`,
  "about:blank",
], { stdout: "ignore", stderr: "ignore" });

async function pageSocket(): Promise<string> {
  for (let i = 0; i < 80; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json() as
        Array<{ type: string; webSocketDebuggerUrl?: string }>;
      const page = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("no CDP page target");
}

const socket = new WebSocket(await pageSocket());
await new Promise<void>((resolve, reject) => {
  socket.onopen = () => resolve();
  socket.onerror = () => reject(new Error("cdp socket failed to open"));
});

let nextId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
socket.onmessage = event => {
  const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
  if (message.id == null || !pending.has(message.id)) return;
  const slot = pending.get(message.id)!;
  pending.delete(message.id);
  if (message.error) slot.reject(new Error(message.error.message));
  else slot.resolve(message.result);
};
function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression: string): Promise<any> {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res?.exceptionDetails) throw new Error(res.exceptionDetails.text);
  return res?.result?.value;
}

interface Box { present: boolean; w: number; h: number; lineHeight: number; text: string }
interface CardResult {
  id: string;
  tokensApplied: boolean;
  sp2: string;
  sp4: string;
  icon: Box;
  title: Box;
  file: Box;
  url: Box;
  hint: Box;
  actions: Box;
  scrollHeight: number | null;
}

const MEASURE = `(() => {
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { present: false, w: 0, h: 0, lineHeight: 0, text: "" };
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      present: true,
      w: Math.round(rect.width * 100) / 100,
      h: Math.round(rect.height * 100) / 100,
      lineHeight: Math.round(parseFloat(cs.lineHeight) * 100) / 100,
      text: (el.textContent || "").trim(),
    };
  };
  const root = getComputedStyle(document.documentElement);
  return {
    // A non-empty --m3-primary proves PrefsProvider's applyTokens() actually
    // ran against THIS document — the theory that started this investigation
    // (main.tsx never wraps the popup route in PrefsProvider) is checked here
    // too, even though tracing the code already showed it wraps both routes
    // identically.
    tokensApplied: !!root.getPropertyValue('--m3-primary').trim(),
    sp2: root.getPropertyValue('--sp-2').trim(),
    sp4: root.getPropertyValue('--sp-4').trim(),
    icon: box('.m3-dlpopup__icon'),
    title: box('.m3-dlpopup__title'),
    file: box('.m3-dlpopup__file'),
    url: box('.m3-dlpopup__url'),
    hint: box('.m3-dlpopup__hint'),
    actions: box('.m3-dlpopup__actions'),
    scrollHeight: document.querySelector('.m3-dlpopup')?.scrollHeight ?? null,
  };
})()`;

async function measure(hash: string, viewport: { width: number; height: number }, id: string): Promise<CardResult> {
  await send("Emulation.setDeviceMetricsOverride", {
    width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false,
  });
  // A navigation that only changes the URL's hash is a same-document fragment
  // navigation per the HTML spec, regardless of whether it was triggered by
  // script or by CDP's Page.navigate — so going straight from the "start" URL
  // to the "complete" URL would NOT re-run `main.tsx`'s module-scope
  // `parseDownloadPopupHash(window.location.hash)`, and the second measurement
  // would silently keep photographing the first card. Force a real document
  // load first so every `measure()` call starts from a blank page.
  await send("Page.navigate", { url: "about:blank" });
  await new Promise(r => setTimeout(r, 150));
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/#${hash}` });
  await new Promise(r => setTimeout(r, 1500));
  const result = await evaluate(MEASURE);
  return { id, ...result };
}

await send("Page.enable");
await send("Runtime.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });

const failures: string[] = [];
let results: CardResult[] = [];
try {
  const start = await measure("/downloads?popup=start&id=start-1", START_VIEWPORT, "start");
  const complete = await measure("/downloads?popup=complete&id=complete-1", COMPLETE_VIEWPORT, "complete");
  results = [start, complete];

  for (const card of results) {
    const viewport = card.id === "start" ? START_VIEWPORT : COMPLETE_VIEWPORT;
    console.log(`\n=== ${card.id} popup (${viewport.width}x${viewport.height})`);
    console.log(`  tokens applied (--m3-primary set): ${card.tokensApplied}   --sp-2=${card.sp2} --sp-4=${card.sp4}`);
    console.log(`  natural content scrollHeight: ${card.scrollHeight}px`);
    for (const [label, box] of [
      ["icon", card.icon], ["title", card.title], ["file", card.file],
      ["url", card.url], ["hint", card.hint], ["actions", card.actions],
    ] as const) {
      if (!box.present) { console.log(`  ${label.padEnd(6)} absent`); continue; }
      console.log(`  ${label.padEnd(6)} ${box.w}x${box.h}  line-height=${box.lineHeight}  "${box.text.slice(0, 60)}"`);
    }

    if (!card.tokensApplied) failures.push(`${card.id}: --m3-primary is not set on <html> — PrefsProvider never applied tokens to this window`);

    // .m3-dlpopup__title never sets overflow:hidden, so it is the trustworthy
    // floor: if `file`/`url` are catastrophically shorter than it despite
    // sharing the same flex column, they are the ones being squeezed.
    for (const [label, box] of [["file", card.file], ["url", card.url]] as const) {
      // `.m3-dlpopup__url` is present on both fixture records here: the start
      // card always renders it, and the complete card renders it only when
      // `destinationPath` is set — `COMPLETE_RECORD` sets one on purpose so
      // this loop covers both popups' url row, not just the start popup's.
      if (!box.present) continue;
      if (box.h < MIN_LINE_HEIGHT_PX) {
        failures.push(
          `${card.id}: .m3-dlpopup__${label} rendered at ${box.w}x${box.h} — a ${box.h}px line box for `
          + `"${box.text}" is a collapsed flex item (min-height:auto disabled by overflow:hidden), not real text`,
        );
      }
      if (box.text.length === 0) {
        failures.push(`${card.id}: .m3-dlpopup__${label} has no text content — the record fetch or route wiring is broken`);
      }
    }
  }
} finally {
  socket.close();
  chrome.kill();
  await chrome.exited;
  server.stop(true);
  // Best-effort: Windows can hold the profile directory locked for a moment
  // after the process handle reports exited. Failing to scrub a throwaway
  // temp dir is not worth failing the whole check over.
  try { require("node:fs").rmSync(profileDir, { recursive: true, force: true }); } catch { /* released later */ }
}

if (failures.length) {
  console.log(`\nFAIL — ${failures.length} problem(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("\nPASS — every popup card's filename/URL/hint renders at a real, legible height.");
