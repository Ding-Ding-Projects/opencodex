/**
 * Recaptures every README screenshot from the real desktop app, and refuses to
 * write one it cannot prove is the screen it claims to be.
 *
 * ## Why it verifies
 *
 * Six shots were once committed under the wrong names. A click opened a tab in
 * the background without switching the visible panel, so the harness
 * photographed the previous screen and filed it under the new one. Every image
 * was sharp, the right size, and full of real UI. Nothing looked wrong, because
 * nothing *was* wrong with the pictures, only with their names, and a screenshot
 * cannot look wrong about its own filename. No test can catch that either: the
 * files exist, they are valid PNGs, and they are large.
 *
 * So nothing is written on the strength of having navigated somewhere. Every
 * target declares what must be *visible*, that claim is checked against the live
 * DOM immediately before the shutter, and a mismatch fails the target rather
 * than writing the file. `assets/shots/logs.png` exists only if something
 * reading "Logs & Debug" was genuinely on screen when the pixels were taken.
 *
 * The check is visibility-aware, and that is the trick rather than a detail.
 * This app keeps closed dialogs mounted: with the onboarding wizard open there
 * are five `.m3-dialog__title` elements in the document and four are invisible.
 * `document.querySelector('.m3-dialog__title')` reads "Update opencodex" off a
 * dialog nobody can see, which is precisely how you label a picture of the
 * welcome wizard as the updater. `PROBE` therefore walks each candidate's
 * ancestors checking `display`, `visibility`, `opacity`, `aria-hidden`, `hidden`
 * and `inert`.
 *
 * Route captures additionally assert that *nothing* is floating over the page,
 * so twelve route screenshots cannot quietly carry a modal belonging to none of them.
 *
 * ## Why it photographs the window rather than the page
 *
 * `Page.captureScreenshot` renders the web contents. For a frameless Electron
 * window that is very nearly the whole app, and therefore very nearly right,
 * which is the most dangerous kind of wrong: it looks the same whether the
 * desktop shell opened a real 1440x900 window or never opened one at all.
 * `scripts/window-tools.ps1` drives Win32 `PrintWindow` against the actual
 * top-level window, so these images are of the thing a user downloads.
 *
 * ## Running it
 *
 *   bun run scripts/capture-shots.ts               # everything
 *   bun run scripts/capture-shots.ts logs usage    # only these target ids
 *   bun run scripts/capture-shots.ts --list        # print the target ids
 *
 * It owns the whole lifecycle: resolves the Electron pinned in
 * `electron-builder.yml`, launches the desktop entry, sizes the window,
 * captures, and kills what it started.
 *
 * Three details are load-bearing, all learned the slow way:
 *
 *   - It launches `electron/main.mjs`, not `electron .`. This repo's package
 *     `main` is the npm CLI entry and electron-builder only swaps in the desktop
 *     entry while packaging, so `electron .` starts the CLI module, opens no
 *     window, and answers the debugging port forever while you wonder where the
 *     app went.
 *
 *   - It uses a scratch `--user-data-dir`, wiped every run. The installed
 *     opencodex holds Electron's single-instance lock, so without this a second
 *     instance quits during module load and never reaches `whenReady`. Wiping
 *     also makes the first-run surfaces deterministic instead of depending on
 *     whether someone dismissed the wizard on this machine last week.
 *
 *   - It ALSO isolates `OPENCODEX_HOME`, `CODEX_HOME` and `GROK_HOME` — the
 *     proxy's own state, not the renderer's. This one was missing for a long
 *     time and cost two failed capture passes to find. Left unset,
 *     `OPENCODEX_HOME` falls back to `~/.opencodex`: this machine's real
 *     config, real usage history, real accounts. That is two bugs, not one —
 *     the screenshots differ between machines from the same commit, and a
 *     real profile has been observed to freeze the proxy solid (devlog
 *     b3-proxyhang; see the doc comment on `fetchWhamUsage` in
 *     `src/codex/auth-api.ts`). `scripts/capture-seed.ts` fills the isolated
 *     `OPENCODEX_HOME` back up with synthetic-but-realistic providers and
 *     usage history — an *empty* isolated profile does not freeze, but it
 *     also does not show anything worth screenshotting (the app-bar cost
 *     chip renders nothing at all with zero priced usage; see its own doc
 *     comment). `CODEX_HOME` and `GROK_HOME` are isolated purely for safety:
 *     without them, a normal `ocx start` unconditionally rewrites
 *     `~/.grok/config.toml` if it exists, and can rewrite
 *     `~/.codex/config.toml` if a prior real injection already pointed it at
 *     a proxy — an earlier run of this exact script did that by accident and
 *     needed `ocx restore` to undo it.
 *
 *   - It forces a device scale factor and then fits the window to an exact pixel
 *     size, because otherwise identical code produces 1440x900 images on one
 *     machine and 2880x1800 on another, and that diff is unexplainable.
 *
 * Window handles are desktop-scoped on Windows, so running this under an
 * off-screen desktop captures without taking over the screen: the harness spawns
 * Electron as its own child, and the child lands on that same desktop.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "assets", "shots");
const PS_TOOL = join(ROOT, "scripts", "window-tools.ps1");
const PROFILE = join(ROOT, "node_modules", ".cache", "ocx-capture-profile");
const PROXY_PORT = Number(process.env.OCX_CAPTURE_PORT || 10188);
const CDP_PORT = Number(process.env.CDP_PORT || 9223);

/**
 * The proxy's own state, isolated the same way `PROFILE` above isolates the
 * renderer. See the "Three details are load-bearing" section above for why
 * this matters: an unset `OPENCODEX_HOME` silently falls back to this
 * machine's real `~/.opencodex`, which is both non-deterministic and (per
 * devlog b3-proxyhang) has been observed to freeze the proxy solid.
 *
 * Set on `process.env` here, at module scope, rather than only in `launch()`'s
 * child `env:` — `scripts/capture-seed.ts` is imported and run in THIS
 * process, before Electron ever starts, and it resolves `OPENCODEX_HOME`
 * (via `src/config.ts`'s `getConfigDir()`) by reading `process.env` itself.
 * Setting it here is what makes the seed and the launched child agree on
 * which directory they mean.
 */
const CAPTURE_HOME = join(ROOT, "node_modules", ".cache", "ocx-capture-home");
const CAPTURE_CODEX_HOME = join(ROOT, "node_modules", ".cache", "ocx-capture-codex-home");
/**
 * Deliberately never created (see the wipe step below). `injectGrokConfig()`
 * no-ops on a `GROK_HOME` that is not a directory — that is its own
 * documented, tested behavior, not something this script has to replicate —
 * so pointing it at a path that never exists is the whole fix, regardless of
 * whether the machine actually has Grok installed.
 */
const CAPTURE_GROK_HOME = join(ROOT, "node_modules", ".cache", "ocx-capture-no-grok-home");
process.env.OPENCODEX_HOME = CAPTURE_HOME;
process.env.CODEX_HOME = CAPTURE_CODEX_HOME;
process.env.GROK_HOME = CAPTURE_GROK_HOME;

/**
 * A one-file `ocx` shim, so the `terminal` target's embedded shell can find
 * the command its own script types into it.
 *
 * `terminal.prepare` (below) submits `ocx --version` into the app's real
 * Terminal feature, which spawns a genuine `powershell.exe -NoProfile` child
 * (`src/lib/terminal-session.ts`) inheriting THIS process's environment. On a
 * checkout that was never `npm install -g`'d — every fresh worktree, this one
 * included — `ocx`/`opencodex` is not on `PATH` at all, so the shell answers
 * "not recognized" and the capture fails with "the shell never printed a
 * version line". Installing it for real is a machine-wide, persistent change
 * this script has no business making just to take a screenshot; a shim
 * confined to `CAPTURE_BIN_DIR` and only ever handed to the child processes
 * THIS script spawns is the throwaway-profile treatment applied to one more thing
 * the harness depends on. `bin/ocx.mjs` (the real npm `bin` entry, see
 * `package.json`) already runs correctly via a bare `node`, verified directly:
 * `node bin/ocx.mjs --version` prints `opencodex 2.7.42 (@bitkyc08/opencodex)`.
 */
const CAPTURE_BIN_DIR = join(ROOT, "node_modules", ".cache", "ocx-capture-bin");
function ensureOcxShim(): void {
  mkdirSync(CAPTURE_BIN_DIR, { recursive: true });
  const target = join(ROOT, "bin", "ocx.mjs").replace(/\//g, "\\");
  writeFileSync(join(CAPTURE_BIN_DIR, "ocx.cmd"), `@echo off\r\nnode "${target}" %*\r\n`);
}

/**
 * Committed geometry. The window is fitted to these exact pixel sizes so a
 * refresh on someone else's display produces the same images rather than a
 * whole-tree diff nobody can account for.
 */
const DESKTOP = { css: [1440, 900], scale: 2 } as const;
const PHONE = { css: [393, 852], scale: 3 } as const;
type Viewport = typeof DESKTOP | typeof PHONE;
const pixels = (v: Viewport) => [v.css[0] * v.scale, v.css[1] * v.scale] as const;

// --------------------------------------------------------------- expectations

/** What must be true on screen before a capture is allowed to happen. */
interface Expect {
  /** The visible page heading. Exactly one `h1` must be visible and equal this. */
  h1?: string;
  /** The mobile remote draws its own title instead of an `h1`. */
  mobileTitle?: string;
  /**
   * Exactly one overlay (dialog, menu, anchored popover) must be visible, and
   * its accessible name or its own heading must equal this. Omit it and the
   * target asserts that no overlay is covering the page at all.
   */
  overlay?: string;
  /**
   * Exactly one corner surface (a toast, or the dim sum card) must be showing,
   * and its text must contain this. Omit it and the target asserts that no
   * corner surface is loitering in the frame.
   */
  transient?: string;
  /** Substrings that must appear in the visible text. Cheap proof the panel filled in. */
  contains?: string[];
}

interface Target {
  id: string;
  hash?: string;
  viewport?: Viewport;
  expect: Expect;
  prepare?: () => Promise<void>;
  /** Put the app back in a neutral state afterwards, where Escape will not do it. */
  cleanup?: () => Promise<void>;
  /** This surface only exists in the state a freshly launched app starts in. */
  firstRunOnly?: boolean;
  /** Why this target exists, where the id alone does not say it. */
  note?: string;
}

// ------------------------------------------------------------------ CDP client

let socket: WebSocket;
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const watchdog = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, 30_000);
    watchdog.unref?.();
    pending.set(id, {
      resolve: v => { clearTimeout(watchdog); resolve(v); },
      reject: e => { clearTimeout(watchdog); reject(e); },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

/**
 * Evaluate in the page, surfacing a thrown error rather than a silent
 * `undefined` — which is otherwise indistinguishable from a legitimately empty
 * result and turns a broken probe into a passing check.
 */
async function evaluate(expression: string): Promise<any> {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || "page threw");
  return res.result?.value;
}

/** `JSON.stringify` is the only safe way to get a value into injected source. */
const lit = (v: unknown) => JSON.stringify(v);

// ------------------------------------------------------------------ the probe

/**
 * Reports what is actually visible.
 *
 * Returns raw strings and normalises host-side on purpose. An earlier version
 * collapsed whitespace inside this injected source, where the `\s` had to
 * survive a template literal *and* a JSON encode. It did not: the expression
 * that reached the page was `/s+/g`, and every heading came back with its letter
 * "s" replaced by a space. That failed loudly, but an escaping bug that mangled
 * both sides of a comparison equally would not have.
 */
const PROBE = `
(() => {
  const visible = el => {
    if (!el || !el.isConnected) return false;
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    if (el.closest("[aria-hidden=true],[hidden],[inert]")) return false;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    }
    return true;
  };
  const text = el => el.innerText || el.textContent || "";
  const pick = sel => [...document.querySelectorAll(sel)].filter(visible);

  // Things that float above the page and can therefore be the real subject of a
  // screenshot: modal dialogs, anchored non-modal editors, menus, popovers.
  const overlays = pick("dialog[open], [role=dialog], [role=menu], .m3-menu");
  // A nested overlay (a menu opened from inside a dialog) would otherwise count
  // as a second top-level surface and fail an honest capture.
  const outermost = overlays.filter(el => !overlays.some(other => other !== el && other.contains(el)));

  // Corner surfaces: toasts and the dim sum card. They block nothing, which is
  // exactly why they were missed -- dismissing the onboarding wizard raises a
  // "Skip setup" snackbar that outlives the next two navigations, and it settled
  // into the bottom corner of the Startup and Dashboard shots, overlapping the
  // nav rail. Nothing failed, because a toast is not a dialog. They are counted
  // separately because they are identified by their text: a snackbar has a
  // title element, and the dim sum card is an unclassed role=status div.
  const transient = [...document.querySelectorAll(".m3-snack, [role=status]")]
    .filter(el => visible(el) && (el.matches(".m3-snack") || getComputedStyle(el).position === "fixed"));

  return {
    h1: pick("h1").map(text),
    mobileTitle: pick(".m3-mob__title").map(text),
    overlays: outermost.map(el => {
      const heading = el.querySelector("h1,h2,h3,.m3-dialog__title,.m3-card-title,.m3-menu-heading,.m3-rxpop-title");
      return {
        label: el.getAttribute("aria-label") || "",
        heading: heading && visible(heading) ? text(heading) : "",
      };
    }),
    transient: transient.map(text),
    body: (document.body && document.body.innerText) || "",
    busy: pick("[aria-busy=true]").length,
  };
})()`;

interface Overlay { label: string; heading: string }
interface Probe {
  h1: string[];
  mobileTitle: string[];
  overlays: Overlay[];
  transient: string[];
  body: string;
  busy: number;
}

const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

async function probe(): Promise<Probe> {
  const raw = await evaluate(PROBE);
  return {
    h1: (raw?.h1 ?? []).map(norm),
    mobileTitle: (raw?.mobileTitle ?? []).map(norm),
    overlays: (raw?.overlays ?? []).map((o: Overlay) => ({ label: norm(o.label), heading: norm(o.heading) })),
    transient: (raw?.transient ?? []).map(norm),
    body: norm(raw?.body),
    busy: Number(raw?.busy ?? 0),
  };
}

/** An overlay answers to either its accessible name or its own visible heading. */
const names = (o: Overlay) => [o.label, o.heading].filter(Boolean);

/**
 * Compare rendered text to a reference, ignoring case only.
 *
 * `innerText` returns what is painted, so a heading styled
 * `text-transform: uppercase` reads back as "ESTIMATED COST RANGE" while the
 * string in `i18n/m3.ts` is "Estimated cost range". Case is presentation here,
 * not content, and folding it cannot make two different screens look alike --
 * no two surfaces in this app are distinguished only by capitalisation. Every
 * other difference still fails.
 */
/**
 * Does this on-screen string say what the target expects?
 *
 * The expectations below are written in English, once, and the app is captured
 * in **bilingual** mode — where `resolveKey` joins the two tracks as
 * `English · 廣東話`. Comparing the whole string would fail every target the
 * moment a Cantonese translation exists, and re-writing forty expectations as
 * bilingual literals would pin them to the contents of `yue.ts`: adding one
 * translation would then break a screenshot for no reason anybody could see.
 *
 * So a bilingual observation matches if *either* half matches. The guard keeps
 * all of its power — "Dashboard · 儀表板" still cannot satisfy an expectation of
 * "Providers" — while surviving a translation landing or being reworded.
 */
const eq = (a: string, b: string) => {
  const same = (x: string) => x.trim().toLowerCase() === b.trim().toLowerCase();
  return same(a) || a.split(" · ").some(same);
};

/**
 * The gate. Throws with what was on screen instead, because that is the only
 * useful part of a failed capture.
 */
function assertMatches(target: Target, seen: Probe): void {
  const e = target.expect;
  const context = () =>
    `\n      visible h1: ${JSON.stringify(seen.h1)}`
    + `\n      visible overlays: ${JSON.stringify(seen.overlays.map(names).flat())}`;
  const fail = (msg: string): never => { throw new Error(msg + context()); };

  if (e.h1 !== undefined) {
    if (seen.h1.length !== 1) fail(`expected exactly one visible h1 ("${e.h1}"), saw ${seen.h1.length}`);
    if (!eq(seen.h1[0], e.h1)) fail(`heading is "${seen.h1[0]}", expected "${e.h1}"`);
  }

  if (e.mobileTitle !== undefined && !seen.mobileTitle.some(t => eq(t, e.mobileTitle!))) {
    fail(`no visible mobile title "${e.mobileTitle}"`);
  }

  if (e.overlay !== undefined) {
    if (seen.overlays.length !== 1) {
      // Two stacked surfaces means the image documents whichever landed on top,
      // which is not necessarily the one in the filename.
      fail(`expected exactly one visible overlay ("${e.overlay}"), saw ${seen.overlays.length}`);
    }
    if (!names(seen.overlays[0]).some(n => eq(n, e.overlay!))) {
      fail(`the open overlay is ${JSON.stringify(names(seen.overlays[0]))}, expected "${e.overlay}"`);
    }
  } else if (seen.overlays.length > 0) {
    // The rule that keeps an unrelated modal from riding along on a dozen route shots.
    fail(`${seen.overlays.length} overlay(s) are covering this page`);
  }

  if (e.transient !== undefined) {
    if (seen.transient.length !== 1) {
      fail(`expected exactly one corner surface containing "${e.transient}", saw ${seen.transient.length}`);
    }
    if (!seen.transient[0].toLowerCase().includes(e.transient.toLowerCase())) {
      fail(`the corner surface reads ${JSON.stringify(seen.transient[0])}, expected it to contain "${e.transient}"`);
    }
  } else if (seen.transient.length > 0) {
    // The rule that would have caught the "Skip setup" toast sitting in the
    // corner of the Startup and Dashboard shots, clipping a button.
    fail(`${seen.transient.length} toast/corner surface(s) are loitering: ${JSON.stringify(seen.transient)}`);
  }

  for (const needle of e.contains ?? []) {
    if (!seen.body.includes(needle)) fail(`the screen does not contain ${JSON.stringify(needle)}`);
  }
}

// ------------------------------------------------------------- page utilities

async function goto(hash: string): Promise<void> {
  // Assign the hash rather than calling into the app: this is the same event a
  // user's click produces, so the strip, the nav and the panel all update
  // through their real code path.
  await evaluate(`location.hash = ${lit("#/" + hash)}`);
  await Bun.sleep(700);
}

/**
 * Wait until the panel has finished fetching, not merely finished routing.
 *
 * Several pages mount instantly and then show "Loading..." while they call the
 * proxy, so a capture timed on route change photographs a placeholder. Only a
 * *sparse* page counts as loading: matching the word anywhere flagged the
 * changelog, which lists real release notes that contain it.
 */
async function settle(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seen = await probe();
    if (!seen.busy && !(seen.body.length < 600 && /\bLoading\b/.test(seen.body))) return;
    await Bun.sleep(300);
  }
}

/**
 * Click the first *visible* element matching `sel` whose trimmed text equals
 * `text`. Visibility matters here as much as in the probe: hidden tabs stay
 * mounted, so identical buttons exist in the DOM for every other open tab and an
 * unfiltered `find` happily clicks one nobody can see.
 */
/**
 * Click the visible element whose label reads `text` — in any language mode.
 *
 * The English label is compared against the whole string *and* against each half
 * of a bilingual `English · 廣東話` one. Exact whole-string equality is what
 * these triggers used to do, and it quietly stopped finding anything the moment
 * the captures moved to bilingual: six targets failed with "no visible button
 * labelled …" while the button was plainly on screen, reading
 * `Download export · 下載匯出`.
 *
 * That was the harness being English-bound rather than the app being wrong, and
 * it is worth fixing here rather than pinning the expectations to Cantonese
 * strings — a trigger written against `yue.ts` breaks whenever a translation is
 * reworded.
 */
async function clickText(sel: string, text: string): Promise<void> {
  const ok = await evaluate(`
    (() => {
      const want = ${lit(text)}.toLowerCase();
      const says = value => {
        const s = (value || "").trim();
        return s.toLowerCase() === want || s.split(" · ").some(p => p.trim().toLowerCase() === want);
      };
      const hit = [...document.querySelectorAll(${lit(sel)})].find(el => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && says(el.textContent);
      });
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
  if (!ok) throw new Error(`no visible ${sel} labelled "${text}"`);
  await Bun.sleep(500);
}

/**
 * Click a visible element by `aria-label`, matching either half in bilingual mode.
 *
 * `[aria-label="Notifications"]` is an exact attribute match, so it finds
 * nothing once the label reads `Notifications · 通知`. Prefix matching would
 * work for the English half and quietly fail for anything the Cantonese track
 * happens to order differently, so the split is done properly instead.
 */
async function clickAriaLabel(scope: string, label: string): Promise<void> {
  const ok = await evaluate(`
    (() => {
      const want = ${lit(label)}.toLowerCase();
      const says = value => {
        const s = (value || "").trim();
        return s.toLowerCase() === want || s.split(" · ").some(p => p.trim().toLowerCase() === want);
      };
      const hit = [...document.querySelectorAll(${lit(scope)})].find(el => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && says(el.getAttribute("aria-label"));
      });
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
  if (!ok) throw new Error(`nothing visible in ${scope} is labelled "${label}"`);
  await Bun.sleep(500);
}

async function clickSelector(sel: string): Promise<void> {
  const ok = await evaluate(`
    (() => {
      const hit = [...document.querySelectorAll(${lit(sel)})].find(el => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      });
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
  if (!ok) throw new Error(`nothing visible matches ${sel}`);
  await Bun.sleep(500);
}

/** Right-click, dispatched at the element's centre so anchored menus land correctly. */
async function contextClick(sel: string, shiftKey = false): Promise<void> {
  const ok = await evaluate(`
    (() => {
      const el = [...document.querySelectorAll(${lit(sel)})].find(el => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      });
      if (!el) return false;
      const box = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, view: window, shiftKey: ${shiftKey ? "true" : "false"},
        clientX: Math.round(box.left + box.width / 2),
        clientY: Math.round(box.top + box.height / 2),
      }));
      return true;
    })()`);
  if (!ok) throw new Error(`nothing visible matches ${sel} to right-click`);
  await Bun.sleep(600);
}

async function pressKey(key: string, code: string, keyCode: number): Promise<void> {
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode });
  }
}

/**
 * Close whatever is floating, and prove it closed.
 *
 * Toasts need their own dismissal: Escape does not touch them, and waiting them
 * out is not reliable either because an error toast is deliberately sticky. So
 * press their close buttons, which is what a user would do.
 */
/**
 * Record the onboarding wizard as finished, the way finishing it does.
 *
 * `gui/src/shell/onboarding-state.ts` owns this flag and biases every ambiguous
 * signal towards *not* showing the wizard, so writing `completed` is enough. The
 * key is duplicated here rather than imported because this script runs outside
 * the bundle; `tests/capture-onboarding-key.test.ts` is what keeps the two from
 * drifting apart.
 */
const ONBOARDING_KEY = "ocx-m3:onboarding";

/**
 * The language mode every screenshot is taken in.
 *
 * Bilingual, because the shots are the project's own evidence that the three
 * language modes are real. English-only images say nothing about whether the
 * Cantonese half exists, fits, or wraps — and "validate narrow widths and the
 * longest localized strings (bilingual mode especially)" is a rule these images
 * are supposed to demonstrate compliance with, not quietly sidestep.
 *
 * It is also the harshest layout case in the app: every label carries
 * `English · 廣東話`, so a row that clips or a button that overflows shows up
 * here first.
 */
const LANG_KEY = "ocx-lang";
const CAPTURE_LOCALE = "bi";

/**
 * Everything the app must already believe before the first shutter.
 *
 * Written straight to `localStorage` rather than clicked through the UI: the
 * language picker lives on a settings screen that is itself one of the targets,
 * so driving it would make the first capture depend on the state the capture is
 * supposed to establish.
 */
async function primeProfile(): Promise<void> {
  await evaluate(`
    (() => {
      localStorage.setItem(${JSON.stringify(ONBOARDING_KEY)}, JSON.stringify({ completed: true, at: 1 }));
      localStorage.setItem(${JSON.stringify(LANG_KEY)}, ${JSON.stringify(CAPTURE_LOCALE)});
      return true;
    })()`);
  // `ignoreCache: true`: defense in depth against a stale cached GET
  // surviving the reload. Not the fix for the stale-`dashboard.png` defect
  // this file's `Page.reload` calls once carried a long explanation of —
  // that turned out to be the long-lived proxy process itself holding a
  // startup-time config in memory, unrelated to what the browser cached; see
  // `seedRichCaptureHome()`'s doc comment in `capture-seed.ts`.
  await send("Page.reload", { ignoreCache: true });
  await Bun.sleep(2500);
  await settle();
}

/**
 * The same, minus the onboarding flag — for the pass that captures the wizard.
 *
 * The wizard has to be genuinely first-run to be photographed, but it should
 * still be photographed bilingual like everything else.
 */
async function setCaptureLocale(): Promise<void> {
  await evaluate(`
    (() => {
      localStorage.setItem(${JSON.stringify(LANG_KEY)}, ${JSON.stringify(CAPTURE_LOCALE)});
      return true;
    })()`);
  // See the comment on primeProfile's reload above.
  await send("Page.reload", { ignoreCache: true });
  await Bun.sleep(2500);
  await settle();
}

async function clearOverlays(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const seen = await probe();
    if (seen.overlays.length === 0 && seen.transient.length === 0) return;
    if (seen.overlays.length) await pressKey("Escape", "Escape", 27);
    if (seen.transient.length) {
      await evaluate(`
        (() => {
          for (const btn of document.querySelectorAll(".m3-snack-close, [role=status] button")) {
            const box = btn.getBoundingClientRect();
            if (box.width > 0 && box.height > 0) btn.click();
          }
        })()`);
    }
    await Bun.sleep(450);
  }
  // Neither Escape nor a close button shifted it; a reload always does.
  // See the comment on primeProfile's reload above.
  await send("Page.reload", { ignoreCache: true });
  await Bun.sleep(2500);
  await settle();
}

// ---------------------------------------------------------------- the targets

/**
 * Every route in `gui/src/app-routing.ts`, with the heading it renders.
 *
 * These strings are the reference, written down rather than read back from the
 * app, so that a copy change breaks the run loudly instead of silently
 * redefining what each screenshot is allowed to contain.
 */
const ROUTE_HEADINGS: Record<string, string> = {
  dashboard: "Dashboard",
  startup: "Startup",
  providers: "Providers",
  models: "Models",
  combos: "Combos",
  subagents: "Subagents",
  logs: "Logs & Debug",
  usage: "Usage",
  storage: "Storage",
  pdf: "PDF tools",
  converter: "File converter",
  ollama: "Ollama",
  downloads: "Downloads",
  "codex-auth": "Codex Auth",
  api: "API",
  claude: "Claude",
  grok: "Grok",
  appearance: "Appearance",
  language: "Language & voice",
  regex: "Regex builder",
  changelog: "Changelog",
  history: "Version history",
  notifications: "Notifications",
  network: "Remote access & backup",
  settings: "Settings",
  terminal: "Terminal",
};

const routes: Target[] = Object.entries(ROUTE_HEADINGS).map(([id, h1]) => ({ id, hash: id, expect: { h1 } }));

/**
 * The Terminal documents an action rather than a panel: on arrival it is an
 * empty "No session" box, so a shot timed on navigation photographs the absence
 * of the feature its caption promises.
 */
const terminal = routes.find(t => t.id === "terminal")!;
terminal.expect.contains = ["ocx --version"];
terminal.prepare = async () => {
  await clickText("button", "Shell");
  const FIELD = 'input[placeholder*="command" i]';
  for (let i = 0; i < 40; i++) {
    if (await evaluate(`!!document.querySelector(${lit(FIELD)})`)) break;
    await Bun.sleep(250);
  }
  // Select the existing contents so `insertText` replaces rather than appends;
  // otherwise a re-run submits "ocx --versionocx --version", which is a
  // valid-looking command that quietly prints the help text instead.
  await evaluate(`
    (() => {
      const el = document.querySelector(${lit(FIELD)});
      if (!el) return false;
      el.focus();
      el.select && el.select();
      return true;
    })()`);
  await send("Input.insertText", { text: "ocx --version" });
  // Enter needs all three events and the `char` one must carry a carriage
  // return: this app submits on the character, so a two-event Enter leaves the
  // text in the field and looks like it worked.
  for (const type of ["keyDown", "char", "keyUp"]) {
    await send("Input.dispatchKeyEvent", {
      type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13,
      ...(type === "char" ? { text: "\r" } : {}),
    });
  }
  // Wait for the version line itself. A failed command also fills the
  // transcript, so anything looser would photograph an error and call it a
  // working terminal.
  for (let i = 0; i < 60; i++) {
    if (/opencodex\s+\d+\.\d+\.\d+/.test((await probe()).body)) return;
    await Bun.sleep(250);
  }
  throw new Error("the shell never printed a version line");
};

const TAB = ".m3-tab[data-tab-id]";

const surfaces: Target[] = [
  {
    id: "mobile",
    hash: "mobile",
    viewport: PHONE,
    expect: { mobileTitle: "opencodex remote" },
    note: "The phone remote at a phone size; capturing it at desktop width proves nothing.",
  },
  {
    id: "onboarding",
    hash: "dashboard",
    firstRunOnly: true,
    expect: { h1: "Dashboard", overlay: "Welcome to opencodex" },
    // Escape would do it, but "Skip setup" is what a user presses and it is what
    // records the wizard as seen. Leaving that to the generic overlay-clearing
    // reload would just bring the wizard straight back.
    cleanup: () => clickText("button", "Skip setup"),
    note: "First-run wizard. Deterministic only because the profile is wiped each run.",
  },
  {
    id: "confirm",
    hash: "network",
    expect: { h1: "Remote access & backup", overlay: "Export everything" },
    prepare: () => clickText("button", "Download export"),
    note:
      "The M3 confirm from shell/confirm.tsx, on a genuinely destructive action. The harness "
      + "opens it and escapes: confirming would write a file containing every API key and OAuth "
      + "token in plaintext, which is not something a screenshot run should do to a real machine.",
  },
  {
    id: "tab-menu",
    hash: "dashboard",
    expect: { h1: "Dashboard", overlay: "Actions for Dashboard" },
    prepare: () => contextClick(TAB),
  },
  {
    id: "tab-appearance",
    hash: "dashboard",
    expect: { h1: "Dashboard", overlay: "Appearance for Dashboard" },
    prepare: () => contextClick(TAB, true),
    note: "Shift+right-click opens the anchored editor directly, skipping the context menu.",
  },
  {
    id: "new-tab",
    hash: "dashboard",
    expect: { h1: "Dashboard", overlay: "New tab" },
    prepare: () => clickAriaLabel('.m3-tabstrip button', 'New tab'),
  },
  {
    id: "regex-popover",
    hash: "notifications",
    expect: { h1: "Notifications", overlay: "Regex builder" },
    prepare: () => clickAriaLabel('.m3-rxpop-wrap > button', 'Open regex builder'),
    note:
      "Captured on Notifications rather than the Regex route: the route's own h1 is also "
      + "'Regex builder', so a shot taken there could not tell the anchored popover from the page.",
  },
  {
    id: "notification-centre",
    hash: "dashboard",
    expect: { h1: "Dashboard", overlay: "Notifications" },
    prepare: () => clickAriaLabel('header.m3-appbar button', 'Notifications'),
    note: "The anchored bell popover. A different component from the #notifications route.",
  },
  {
    id: "cost-meter",
    hash: "dashboard",
    // "Cost basis" (`usage.cost.laneHeading`), not "Estimated cost range"
    // (`cost.menuTitle`): CostMeter.tsx now renders a lane-breakdown section
    // ABOVE the range picker (direct vs. api-equivalent $, added after this
    // target was first written), so the panel's first `.m3-menu-heading` in
    // DOM order — the one PROBE's overlay-heading query finds — is the lane
    // heading. The range picker is still there, just no longer first.
    expect: { h1: "Dashboard", overlay: "Cost basis" },
    prepare: () => clickSelector("header.m3-appbar button.m3-cost-chip"),
  },
  {
    id: "account-switcher",
    hash: "dashboard",
    expect: { h1: "Dashboard", overlay: "Codex accounts" },
    prepare: () => clickSelector("header.m3-appbar button.m3-avatar--btn"),
  },
  {
    id: "snackbar",
    hash: "language",
    expect: { h1: "Language & voice", transient: "Narrator is off" },
    prepare: () => clickText("button", "Speak a test message"),
    note: "A real non-blocking toast, pushed by a real action rather than injected.",
  },
  {
    id: "dimsum",
    hash: "dashboard",
    expect: { h1: "Dashboard", transient: "Dim sum time!" },
    note: "The 1%-per-launch surprise, made deterministic. See forceDimSum().",
  },
];

/**
 * Order matters, and only here.
 *
 * The first-run surfaces come first because looking at them is what consumes
 * them: dismissing the wizard records it as seen. Putting them anywhere else
 * means every earlier target tidies them away before their own turn.
 */
const ALL: Target[] = [
  ...surfaces.filter(t => t.firstRunOnly),
  ...routes,
  ...surfaces.filter(t => !t.firstRunOnly),
];

// ------------------------------------------------------------ app lifecycle

function pinnedElectronVersion(): string {
  const yml = readFileSync(join(ROOT, "electron-builder.yml"), "utf8");
  const found = /^electronVersion:\s*(\S+)\s*$/m.exec(yml);
  if (!found) throw new Error("electron-builder.yml does not pin an electronVersion");
  return found[1];
}

/**
 * Electron is deliberately not a repo dependency: electron-builder downloads the
 * runtime itself from the pinned version. Asking npx for the package's own
 * exported path beats guessing at its cache layout, and gives us the binary
 * directly so the spawned pid is Electron's rather than a wrapper's — which
 * matters because the window is found by owning process.
 */
function resolveElectron(): string {
  if (process.env.OCX_ELECTRON) return process.env.OCX_ELECTRON;
  const version = pinnedElectronVersion();
  const probe = spawnSync(
    "npx",
    ["--yes", "-p", `electron@${version}`, "node", "-e", "console.log(require('electron'))"],
    { encoding: "utf8", shell: true },
  );
  const path = (probe.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
  if (!path || !existsSync(path)) {
    throw new Error(
      `could not resolve electron@${version} via npx.\n`
      + `  stdout: ${(probe.stdout || "").trim()}\n  stderr: ${(probe.stderr || "").trim()}\n`
      + "  Set OCX_ELECTRON to an electron binary to skip this lookup.",
    );
  }
  return path;
}

function powershell(args: string[]): string {
  const res = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS_TOOL, ...args],
    { encoding: "utf8" },
  );
  const out = `${res.stdout || ""}${res.stderr || ""}`.trim();
  if (res.status !== 0) throw new Error(`window-tools ${args[1]} failed: ${out}`);
  const ok = out.split(/\r?\n/).find(l => l.startsWith("OK "));
  if (!ok) throw new Error(`window-tools ${args[1]} printed no OK line: ${out}`);
  return ok;
}

let child: ReturnType<typeof spawn> | null = null;
let hwnd = 0;

async function connectCdp(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = (await res.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>;
      const page = list.find(t => t.type === "page" && t.webSocketDebuggerUrl && !t.url.startsWith("devtools://"));
      if (page?.webSocketDebuggerUrl) {
        socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve(), { once: true });
          socket.addEventListener("error", () => reject(new Error("CDP socket failed to open")), { once: true });
        });
        socket.addEventListener("message", ev => {
          const msg = JSON.parse(String(ev.data));
          const slot = pending.get(msg.id);
          if (!slot) return;
          pending.delete(msg.id);
          if (msg.error) slot.reject(new Error(`${msg.error.message} (${msg.error.code})`));
          else slot.resolve(msg.result);
        });
        return;
      }
    } catch { /* not listening yet */ }
    await Bun.sleep(500);
  }
  throw new Error(`no CDP page target on :${CDP_PORT} after 60s`);
}

async function launch(viewport: Viewport): Promise<void> {
  const [w, h] = pixels(viewport);
  const electron = resolveElectron();

  child = spawn(electron, [
    join(ROOT, "electron", "main.mjs"),
    `--remote-debugging-port=${CDP_PORT}`,
    `--force-device-scale-factor=${viewport.scale}`,
    `--user-data-dir=${PROFILE}`,
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPENCODEX_PORT: String(PROXY_PORT),
      // Prepended, not appended: a real `ocx` earlier on PATH must win over
      // the shim, but the shim must still be found when there is none.
      PATH: `${CAPTURE_BIN_DIR}${delimiter}${process.env.PATH ?? ""}`,
    },
    stdio: "ignore",
  });

  const found = powershell(["-Action", "find", "-OwnerPid", String(child.pid)]);
  hwnd = Number(found.split(/\s+/)[1]);
  powershell(["-Action", "fit", "-Hwnd", String(hwnd), "-Width", String(w), "-Height", String(h)]);

  await connectCdp();
  await send("Page.enable");
  await send("Runtime.enable");
  await Bun.sleep(1500);
  await settle();
}

function shutdown(): void {
  try { socket?.close(); } catch { /* already gone */ }
  if (child?.pid) {
    // Electron leaves a proxy child and several renderers behind, so kill the
    // whole tree rather than just the process we hold.
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  }
  child = null;
}

// ------------------------------------------------------------ run preparation

/**
 * Make the 1%-per-launch dim sum draw happen.
 *
 * The card is a real feature drawn by its real code path; all this does is stop
 * the outcome being a lottery. `drawDimSum` skips a first run and an update
 * launch, so the launch markers are seeded first, and `Math.random` is stubbed
 * before the document loads because the draw runs during mount.
 */
async function forceDimSum(): Promise<() => Promise<void>> {
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const injected = await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      Math.random = () => 0.001;
      try {
        localStorage.setItem("ocx-m3:launched", "1");
        localStorage.setItem("ocx-m3:last-version", ${lit(version)});
      } catch (err) { /* storage disabled */ }
      // Nothing seeds a preference here any more: the surprise has no off
      // switch, so seeding the launch markers is the whole of the setup.
    `,
  });
  // `ignoreCache: true`: defense in depth against a stale cached GET
  // surviving the reload. Not the fix for the stale-`dashboard.png` defect
  // this file's `Page.reload` calls once carried a long explanation of —
  // that turned out to be the long-lived proxy process itself holding a
  // startup-time config in memory, unrelated to what the browser cached; see
  // `seedRichCaptureHome()`'s doc comment in `capture-seed.ts`.
  await send("Page.reload", { ignoreCache: true });
  await Bun.sleep(2600);
  await settle();
  return async () => {
    await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected.identifier });
    // See the comment on the reload above.
    await send("Page.reload", { ignoreCache: true });
    await Bun.sleep(2600);
    await settle();
  };
}

// -------------------------------------------------------------------- capture

/** Take the picture. Only ever called after `assertMatches` has passed. */
async function writeShot(target: Target): Promise<void> {
  const file = join(OUT, `${target.id}.png`);
  const line = powershell(["-Action", "capture", "-Hwnd", String(hwnd), "-Out", file]);
  const [, w, h] = line.split(/\s+/);

  const [wantW, wantH] = pixels(target.viewport ?? DESKTOP);
  if (Number(w) !== wantW || Number(h) !== wantH) {
    throw new Error(`captured ${w}x${h}, expected ${wantW}x${wantH}`);
  }
  console.log(`  ${target.id.padEnd(20)} ${w}x${h}  ok`);
}

async function captureOne(target: Target): Promise<void> {
  if (target.hash) await goto(target.hash);
  await settle();

  if (target.prepare) await target.prepare();

  // Fonts and late layout after the data lands; capturing mid-transition yields
  // a half-faded panel that reads as a rendering bug.
  await Bun.sleep(700);

  assertMatches(target, await probe());
  await writeShot(target);
}

// ----------------------------------------------------------------------- main

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const t of ALL) console.log(`${t.id.padEnd(20)} ${t.expect.h1 ?? t.expect.mobileTitle ?? ""}${t.expect.overlay ? ` / ${t.expect.overlay}` : ""}`);
  process.exit(0);
}

const wanted = args.filter(a => !a.startsWith("-"));
const selected = wanted.length ? ALL.filter(t => wanted.includes(t.id)) : ALL;
const unknown = wanted.filter(w => !ALL.some(t => t.id === w));
if (unknown.length) {
  console.error(`unknown target(s): ${unknown.join(", ")}\nrun with --list to see the ids`);
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });
// Wipe the profile so first-run surfaces are deterministic rather than
// depending on what someone dismissed on this machine last week.
rmSync(PROFILE, { recursive: true, force: true });

// Same wipe-then-seed treatment for the proxy's own state (see the module doc
// comment and the CAPTURE_HOME block above). CAPTURE_GROK_HOME is removed but
// deliberately never recreated — see its own comment.
rmSync(CAPTURE_HOME, { recursive: true, force: true });
mkdirSync(CAPTURE_HOME, { recursive: true });
rmSync(CAPTURE_CODEX_HOME, { recursive: true, force: true });
mkdirSync(CAPTURE_CODEX_HOME, { recursive: true });
rmSync(CAPTURE_GROK_HOME, { recursive: true, force: true });
ensureOcxShim();
const { seedMinimalCaptureHome, seedRichCaptureHome } = await import("./capture-seed");
// Minimal (no configured providers) so the `onboarding` target's wizard has
// something to show; `seedRichCaptureHome()` is layered on right after,
// either immediately below (no firstRunOnly target in this run) or once the
// wizard itself has been captured and dismissed (see the loop below and
// capture-seed.ts's module doc comment for why the order is load-bearing).
await seedMinimalCaptureHome();

const failures: string[] = [];
// Config persists to disk from the very first `seedRichCaptureHome()` call
// (the management API writes through), so a later viewport's fresh proxy
// process boots already "configured" — `hasFirstRun` false, straight into
// the `else` branch below — and would otherwise seed the providers and 22
// usage rows a SECOND time, doubling every number `dimsum`/`mobile` show
// next to what `dashboard`/`cost-meter` showed a moment earlier. Reproduced
// live: the app-bar chip read "$0.336" on the desktop pass and "$0.672" —
// exactly double — on the phone pass that followed it.
let richSeeded = false;
const byViewport = [
  { viewport: DESKTOP, list: selected.filter(t => (t.viewport ?? DESKTOP) === DESKTOP) },
  { viewport: PHONE, list: selected.filter(t => t.viewport === PHONE) },
];

for (const { viewport, list } of byViewport) {
  if (!list.length) continue;
  const [w, h] = pixels(viewport);
  console.log(`\nCapturing ${list.length} surface(s) at ${w}x${h} from the real desktop window:\n`);
  try {
    await launch(viewport);
    // The wizard opens over the dashboard on a wiped profile, so it is captured
    // first and dismissed; every later target asserts nothing is floating.
    //
    // Dismissing it with Escape does not *persist* that decision, and each
    // viewport relaunches Electron against the same profile — so the phone pass
    // met a fresh "Welcome to opencodex" sitting over the remote control, and
    // `mobile` failed every run with "1 overlay(s) are covering this page".
    // Nobody noticed for a while, because a target that refuses to write leaves
    // the previous image in place and a stale screenshot looks exactly like a
    // fresh one. So the flag is written directly for every pass after the first,
    // which is the same thing finishing the wizard does.
    // The pass that photographs the wizard needs it still unseen; every other
    // pass writes the flag so it does not sit over the first target.
    const hasFirstRun = list.some(t => t.firstRunOnly);
    if (hasFirstRun) await setCaptureLocale();
    else {
      // No wizard to protect in this run: safe to layer the rich seed on
      // immediately rather than waiting for a firstRunOnly target's cleanup
      // (there isn't one) to trigger it below. The proxy is already up (see
      // `launch()` above), so the management-API calls inside
      // `seedRichCaptureHome()` land on the real running process. Guarded by
      // `richSeeded` — see its own comment — so a later viewport pass, whose
      // fresh proxy already reads yesterday's rich `config.json` off disk,
      // does not layer a second helping of it on top.
      if (!richSeeded) {
        await seedRichCaptureHome(`http://127.0.0.1:${PROXY_PORT}`);
        richSeeded = true;
      }
      await primeProfile();
    }
    for (const target of list) {
      let restore: (() => Promise<void>) | null = null;
      try {
        if (!target.firstRunOnly) await clearOverlays();
        if (target.id === "dimsum") restore = await forceDimSum();
        await captureOne(target);
      } catch (err) {
        failures.push(`${target.id}: ${(err as Error).message}`);
        console.error(`  ${target.id.padEnd(20)} FAILED - ${(err as Error).message}`);
      } finally {
        // Cleanup runs even when the capture failed, so one bad target does not
        // leave a modal sitting over everything after it.
        try {
          if (restore) await restore();
          if (target.cleanup) await target.cleanup();
        } catch { /* the next target's clearOverlays is the backstop */ }
      }
      // The wizard's own capture (pass or fail) is the one moment
      // `hasConfiguredProvider()` was allowed to say "nothing configured yet".
      // Every target after it — in this same list — wants the rich seed, so
      // this fires once, right here, rather than a second time up front. It
      // goes through the live management API (see `seedRichCaptureHome()`'s
      // doc comment in `capture-seed.ts`), not a second `config.json` write —
      // the already-running proxy holds its config in memory from startup and
      // never notices a file changing under it. The reload afterward is still
      // needed too: `dashboard`'s hash is the same one `onboarding` was just
      // shown over, so `goto()`'s hash assignment on the next target is a
      // same-value no-op and the panel would not otherwise re-mount to pick
      // up what the API calls just changed.
      if (target.firstRunOnly) {
        if (!richSeeded) {
          await seedRichCaptureHome(`http://127.0.0.1:${PROXY_PORT}`);
          richSeeded = true;
        }
        await primeProfile();
      }
    }
  } finally {
    shutdown();
  }
}

if (failures.length) {
  console.error(`\n${failures.length} capture(s) failed:\n${failures.map(f => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`\nWrote ${selected.length} shot(s) to ${OUT}.`);
process.exit(0);
