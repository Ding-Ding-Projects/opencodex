/**
 * Measure every interactive element's real hit area at 320px, in a real engine.
 *
 * Grepping the stylesheets for `44px` cannot answer this question. Half those
 * hits are visual sizes that are not targets at all (a switch thumb, a brand
 * image, a pill), and the ones that ARE targets may already be fine because the
 * hit area is extended by padding rather than by the box's declared height.
 * Only layout knows which is which, so this loads the built dashboard in
 * headless Chrome, walks the DOM, and reports what a finger would actually get.
 *
 * ## What it measures, and what it cannot see
 *
 * `getBoundingClientRect()` includes padding, and the audit measures the nearest
 * `.m3-check-hit` wrapper when there is one — a checkbox delegates its target to
 * that wrapper, because padding does not apply to a replaced element.
 *
 * It does NOT see a pseudo-element overlay stretched past the element's own box.
 * `.ap-picker__swatch::after { inset: -8px }` is exactly that: a 32px swatch with
 * a 48px target this script reports as 32. An earlier version of this comment
 * claimed no such rule existed in the codebase, which was simply wrong — check
 * before believing a clean run on a control you know is small.
 *
 * ## Running it
 *
 *   bun run scripts/touch-target-audit.ts '#dashboard' '#settings'
 *
 * With a proxy already running, point it at one so routes have real data —
 * ideally a sandboxed one, which will not reconfigure the machine:
 *
 *   OPENCODEX_HOME=/tmp/throwaway OPENCODEX_DEBUG_SANDBOX=1 ocx start
 *   AUDIT_BASE=http://localhost:10100 bun run scripts/touch-target-audit.ts '#models'
 *
 * With no `AUDIT_BASE` it serves `gui/dist` statically, which renders the shell
 * but not the data-bearing rows.
 *
 * Elements that are invisible, zero-sized, or `disabled` are skipped: a control
 * nobody can reach is not a target, and a closed dialog's buttons are still in
 * the DOM in this app.
 */

const PORT = 4319;
const CDP_PORT = 9334;
/** Material's minimum, in CSS px at a 1x scale factor. */
const MIN = 48;
const ROUTES = process.argv.slice(2).length ? process.argv.slice(2) : ["#dashboard"];

/** Serve from the live proxy when one is running, so routes have real data. */
const BASE = process.env.AUDIT_BASE ?? `http://127.0.0.1:${PORT}`;
const server = process.env.AUDIT_BASE ? null : Bun.serve({
  port: PORT,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = Bun.file(`gui/dist${path === "/" ? "/index.html" : path}`);
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file("gui/dist/index.html"));
  },
});

const chrome = Bun.spawn([
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "--headless=new",
  `--remote-debugging-port=${CDP_PORT}`,
  "--remote-allow-origins=*",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--window-size=320,720",
  `--user-data-dir=${process.env.TEMP}\\ocx-touch-audit`,
  "about:blank",
], { stdout: "ignore", stderr: "ignore" });

async function pageSocket(): Promise<string> {
  for (let i = 0; i < 80; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json() as
        Array<{ type: string; webSocketDebuggerUrl?: string }>;
      const page = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up */ }
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
  return res?.result?.value;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
// Without this the audit happily measures a bundle from three builds ago and
// reports a fix as missing — which it did.
await send("Network.setCacheDisabled", { cacheDisabled: true });
// Emulate the narrow viewport rather than trusting --window-size, which the
// headless shell does not always honour exactly.
await send("Emulation.setDeviceMetricsOverride", {
  width: 320, height: 720, deviceScaleFactor: 1, mobile: true,
});
// The 48dp floor is behind `@media (pointer: coarse)`, so an audit that did not
// emulate touch would measure the desktop layout and report the floor missing.
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });

const MEASURE = `(() => {
  const SELECTOR = [
    'button', 'a[href]', 'input:not([type=hidden])', 'select', 'textarea',
    '[role=button]', '[role=switch]', '[role=tab]', '[role=checkbox]',
    '[role=menuitem]', '[role=option]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const visible = node => {
    for (let el = node; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      if (el.hasAttribute('aria-hidden') || el.hasAttribute('hidden') || el.inert) return false;
    }
    return true;
  };

  const label = node => {
    const text = (node.getAttribute('aria-label') || node.textContent || '').trim().replace(/\\s+/g, ' ');
    return text.slice(0, 40) || '(no label)';
  };
  const where = node => {
    const cls = (node.getAttribute('class') || '').split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
    return node.tagName.toLowerCase() + (cls ? '.' + cls : '');
  };

  const out = [];
  for (const node of document.querySelectorAll(SELECTOR)) {
    if (node.disabled) continue;
    if (!visible(node)) continue;
    // A control may delegate its hit area to a dedicated wrapper — the pattern
    // a checkbox needs, since padding does not apply to a replaced element.
    // Measuring the input there reports 18x18 and is simply wrong about what a
    // finger gets, so measure the wrapper when there is one.
    const target = node.closest('.m3-check-hit') || node;
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const w = Math.round(rect.width * 10) / 10;
    const h = Math.round(rect.height * 10) / 10;
    if (w >= ${MIN} && h >= ${MIN}) continue;
    out.push({ w, h, sel: where(node), label: label(node) });
  }
  return { total: document.querySelectorAll(SELECTOR).length, small: out };
})()`;

try {
  for (const route of ROUTES) {
    await send("Page.navigate", { url: `${BASE}/${route}` });
    // Let the shell render and its data fetches fail; a failed fetch still
    // renders the surrounding chrome, which is what is being measured.
    await new Promise(r => setTimeout(r, Number(process.env.AUDIT_SETTLE_MS ?? 4_000)));
    const result = await evaluate(MEASURE) as { total: number; small: Array<{ w: number; h: number; sel: string; label: string }> };
    console.log(`\n=== ${route}  (${result.total} interactive elements)`);
    if (!result.small.length) { console.log("  every reachable target is at least 48x48"); continue; }
    // Group identical offenders: forty copies of one row control is one finding.
    const groups = new Map<string, { count: number; w: number; h: number; labels: string[] }>();
    for (const item of result.small) {
      const key = `${item.sel} ${item.w}x${item.h}`;
      const group = groups.get(key) ?? { count: 0, w: item.w, h: item.h, labels: [] };
      group.count += 1;
      if (group.labels.length < 3) group.labels.push(item.label);
      groups.set(key, group);
    }
    for (const [key, group] of [...groups.entries()].sort((a, b) => b[1].count - a[1].count)) {
      console.log(`  ${String(group.count).padStart(3)}x  ${key}   e.g. ${group.labels.join(" | ")}`);
    }
  }
} finally {
  socket.close();
  chrome.kill();
  server?.stop(true);
}
