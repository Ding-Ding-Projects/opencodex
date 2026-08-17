/**
 * Measure the compact bottom nav's real geometry at a phone width, in bilingual
 * mode, in a real engine — and fail if any label collides with its neighbour or
 * runs off the edge of the screen.
 *
 * ## The defect this guards
 *
 * `.m3-bottom-nav` is a CSS grid of four `1fr` tracks (`gui/src/shell/page-meta.ts`'s
 * `BOTTOM_NAV_PAGES`). `.m3-nav-label` already declares
 * `overflow: hidden; text-overflow: ellipsis`, but a grid item's `min-width`
 * defaults to `auto` — "never shrink below your own content" — so at bilingual
 * widths ("Codex Auth · Codex 登入" and friends) every item grew past its track
 * instead of clipping. The labels ran into each other with no gap and the
 * fourth fell off the right edge of the screen. Invisible in English, where the
 * labels are short enough to fit inside `auto`'s refusal to shrink.
 *
 * ## Why this is a script and not a `bun test`
 *
 * happy-dom, which the unit suite runs on, has no layout engine — every
 * `getBoundingClientRect` it returns is a stub (see the doc comment atop
 * `gui/tests/mobile-shell.test.tsx`). A test built on that stub cannot tell a
 * working `min-width: 0` from a deleted one; it can only confirm the CSS text
 * is present, which is true whether or not the rule does anything. So this
 * measures the actual boxes a browser lays out, the same way
 * `scripts/touch-target-audit.ts` measures real hit areas instead of grepping
 * for `48px`.
 *
 * ## Running it
 *
 *   bun run build:gui                              # dist must reflect the CSS under test
 *   bun run scripts/bottom-nav-overflow-audit.ts
 *
 * Exits 0 and prints the measured geometry on success. Exits 1 with the exact
 * overlapping or off-screen items on failure — this is a pass/fail gate, not
 * only a report.
 */

import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.AUDIT_PORT ?? 4322);
const CDP_PORT = Number(process.env.AUDIT_CDP_PORT ?? 9337);
/**
 * 320, not the 393 `mobile.png` is actually captured at: this is the app's
 * documented floor ("the strip, the menus and the anchored editors below now
 * hold up at 320px" — `gui/tests/mobile-shell.test.tsx`), and the harsher of
 * the two widths. A bar that fits at 320 fits at every wider phone too.
 */
const WIDTH = Number(process.env.AUDIT_WIDTH ?? 320);
const HEIGHT = 720;
/** Subpixel rounding slack. Real layout is not always integer pixels. */
const EPS = 0.5;

const ROOT_DIR = process.env.AUDIT_ROOT ?? "gui/dist";
if (!existsSync(ROOT_DIR)) {
  console.error(`${ROOT_DIR} does not exist — run \`bun run build:gui\` first.`);
  process.exit(1);
}

const BASE = process.env.AUDIT_BASE ?? `http://127.0.0.1:${PORT}`;
const server = process.env.AUDIT_BASE ? null : Bun.serve({
  port: PORT,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = Bun.file(`${ROOT_DIR}${path === "/" ? "/index.html" : path}`);
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file(`${ROOT_DIR}/index.html`));
  },
});

const CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const chromePath = CHROME_PATHS.find(existsSync);
if (!chromePath) {
  console.error(`no Chrome found at any of: ${CHROME_PATHS.join(", ")}`);
  process.exit(1);
}

const profileDir = mkdtempSync(join(tmpdir(), "ocx-bottomnav-audit-"));
const chrome = Bun.spawn([
  chromePath,
  "--headless=new",
  `--remote-debugging-port=${CDP_PORT}`,
  "--remote-allow-origins=*",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  `--window-size=${WIDTH},${HEIGHT}`,
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
  throw new Error("no page target");
}

const socket = new WebSocket(await pageSocket());
await new Promise<void>((resolve, reject) => {
  socket.onopen = () => resolve();
  socket.onerror = () => reject(new Error("cdp socket failed"));
});

let nextId = 0;
const pending = new Map<number, (value: any) => void>();
socket.onmessage = event => {
  const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)!(message.result);
    pending.delete(message.id);
  }
};
function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise(resolve => pending.set(id, resolve));
}
async function evaluate(expression: string): Promise<any> {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res?.exceptionDetails) throw new Error(res.exceptionDetails.text || "page threw");
  return res?.result?.value;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Rect { left: number; right: number; top: number; bottom: number; width: number; height: number }
interface NavItem { page: string; label: string; rect: Rect; labelRect: Rect }
interface Measured {
  found: boolean;
  windowWidth: number;
  containerRect: Rect | null;
  items: NavItem[];
}

const MEASURE = `(() => {
  const toRect = (r) => ({
    left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
  });
  const container = document.querySelector('.m3-bottom-nav');
  if (!container) return { found: false, windowWidth: window.innerWidth, containerRect: null, items: [] };
  const items = [...container.querySelectorAll(':scope > .m3-nav-item, :scope > .m3-nav-entry > .m3-nav-item')];
  return {
    found: true,
    windowWidth: window.innerWidth,
    containerRect: toRect(container.getBoundingClientRect()),
    items: items.map(el => {
      const label = el.querySelector('.m3-nav-label');
      return {
        page: el.getAttribute('data-page') || '(no data-page)',
        label: (label && label.textContent || '').trim(),
        rect: toRect(el.getBoundingClientRect()),
        labelRect: toRect((label || el).getBoundingClientRect()),
      };
    }),
  };
})()`;

let failed = false;
const fail = (msg: string) => { console.error(`  FAIL  ${msg}`); failed = true; };

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  // Without this the audit happily measures a bundle from three builds ago.
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });

  // First load establishes the origin so localStorage can be written. A SECOND
  // `Page.navigate` to the identical URL is a no-op same-document navigation —
  // the hash does not change, so Chrome never reloads the document and the
  // locale, read once at boot, stays English. `Page.reload` is what
  // `scripts/capture-shots.ts`'s own `primeProfile()` uses for exactly this
  // reason, and it is what actually re-runs `detectInitial()` against the
  // freshly written `localStorage`.
  await send("Page.navigate", { url: `${BASE}/#dashboard` });
  await sleep(1200);
  await evaluate(`
    (() => {
      localStorage.setItem("ocx-m3:onboarding", JSON.stringify({ completed: true, at: 1 }));
      localStorage.setItem("ocx-lang", "bi");
      return true;
    })()`);
  await send("Page.reload", { ignoreCache: true });
  await sleep(2500);

  // Verify the locale actually took, rather than trusting the write. A silent
  // fallback to English would make every check below pass for the wrong
  // reason — short English labels never collide at 320px, bilingual ones do.
  const locale = await evaluate(`localStorage.getItem("ocx-lang")`);
  if (locale !== "bi") {
    console.error(`localStorage read back "${locale}", expected "bi" — the reload did not take`);
    process.exit(1);
  }

  const result = await evaluate(MEASURE) as Measured;

  console.log(`bottom-nav-overflow-audit  viewport ${WIDTH}x${HEIGHT}  bilingual`);

  if (!result.found) {
    fail("no .m3-bottom-nav in the DOM — is windowClass actually 'compact' at this width?");
  } else {
    const { windowWidth, containerRect, items } = result;
    console.log(`  window width ${windowWidth}px, container ${containerRect!.left.toFixed(1)}..${containerRect!.right.toFixed(1)} (${containerRect!.width.toFixed(1)}px wide)`);
    console.log(`  ${items.length} nav item(s):`);
    for (const item of items) {
      console.log(`    ${item.page.padEnd(12)} "${item.label}"  box ${item.rect.left.toFixed(1)}..${item.rect.right.toFixed(1)}  label ${item.labelRect.left.toFixed(1)}..${item.labelRect.right.toFixed(1)}`);
    }

    if (items.length < 2) {
      fail(`expected multiple bottom-nav items, found ${items.length}`);
    }

    const byLeft = [...items].sort((a, b) => a.rect.left - b.rect.left);

    // Each item's own box must not run past the right edge of the window —
    // this is the "fourth one fell off the screen" half of the defect.
    for (const item of byLeft) {
      if (item.rect.right > windowWidth + EPS) {
        fail(`"${item.label}" (${item.page}) extends to x=${item.rect.right.toFixed(1)}, past the ${windowWidth}px viewport by ${(item.rect.right - windowWidth).toFixed(1)}px`);
      }
    }

    // No two items' boxes may overlap — that is the "ran into each other with
    // no gap" half. `.m3-bottom-nav` now declares a small `column-gap`, so
    // adjacent tracks should sit apart rather than touching — but the bound
    // here is deliberately just "not overlapping" (right <= next.left),
    // never "gap is exactly N px": a genuinely zero gap is still a pass, so
    // this keeps working if the gap value is ever retuned.
    for (let i = 0; i < byLeft.length - 1; i++) {
      const a = byLeft[i], b = byLeft[i + 1];
      if (a.rect.right > b.rect.left + EPS) {
        fail(`"${a.label}" (${a.page}) overlaps "${b.label}" (${b.page}) by ${(a.rect.right - b.rect.left).toFixed(1)}px`);
      }
      if (a.labelRect.right > b.labelRect.left + EPS) {
        fail(`the LABEL TEXT of "${a.label}" (${a.page}) overlaps the label of "${b.label}" (${b.page}) by ${(a.labelRect.right - b.labelRect.left).toFixed(1)}px — this is the exact symptom reported ("labels ran into each other with no gap")`);
      }
    }

    // Each label must stay inside its own item's box — proves the ellipsis is
    // actually constrained rather than merely declared.
    for (const item of items) {
      if (item.labelRect.right > item.rect.right + EPS) {
        fail(`the label of "${item.label}" (${item.page}) spills ${(item.labelRect.right - item.rect.right).toFixed(1)}px past the right edge of its own nav item`);
      }
    }
  }
} finally {
  socket.close();
  chrome.kill();
  server?.stop(true);
}

if (failed) {
  console.error("\nbottom-nav-overflow-audit: FAILED — see above");
  process.exit(1);
}
console.log("\nbottom-nav-overflow-audit: every bottom-nav label stays inside its own track and on screen");
process.exit(0);
