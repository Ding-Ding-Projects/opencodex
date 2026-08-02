/**
 * Captures the app's menus, popovers and overlays from the real desktop app.
 *
 * `capture-shots.ts` photographs pages. Pages are the easy half: navigate, wait,
 * shoot. Everything in this file only exists *after* an interaction — a menu that
 * is open, a picker that is anchored, a dialog that is up — and none of it
 * survives a reload, so none of it can be captured by pointing at a route.
 *
 * ## The guard is the point
 *
 * Every entry declares `appears`, a selector that must exist once the menu is
 * open, and the capture is refused when it does not. Without that, a trigger
 * that silently stopped working still produces a perfectly valid PNG — of the
 * page behind the menu. It looks like a screenshot, it is named like a
 * screenshot, and it is wrong in the one way nobody checks. A missing file is
 * obvious; a plausible wrong one is not, and this whole directory exists to be
 * believed.
 *
 * Usage — same as `capture-shots.ts`, against an app started with remote
 * debugging on `CDP_PORT` (default 9222):
 *
 *   bun run scripts/capture-menus.ts
 *   bun run scripts/capture-menus.ts notifications tab-context
 */

const PORT = Number(process.env.CDP_PORT || 9222);
const OUT = "assets/shots/menus";
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false };

/**
 * How a menu is opened, and how we know it opened.
 *
 * `page` is the route to be on first — several of these hang off a specific
 * screen, and opening the tab menu from whatever happened to be showing would
 * make the shot depend on run order.
 */
interface Menu {
  name: string;
  page: string;
  /** Runs in the page. Returns false when the trigger itself could not be found. */
  open: string;
  /** Must exist afterwards, or the capture is refused rather than saved. */
  appears: string;
}

/**
 * Find a visible element by `aria-label`, in any language mode.
 *
 * Emitted into the page rather than kept here, because every `open` expression
 * below runs in the browser. Captures are taken bilingual, so a label reads
 * `Notifications · 通知` and an exact `[aria-label="Notifications"]` selector
 * matches nothing — three menus were silently skipped for exactly that reason,
 * reported as "trigger not found" while the button was on screen.
 */
const BY_LABEL = `
  (scope, label) => {
    const want = label.toLowerCase();
    const says = v => {
      const s = (v || "").trim();
      return s.toLowerCase() === want || s.split(" · ").some(p => p.trim().toLowerCase() === want);
    };
    return [...document.querySelectorAll(scope)].find(el => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && says(el.getAttribute("aria-label"));
    }) || null;
  }`;

const MENUS: Menu[] = [
  {
    name: "notifications",
    page: "dashboard",
    open: `(() => { const b = (${BY_LABEL})('button', 'Notifications'); if (!b) return false; b.click(); return true; })()`,
    appears: `[role="dialog"], .m3-notif-panel, .m3-menu`,
  },
  {
    // The anchored per-element appearance editor, reached the way a user reaches
    // it: right-click the tab, then "Edit tab appearance…".
    //
    // There is an `[aria-label="Appearance"]` button in the app bar and it is NOT
    // this. It navigates to the Appearance *page*, which `capture-shots.ts`
    // already photographs — clicking it here captured that page and called it a
    // menu until the guard refused it.
    name: "tab-appearance-editor",
    page: "dashboard",
    open: `(async () => {
      const tab = document.querySelector('[role="tab"], .m3-tab-btn');
      if (!tab) return false;
      const r = tab.getBoundingClientRect();
      tab.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      }));
      await new Promise(res => setTimeout(res, 400));
      const item = [...document.querySelectorAll('button, [role="menuitem"]')]
        .find(el => /edit tab appearance/i.test(el.textContent || ''));
      if (!item) return false;
      item.click();
      return true;
    })()`,
    appears: `.ap-popover, .m3-popover, [role="dialog"]`,
  },
  {
    // Shows the signed-in Codex accounts, and this repository is public — so it
    // is worth saying why that is fine here rather than leaving the next person
    // to re-litigate it. The app masks the address itself, rendering an initial,
    // three asterisks and a digit in place of the local part — spelled out rather
    // than quoted, because a quoted example is a literal address to the privacy
    // scan and it is right not to take a comment's word for it.
    // and every page shot in `assets/shots/` has carried that same masked string
    // for as long as they have existed, `codex-auth.png` most obviously. This
    // menu discloses nothing the rest of the directory does not.
    //
    // If the address should not be published at all, that is a decision about
    // *every* shot, not this one — dropping a single file leaves the string in
    // the others and buys nothing.
    name: "account-menu",
    page: "dashboard",
    open: `(() => { const b = document.querySelector('.m3-avatar--btn'); if (!b) return false; b.click(); return true; })()`,
    appears: `[role="dialog"], [role="menu"], .m3-menu`,
  },
  {
    name: "cost-range",
    page: "dashboard",
    // Data-dependent: the chip only renders once cost data is available, so a
    // fresh `OPENCODEX_HOME` may legitimately have nothing to click. The guard
    // reports that rather than inventing a shot.
    open: `(() => { const b = document.querySelector('.m3-cost-chip'); if (!b) return false; b.click(); return true; })()`,
    appears: `[role="dialog"], [role="menu"], .m3-menu`,
  },
  {
    name: "new-tab-picker",
    page: "dashboard",
    // The tab strip's "+" — the surface that lists every page and filters them.
    open: `(() => { const b = [...document.querySelectorAll('button')].find(b => /new tab|add tab|open a page/i.test(b.getAttribute('aria-label')||'')); if (!b) return false; b.click(); return true; })()`,
    appears: `input[placeholder*="Filter" i], [role="dialog"], .m3-menu`,
  },
  {
    name: "tab-search",
    page: "dashboard",
    open: `(() => { const b = (${BY_LABEL})('button', 'Find a tab'); if (!b) return false; b.click(); return true; })()`,
    appears: `input[placeholder*="tab" i], [role="dialog"], .m3-menu, .m3-tabsearch`,
  },
  {
    name: "tab-context",
    page: "dashboard",
    // Right-click a tab: tab management plus "Edit tab appearance…".
    open: `(() => {
      const tab = document.querySelector('[role="tab"], .m3-tab-btn');
      if (!tab) return false;
      const r = tab.getBoundingClientRect();
      tab.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      }));
      return true;
    })()`,
    appears: `[role="menu"], .m3-menu, .m3-context-menu`,
  },
  {
    // Right-click on an ordinary element — the delegated route that reaches the
    // whole app rather than the three components that once spread the hook.
    //
    // A button inside a card is the case worth photographing: the pointer sits
    // inside *two* editable surfaces, so the shot shows the disambiguation menu
    // offering the button first and its container after it. A single-target
    // right-click opens the editor with no menu at all, which is the next shot.
    name: "element-context",
    page: "dashboard",
    open: `(() => {
      const btn = [...document.querySelectorAll('.m3-card .m3-btn')].find(b => b.offsetParent !== null);
      if (!btn) return false;
      const r = btn.getBoundingClientRect();
      btn.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      }));
      return true;
    })()`,
    appears: `[data-appearance-menu]`,
  },
  {
    // The anchored element appearance editor, on a surface that is not a tab.
    //
    // `tab-appearance-editor` above photographs the same panel reached from a
    // tab, and that is the one surface it could ever be reached from until now.
    // This one is a dashboard stat tile: a plain piece of page content, which is
    // the whole point of the change.
    name: "element-appearance-editor",
    page: "dashboard",
    open: `(async () => {
      const tile = [...document.querySelectorAll('.dash-stat-card')].find(c => c.offsetParent !== null);
      if (!tile) return false;
      const r = tile.getBoundingClientRect();
      tile.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + r.height / 2,
      }));
      await new Promise(res => setTimeout(res, 400));
      // A tile nested inside another editable surface offers a menu first; take
      // its first entry so this target always ends on the editor rather than
      // sometimes photographing the menu and calling it the editor.
      const first = document.querySelector('[data-appearance-menu] [role="menuitem"]');
      if (first) { first.click(); await new Promise(res => setTimeout(res, 400)); }
      return true;
    })()`,
    appears: `[data-element-style-editor]`,
  },
  {
    name: "settings-search-regex",
    page: "network",
    // The regex builder anchored to a settings search bar. Not the `.*` chip —
    // that is the "Regex mode" toggle beside it, which switches the field's
    // matching and opens nothing.
    open: `(() => { const b = (${BY_LABEL})('button', 'Build a pattern to search these settings'); if (!b) return false; b.click(); return true; })()`,
    appears: `[role="dialog"], .m3-regex, .rx-panel, .m3-menu, .rx-builder`,
  },
];

const wanted = process.argv.slice(2).filter(a => !a.startsWith("-"));
const targets = wanted.length ? MENUS.filter(m => wanted.includes(m.name)) : MENUS;
if (!targets.length) {
  console.error(`No menus matched. Known: ${MENUS.map(m => m.name).join(", ")}`);
  process.exit(1);
}

// ---------------------------------------------------------------- CDP client

let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

async function findTarget(): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = (await res.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>;
      const page = list.find(t => t.type === "page" && t.webSocketDebuggerUrl && !t.url.startsWith("devtools://"));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not listening yet */ }
    await Bun.sleep(500);
  }
  throw new Error(`No CDP page target on :${PORT} after 30s.`);
}

const ws = new WebSocket(await findTarget());
await new Promise<void>((resolve, reject) => {
  ws.addEventListener("open", () => resolve(), { once: true });
  ws.addEventListener("error", () => reject(new Error("CDP socket failed to open")), { once: true });
});

ws.addEventListener("message", ev => {
  const msg = JSON.parse(String(ev.data));
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  if (msg.error) slot.reject(new Error(`${msg.error.message} (${msg.error.code})`));
  else slot.resolve(msg.result);
});

function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    const watchdog = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 30_000);
    watchdog.unref?.();
  });
}

async function evaluate(expression: string): Promise<any> {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || "evaluate threw");
  return res.result?.value;
}

/** Close whatever is open, so one menu never appears in the next one's shot. */
async function dismiss(): Promise<void> {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await evaluate(`document.body.click()`);
  await Bun.sleep(250);
}

async function goTo(page: string): Promise<void> {
  await evaluate(`(() => { window.location.hash = ${JSON.stringify("#" + page)}; return true; })()`);
  await Bun.sleep(900);
}

await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", VIEWPORT);
await Bun.sleep(400);

/**
 * Capture in bilingual mode, like `capture-shots.ts`.
 *
 * This script attaches to an app somebody else started, so without this the
 * language of every menu shot is whatever that profile happened to be left in —
 * and a set of screenshots where the pages are bilingual and the menus are not
 * is worse than either, because it reads as a bug in the language mode.
 *
 * Menus are also where bilingual bites hardest: a menu item is a single row with
 * `English · 廣東話` in it, so this is the surface that shows whether the mode
 * actually fits.
 */
await evaluate(`
  (() => {
    localStorage.setItem("ocx-lang", "bi");
    return true;
  })()`);
await send("Page.reload");
await Bun.sleep(2500);
await send("Emulation.setDeviceMetricsOverride", VIEWPORT);
await Bun.sleep(600);

console.log(`Capturing ${targets.length} menu surface(s) from the running desktop app:\n`);

const failures: string[] = [];
for (const menu of targets) {
  await dismiss();
  await goTo(menu.page);

  const triggered = await evaluate(menu.open);
  if (triggered === false) {
    failures.push(`${menu.name}: trigger not found on ${menu.page}`);
    console.log(`  ${menu.name.padEnd(22)} SKIPPED — trigger not found`);
    continue;
  }
  await Bun.sleep(700);

  const opened = await evaluate(`!!document.querySelector(${JSON.stringify(menu.appears)})`);
  if (!opened) {
    // Refused, not saved. A shot of the page behind a menu that never opened is
    // worse than no shot: it is indistinguishable from a correct one.
    failures.push(`${menu.name}: opened nothing matching ${menu.appears}`);
    console.log(`  ${menu.name.padEnd(22)} REFUSED — nothing matched ${menu.appears}`);
    continue;
  }

  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const bytes = Buffer.from(data, "base64");
  await Bun.write(`${OUT}/${menu.name}.png`, bytes);
  console.log(`  ${menu.name.padEnd(22)} ${VIEWPORT.width}x${VIEWPORT.height}@${VIEWPORT.deviceScaleFactor}x  ${Math.round(bytes.length / 1024)} KB`);
}

await dismiss();
await send("Emulation.clearDeviceMetricsOverride");
ws.close();

const captured = targets.length - failures.length;
console.log(`\nWrote ${captured} menu shot(s) to ${OUT}/.`);
if (failures.length) {
  console.log(`\n${failures.length} not captured:`);
  for (const f of failures) console.log(`  - ${f}`);
  // Non-zero: a partial run should not read as a clean one in CI or in a log.
  process.exit(1);
}
