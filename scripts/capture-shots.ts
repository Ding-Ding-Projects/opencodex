/**
 * Recaptures every README screenshot from the real desktop app.
 *
 * The shots in `assets/shots/` are the only picture most readers get of this
 * app, and they go stale silently: nothing fails when the UI changes underneath
 * them, so a screenshot can misrepresent the product for months while every test
 * stays green. This script exists so recapturing is one command rather than an
 * afternoon of manual window-dragging, which is the difference between shots
 * that get refreshed and shots that do not.
 *
 * It drives the *packaged Electron app* over the Chrome DevTools Protocol, not a
 * browser pointed at the dev server. That distinction matters: the window
 * chrome in these images — the Material 3 app bar with its own minimise,
 * maximise and close buttons — only exists when `window.opencodexDesktop` is
 * present. Capturing from a plain browser and calling it the desktop app would
 * produce a picture of something the user cannot download.
 *
 * Usage — bring the app up with remote debugging, then run this:
 *
 *   npx --yes electron@43.2.0 electron/main.mjs \
 *     --remote-debugging-port=9222 --user-data-dir=<a scratch dir>
 *   bun run scripts/capture-shots.ts
 *
 * Both of those arguments are load-bearing, and neither is obvious:
 *
 *   - `electron/main.mjs`, not `.`. This repo's `package.json` `main` is the npm
 *     CLI entry; electron-builder swaps in the desktop entry only when packaging.
 *     `electron .` therefore starts the CLI module, which opens no window at all —
 *     the process runs, the debugging port answers, and there is simply never a
 *     page to attach to.
 *
 *   - `--user-data-dir`. If the installed opencodex is already running it holds
 *     Electron's single-instance lock, and a second instance quits during module
 *     load, before `whenReady`. A separate profile sidesteps the lock so captures
 *     never require closing the user's app.
 *
 * The proxy is shared: `ensureProxy` adopts a healthy one already on the port, so
 * this attaches to whatever is running rather than starting a competitor.
 *
 * Pass page names to capture a subset: `bun run scripts/capture-shots.ts logs usage`.
 */

const PORT = Number(process.env.CDP_PORT || 9222);
const OUT = "assets/shots";

/** Matches the committed shots: 1440x900 at 2x, the window size `createWindow` asks for. */
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false };
/** The mobile remote is a phone surface; capturing it at desktop width proves nothing. */
const PHONE = { width: 393, height: 852, deviceScaleFactor: 3, mobile: true };

/** Every route the README shows. One page, one file, same name — no mapping table to drift. */
const PAGES = [
  "dashboard", "startup", "providers", "models", "combos", "subagents",
  "logs", "usage", "storage", "codex-auth", "api", "claude", "grok",
  "appearance", "language", "regex", "changelog", "history", "notifications",
  "network", "settings", "terminal",
];

const wanted = process.argv.slice(2).filter(a => !a.startsWith("-"));
const targets = wanted.length ? wanted : [...PAGES, "mobile"];

// ---------------------------------------------------------------- CDP client

let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

async function findTarget(): Promise<string> {
  // Electron needs a moment to open the window and start the proxy behind it.
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = (await res.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>;
      const page = list.find(t => t.type === "page" && t.webSocketDebuggerUrl && !t.url.startsWith("devtools://"));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not listening yet */ }
    await Bun.sleep(500);
  }
  throw new Error(
    `No CDP page target on :${PORT} after 30s. Is the app running with --remote-debugging-port=${PORT}?`,
  );
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
    // `unref` so a pending watchdog cannot hold the process open, and clear it on
    // reply so hundreds of live timers do not accumulate across a full run. The
    // first version did neither, and the script sat there for twelve minutes
    // after writing its last screenshot with nothing left to do.
    const watchdog = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 30_000);
    watchdog.unref?.();
    const settle = () => clearTimeout(watchdog);
    pending.set(id, { resolve: (v: any) => { settle(); resolve(v); }, reject: (e: Error) => { settle(); reject(e); } });
  });
}

/** Evaluate in the page and surface a thrown error rather than a silent undefined. */
async function evaluate(expression: string): Promise<any> {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || "page threw");
  return res.result?.value;
}

// ------------------------------------------------------------------- capture

await send("Page.enable");
await send("Runtime.enable");

/**
 * Turn the dim sum surprise off before anything is captured.
 *
 * It draws once per launch with a 1% chance, which is small enough to feel safe
 * and large enough to eventually land on a capture run and put a plate of har
 * gow in the middle of the dashboard screenshot. A 1-in-100 corruption that only
 * shows up in a committed PNG is worse than a common one; nobody would think to
 * look for it.
 */
await evaluate(`
  (() => {
    const KEY = "ocx-m3:v1";
    const prefs = JSON.parse(localStorage.getItem(KEY) || "{}");
    prefs.dimsum = false;
    localStorage.setItem(KEY, JSON.stringify(prefs));
  })()
`);
await send("Page.reload");
await Bun.sleep(2500);

/**
 * Wait until the panel has finished fetching, not merely finished routing.
 *
 * A fixed sleep is not enough. Several pages mount instantly and then show
 * "Loading…" while they call the proxy, so a capture timed on route change
 * photographs an empty placeholder — which is precisely what happened to the
 * Claude page on the first run of this script, and precisely the kind of wrong
 * screenshot nobody notices, because a page that looks blank looks like a page
 * that *is* blank.
 *
 * Returns false when the page never settles, so the caller can say so out loud
 * instead of quietly committing the placeholder.
 */
async function waitForContent(timeoutMs = 12_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const busy = await evaluate(`
      (() => {
        if (document.querySelector('[aria-busy="true"]')) return true;
        const text = (document.body?.innerText || "").trim();
        // Only a *sparse* page counts as loading. Matching "Loading" anywhere
        // flagged the changelog, which lists real release notes that happen to
        // contain the word — a false alarm that trains you to ignore the alarm.
        // The genuine failure looks different: a mounted shell with almost no
        // content under it, which is what the Claude page was at 162 characters.
        return text.length < 600 && /\\bLoading\\b/.test(text);
      })()
    `);
    if (!busy) return true;
    await Bun.sleep(300);
  }
  return false;
}

/** Click the first button whose visible label matches exactly. */
async function clickButton(label: string): Promise<void> {
  const ok = await evaluate(`
    (() => {
      const b = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === ${JSON.stringify(label)});
      if (!b) return false;
      b.click();
      return true;
    })()
  `);
  if (!ok) throw new Error(`no button labelled "${label}"`);
}

async function typeAndEnter(selector: string, text: string): Promise<void> {
  // Select the existing contents first so `insertText` replaces rather than
  // appends. Without this a re-run types into whatever the previous run left
  // behind and submits `ocx --versionocx --version`, which is a valid-looking
  // command that quietly prints the help text instead.
  await evaluate(`
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      el.select?.();
      return true;
    })()
  `);
  await send("Input.insertText", { text });

  // Enter needs all three events, and the `char` one needs to carry "\\r".
  // keyDown/keyUp alone leave the text sitting in the field: the app submits on
  // the character, so a two-event Enter looks like it worked and does nothing.
  for (const type of ["keyDown", "char", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13,
      ...(type === "char" ? { text: "\r" } : {}),
    });
  }
}

/**
 * Pages that only show their feature once something has happened.
 *
 * The Terminal is the clear case: on arrival it is an empty "No session" panel,
 * so a shot timed on navigation documents a blank box rather than the feature.
 * Its README caption promises a running session, and a caption that describes
 * something the image does not contain is worse than no caption — the reader
 * trusts the words and mistrusts their own eyes.
 */
const PREPARE: Record<string, () => Promise<void>> = {
  async terminal() {
    const FIELD = 'input[placeholder*="command" i]';
    await clickButton("Shell");
    // The shell has to spawn and hand back a prompt before it can be typed into.
    for (let i = 0; i < 40 && !await evaluate(`!!document.querySelector(${JSON.stringify(FIELD)})`); i++) {
      await Bun.sleep(250);
    }
    await typeAndEnter(FIELD, "ocx --version");

    // Wait for the version line itself, not just for "some output". A failed
    // command still fills the transcript, so anything looser would happily
    // capture a shot of an error and call it a working terminal.
    for (let i = 0; i < 40; i++) {
      if (await evaluate(`/opencodex\\s+\\d+\\.\\d+\\.\\d+/.test(document.body.innerText)`)) return;
      await Bun.sleep(250);
    }
    throw new Error("the shell never printed a version line");
  },
};

async function capture(page: string): Promise<void> {
  const metrics = page === "mobile" ? PHONE : DESKTOP;
  await send("Emulation.setDeviceMetricsOverride", metrics);

  // Assign `location.hash` rather than calling into the app: this is the same
  // event a user's click produces, so the strip, the nav and the panel all
  // update through their real code path.
  await evaluate(`location.hash = ${JSON.stringify(`#/${page}`)}`);

  // Let route state settle and any entry motion finish. Capturing mid-transition
  // yields a half-faded panel that looks like a rendering bug.
  await Bun.sleep(900);
  if (!await waitForContent()) console.warn(`  ! ${page} still showed a loading state — check this shot by eye`);

  if (PREPARE[page]) {
    await PREPARE[page]();
    await Bun.sleep(600);
  }

  // Fonts and late layout after the data lands.
  await Bun.sleep(700);

  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  if (!shot?.data) throw new Error(`${page}: CDP returned no image data`);

  const bytes = Buffer.from(shot.data, "base64");
  // A blank or near-blank PNG compresses to almost nothing. Catching it here
  // beats discovering it after 23 empty images are committed.
  if (bytes.length < 20_000) throw new Error(`${page}: image is only ${bytes.length} bytes — page likely did not render`);

  await Bun.write(`${OUT}/${page}.png`, bytes);
  console.log(`  ${page.padEnd(12)} ${metrics.width}x${metrics.height}@${metrics.deviceScaleFactor}x  ${(bytes.length / 1024).toFixed(0)} KB`);
}

console.log(`Capturing ${targets.length} surface(s) from the running desktop app:\n`);
const failures: string[] = [];
for (const page of targets) {
  try {
    await capture(page);
  } catch (err) {
    failures.push(`${page}: ${(err as Error).message}`);
    console.error(`  ${page.padEnd(12)} FAILED — ${(err as Error).message}`);
  }
}

ws.close();

if (failures.length) {
  console.error(`\n${failures.length} capture(s) failed:\n${failures.map(f => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`\nWrote ${targets.length} shot(s) to ${OUT}/.`);
// Explicit: the CDP socket is closing asynchronously and there is nothing left
// to wait for. Without this the script lingers, which reads as a hang.
process.exit(0);
