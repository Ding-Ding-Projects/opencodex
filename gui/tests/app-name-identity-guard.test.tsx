/**
 * The app-rename contract: `theme/app-name.ts` lets the user change the name
 * this app calls itself, and the whole feature stands or falls on one
 * property — display is a setting, identity is a constant, and **nothing
 * that decides where anything lives, or what this app is called on disk, on
 * the wire, or to a stranger reading a bug report, may ever read the display
 * name.** The module's own header states this is "the whole safety property
 * of the feature," enforced today only by construction (no imports into the
 * store, literal storage keys) and by four display-only consumers. Nothing
 * asserted it stays that way.
 *
 * A project whose data directory was derived from its package name has
 * already discovered, for real, what happens when that separation slips: a
 * rename orphans every stored profile, credential and history. That is the
 * regression this file exists to make impossible to land silently.
 *
 * Four things are guarded here, matching the contract exactly:
 *
 *  1. the chosen display name reaches the surfaces that should show it;
 *  2. no identity path — the app-data folder, the package/installer
 *     identifiers, or a marker this app writes into a user's own files —
 *     ever reads the display name, however it is set;
 *  3. an outward-facing disclosure (the card's own "diagnostics send the
 *     shipped name" note) actually renders the shipped name, not whatever
 *     the user typed;
 *  4. reset is one action back to the shipped name, and the setting
 *     survives a reload.
 *
 * Part 2 is the one worth the most: a repository-wide scan for any file
 * that references the app-name module's import path, its storage key, or
 * any of its exported symbols, asserted against a **hand-written allowlist**
 * of the documented display-only consumers. A file wired to consult the
 * display name for anything else — the app-data path resolver chief among
 * them — shows up here regardless of which file it is or what it was
 * renamed to, which a check scoped to one hard-coded path could not catch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import {
  APP_NAME_MAX_LENGTH,
  SHIPPED_APP_NAME,
  cleanAppNameText,
  getAppNameSnapshot,
  normalizeAppName,
  readAppName,
  resetAppName,
  resetAppNameStoreForTests,
  sanitizeAppName,
  setAppName,
  subscribeAppName,
} from "../src/theme/app-name";
import { useAppDisplayName } from "../src/theme/use-app-name";
import { windowTitle, type BuildInfo } from "../src/shell/build-info";
import { hasDesktopAppDataBridge, resolveAppDataPath } from "../src/shell/app-data-path";
import { AppNameCard } from "../src/components/appearance/AppNameCard";
import { TestProviders } from "./helpers/providers";

/* ------------------------------------------------------------ storage ---- */

interface MemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  raw: Map<string, string>;
}

function makeStorage(): MemoryStorage {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: key => (raw.has(key) ? raw.get(key)! : null),
    setItem: (key, value) => { raw.set(key, value); },
    removeItem: key => { raw.delete(key); },
  };
}

afterEach(() => {
  resetAppNameStoreForTests();
});

/* ============================================================== part 1 ===
 * The store contract itself: sanitization, normalization, commit semantics,
 * and persistence — with the injectable-storage parameter every public
 * function accepts, so none of this needs a DOM.
 * ========================================================================= */

describe("sanitizeAppName / cleanAppNameText / normalizeAppName", () => {
  test("forbidden control, bidi and zero-width characters are stripped", () => {
    // NUL, a bidi override, and a zero-width joiner sitting inside an
    // otherwise ordinary name.
    const raw = "My\u0000App\u202Ename\u200D";
    expect(sanitizeAppName(raw)).toBe("MyAppname");
  });

  test("runs of whitespace collapse to one space, and the ends are trimmed", () => {
    expect(sanitizeAppName("   My    Robot   ")).toBe("My Robot");
  });

  test("tabs and newlines become whitespace rather than being deleted outright", () => {
    // Deleting instead of collapsing would weld "My" and "Robot" together.
    expect(sanitizeAppName("My\tRobot\nv2")).toBe("My Robot v2");
  });

  test("length is capped by code point, not by UTF-16 unit — a surrogate pair is never split", () => {
    const astral = "🤖".repeat(APP_NAME_MAX_LENGTH + 5); // each is a surrogate pair
    const clean = sanitizeAppName(astral);
    expect([...clean].length).toBe(APP_NAME_MAX_LENGTH);
    // Every code point survived whole — no lone surrogate, no replacement char.
    expect(clean).not.toContain("\uFFFD");
  });

  test("cleanAppNameText applies the same cleanup without the length cap", () => {
    const astral = "🤖".repeat(APP_NAME_MAX_LENGTH + 5);
    expect([...cleanAppNameText(astral)].length).toBe(APP_NAME_MAX_LENGTH + 5);
  });

  test("a non-string input sanitizes to the empty string rather than throwing", () => {
    expect(sanitizeAppName(undefined)).toBe("");
    expect(sanitizeAppName(42)).toBe("");
    expect(sanitizeAppName(null)).toBe("");
  });

  test("normalizeAppName maps an empty result and the shipped name itself to null", () => {
    expect(normalizeAppName("   ")).toBeNull();
    expect(normalizeAppName(SHIPPED_APP_NAME)).toBeNull();
    // Padding or case-preserving variants of the shipped name are NOT the
    // same request — only an exact match resets.
    expect(normalizeAppName(`  ${SHIPPED_APP_NAME}  `)).toBeNull();
    expect(normalizeAppName("Opencodex")).toBe("Opencodex");
  });
});

describe("readAppName — fail-closed persistence", () => {
  test("no stored value reads as null (shipped)", () => {
    expect(readAppName(makeStorage())).toBeNull();
  });

  test("corrupt JSON reads as null rather than throwing", () => {
    const storage = makeStorage();
    storage.setItem("ocx-appname:v1", "{not json");
    expect(readAppName(storage)).toBeNull();
  });

  test("a non-object payload reads as null", () => {
    const storage = makeStorage();
    storage.setItem("ocx-appname:v1", "42");
    expect(readAppName(storage)).toBeNull();
  });

  test("a hand-edited profile is re-normalized, not trusted verbatim", () => {
    const storage = makeStorage();
    // A forbidden control character snuck in some other way than the field.
    storage.setItem("ocx-appname:v1", JSON.stringify({ name: "Rogue\u0000Bot" }));
    expect(readAppName(storage)).toBe("RogueBot");
  });

  test("a stored value identical to the shipped name reads back as null", () => {
    const storage = makeStorage();
    storage.setItem("ocx-appname:v1", JSON.stringify({ name: SHIPPED_APP_NAME }));
    expect(readAppName(storage)).toBeNull();
  });
});

describe("setAppName / resetAppName — commit semantics", () => {
  test("an empty or whitespace-only submission is refused and leaves the store untouched", () => {
    const storage = makeStorage();
    const result = setAppName("   ", storage);
    expect(result).toEqual({
      applied: false,
      rejection: "empty",
      custom: null,
      display: SHIPPED_APP_NAME,
      previousDisplay: SHIPPED_APP_NAME,
    });
    expect(readAppName(storage)).toBeNull();
  });

  test("submitting the name already in force is refused as 'unchanged'", () => {
    const storage = makeStorage();
    setAppName("Nightly Bot", storage);
    resetAppNameStoreForTests();
    const result = setAppName("Nightly Bot", storage);
    expect(result.applied).toBe(false);
    expect(result.rejection).toBe("unchanged");
  });

  test("a real rename commits, persists, and reports before/after correctly", () => {
    const storage = makeStorage();
    const result = setAppName("Nightly Bot", storage);
    expect(result).toEqual({
      applied: true,
      rejection: null,
      custom: "Nightly Bot",
      display: "Nightly Bot",
      previousDisplay: SHIPPED_APP_NAME,
    });
    expect(readAppName(storage)).toBe("Nightly Bot");
    expect(getAppNameSnapshot()).toEqual({ custom: "Nightly Bot", display: "Nightly Bot" });
  });

  test("typing the shipped name back in commits as a reset, not as a custom name equal to it", () => {
    const storage = makeStorage();
    setAppName("Nightly Bot", storage);
    const result = setAppName(SHIPPED_APP_NAME, storage);
    expect(result.applied).toBe(true);
    expect(result.custom).toBeNull();
    expect(result.display).toBe(SHIPPED_APP_NAME);
    expect(result.previousDisplay).toBe("Nightly Bot");
    expect(readAppName(storage)).toBeNull();
  });

  test("resetAppName is a no-op (applied: false) when already shipped", () => {
    const storage = makeStorage();
    const result = resetAppName(storage);
    expect(result.applied).toBe(false);
    expect(result.custom).toBeNull();
  });

  test("resetAppName returns to the shipped name in one action from a custom name", () => {
    const storage = makeStorage();
    setAppName("Nightly Bot", storage);
    const result = resetAppName(storage);
    expect(result).toEqual({
      applied: true,
      rejection: null,
      custom: null,
      display: SHIPPED_APP_NAME,
      previousDisplay: "Nightly Bot",
    });
    expect(readAppName(storage)).toBeNull();
  });

  test("every applied commit notifies subscribers synchronously; rejected commits notify nobody", () => {
    const storage = makeStorage();
    let notifications = 0;
    const unsubscribe = subscribeAppName(() => { notifications++; });
    setAppName("", storage); // rejected: empty
    setAppName("Nightly Bot", storage); // applied
    setAppName("Nightly Bot", storage); // rejected: unchanged
    resetAppName(storage); // applied
    resetAppName(storage); // rejected: already shipped
    expect(notifications).toBe(2);
    unsubscribe();
  });

  test("the setting survives a reload — module state resets, the backing store does not", () => {
    // A real page reload re-executes every module top-to-bottom (dropping
    // `hydrated`/`snapshot`/`listeners`) while leaving whatever the browser
    // persisted untouched. `resetAppNameStoreForTests` reproduces exactly
    // the module-state half of that. Reproducing the persistence half needs
    // a REAL global `localStorage`, because `getAppNameSnapshot()` (called
    // with no storage argument, exactly as every live consumer calls it)
    // only ever hydrates from the ambient global — an injected `storage`
    // object plugged into `setAppName`/`readAppName` directly proves those
    // two functions round-trip, but says nothing about what a page reload
    // of the real app would see.
    const raw = new Map<string, string>();
    const globalStorage = {
      getItem: (key: string) => (raw.has(key) ? raw.get(key)! : null),
      setItem: (key: string, value: string) => { raw.set(key, value); },
      removeItem: (key: string) => { raw.delete(key); },
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: globalStorage });
    try {
      setAppName("Nightly Bot"); // no storage arg — the real, live call shape
      expect(getAppNameSnapshot().display).toBe("Nightly Bot");

      resetAppNameStoreForTests(); // simulates the reload: module state drops
      expect(raw.get("ocx-appname:v1")).toBe(JSON.stringify({ name: "Nightly Bot" })); // the backing store did not

      // The live snapshot re-hydrates from that same backing store on the
      // very next read, with no explicit "load" step required.
      expect(getAppNameSnapshot()).toEqual({ custom: "Nightly Bot", display: "Nightly Bot" });
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});

/* ============================================================== part 2 ===
 * Bullet 1 of the contract: the chosen name reaches the surfaces that
 * should show it — proven through two independent consumers, not just the
 * editor's own echo of what it just wrote.
 * ========================================================================= */

describe("the chosen display name reaches the surfaces that should show it", () => {
  const INFO: BuildInfo = { version: "9.9.9", build: "42", commit: "", shortCommit: "", released: false, dish: null };

  test("windowTitle carries an explicitly passed display name", () => {
    expect(windowTitle(INFO, "Nightly Bot")).toStartWith("Nightly Bot · ");
  });

  test("windowTitle's default argument is the shipped constant, not a second literal copy", () => {
    expect(windowTitle(INFO)).toStartWith(`${SHIPPED_APP_NAME} · `);
  });
});

/* ============================================================== part 3 ===
 * The centrepiece: nothing that decides identity may ever read the display
 * name. Proven two ways —
 *
 *   (a) a repository-wide static scan for any reference at all to the
 *       app-name module (its import path, its storage key, or any exported
 *       symbol), asserted against a hand-written allowlist of the
 *       documented display-only consumers. Anything else that starts
 *       referencing it — regardless of which file — fails this test.
 *   (b) a behavioural proof that the one concrete identity path this app
 *       ships today (`resolveAppDataPath`) returns the same answer whether
 *       the display name is the shipped one, a short custom one, or a long
 *       one containing the shipped name as a substring.
 * ========================================================================= */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Every reference this feature's own docs (`app-name.ts`'s header) commit to. */
const APP_NAME_REFERENCE_PATTERN = new RegExp(
  [
    "app-name", // catches every import path spelling: "./app-name", "theme/app-name", …
    "ocx-appname", // the literal storage key
    "useAppDisplayName",
    "\\buseAppName\\b",
    "getAppNameSnapshot",
    "AppNameSnapshot",
    "subscribeAppName",
    "\\bsetAppName\\b",
    "\\bresetAppName\\b",
    "SHIPPED_APP_NAME",
    "APP_NAME_MAX_LENGTH",
    "sanitizeAppName",
    "normalizeAppName",
    "cleanAppNameText",
    "AppNameCommit",
    "AppNameRejection",
    "resetAppNameStoreForTests",
  ].join("|"),
);

/**
 * The complete, hand-written list of files allowed to reference the
 * app-name module — every one of them a documented display-only consumer
 * (the store, its hook, the four rendering surfaces the module's own header
 * names, the editor and its history plumbing, and the one generated-docs
 * bundle that describes the feature in prose). Anything the scan finds
 * outside this list is a NEW reference nobody reviewed for identity safety.
 *
 * Deliberately does NOT include `gui/src/shell/app-data-path.ts`,
 * `electron/main.mjs`, `electron/preload.cjs`, `electron-builder.yml`,
 * either `package.json`, `src/lib/state-history.ts`,
 * `src/lib/secret-history.ts`, `src/claude/agents-inject.ts`, or
 * `src/codex/inject.ts` — the identity paths this test exists to keep off
 * this list, forever.
 */
const ALLOWED_APP_NAME_REFERENCES = [
  "gui/src/App.tsx",
  "gui/src/components/appearance/AppNameCard.tsx",
  "gui/src/components/authenticator/SecretHistoryDialog.tsx",
  "gui/src/docs/generated-articles.ts",
  "gui/src/pages/Appearance.tsx",
  "gui/src/pages/secret-history-api.ts",
  "gui/src/shell/AdaptiveNav.tsx",
  "gui/src/shell/OnboardingWizard.tsx",
  "gui/src/shell/build-info.ts",
  "gui/src/theme/app-name.ts",
  "gui/src/theme/use-app-name.ts",
  "src/server/management/authenticator-routes.ts",
].sort();

function collectFiles(dir: string, extensions: string[], out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, extensions, out);
    else if (extensions.some(ext => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function toRepoRelative(absolute: string): string {
  return absolute.slice(REPO_ROOT.length).replace(/\\/g, "/");
}

/** Every source file this scan considers — the whole backend, the whole GUI source tree, and the Electron main/preload pair. */
function scannedFiles(): string[] {
  const files = [
    ...collectFiles(join(REPO_ROOT, "src"), [".ts"]),
    ...collectFiles(join(REPO_ROOT, "gui", "src"), [".ts", ".tsx"]),
    ...collectFiles(join(REPO_ROOT, "electron"), [".mjs", ".cjs"]),
  ];
  files.push(join(REPO_ROOT, "package.json"), join(REPO_ROOT, "gui", "package.json"), join(REPO_ROOT, "electron-builder.yml"));
  return files;
}

describe("no identity path ever reads the display name — repository-wide guard", () => {
  test("every file referencing the app-name module is on the hand-written display-only allowlist", () => {
    const matched = scannedFiles()
      .filter(f => APP_NAME_REFERENCE_PATTERN.test(readFileSync(f, "utf8")))
      .map(toRepoRelative)
      .sort();
    expect(matched).toEqual(ALLOWED_APP_NAME_REFERENCES);
  });

  // Named individually, so a failure here reads as "the data directory
  // resolver started reading the display name" rather than a diff against a
  // twelve-item array the reader has to reverse-engineer.
  test("the app-data path resolver specifically is not on the allowlist and is not referenced anywhere", () => {
    expect(ALLOWED_APP_NAME_REFERENCES).not.toContain("gui/src/shell/app-data-path.ts");
    const text = readFileSync(join(REPO_ROOT, "gui", "src", "shell", "app-data-path.ts"), "utf8");
    expect(APP_NAME_REFERENCE_PATTERN.test(text)).toBe(false);
  });

  test("electron/main.mjs (which computes app.getPath('userData')) never references it, and never renames the app at runtime", () => {
    const text = readFileSync(join(REPO_ROOT, "electron", "main.mjs"), "utf8");
    expect(APP_NAME_REFERENCE_PATTERN.test(text)).toBe(false);
    // Electron's own userData path is a function of the app's *registered*
    // name (productName/appId, baked in at build time). A call to
    // `app.setName(...)` here would be the runtime backdoor around every
    // static guarantee this file otherwise gives — assert it never appears.
    expect(text).not.toMatch(/\bapp\.setName\s*\(/);
  });

  test("electron/preload.cjs exposes appData:path as a bare IPC call — the renderer cannot send a name along with it", () => {
    const text = readFileSync(join(REPO_ROOT, "electron", "preload.cjs"), "utf8");
    expect(APP_NAME_REFERENCE_PATTERN.test(text)).toBe(false);
    expect(text).toContain('ipcRenderer.invoke("appData:path")');
  });

  test("the package/installer identifiers are literal constants equal to the shipped name, not a template", () => {
    const yml = readFileSync(join(REPO_ROOT, "electron-builder.yml"), "utf8");
    expect(APP_NAME_REFERENCE_PATTERN.test(yml)).toBe(false);
    expect(yml).toMatch(/^productName:\s*opencodex\s*$/m);
    expect(yml).toMatch(/^appId:\s*com\.opencodex\.desktop\s*$/m);
    expect(`productName: ${SHIPPED_APP_NAME}`).toMatch(/^productName:\s*opencodex$/);

    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { name: string; bin: Record<string, string> };
    expect(APP_NAME_REFERENCE_PATTERN.test(JSON.stringify(pkg))).toBe(false);
    expect(pkg.name).toBe("@bitkyc08/opencodex");
    expect(pkg.bin[SHIPPED_APP_NAME]).toBe("./bin/ocx.mjs");
  });

  test("the local git-history repositories (the app's own audit trail, not a user's) stamp a hard-coded identity, never the display name", () => {
    for (const rel of ["src/lib/state-history.ts", "src/lib/secret-history.ts"]) {
      const text = readFileSync(join(REPO_ROOT, rel), "utf8");
      expect(APP_NAME_REFERENCE_PATTERN.test(text)).toBe(false);
      expect(text).toContain('"user.name", "opencodex ');
    }
  });

  test("markers this app writes into a user's own config/agent files are literal, not built from the display name", () => {
    const agentsInject = readFileSync(join(REPO_ROOT, "src", "claude", "agents-inject.ts"), "utf8");
    expect(APP_NAME_REFERENCE_PATTERN.test(agentsInject)).toBe(false);
    // A literal assignment, not `` `generated-by: ${something}` `` — the
    // exact string is what every previously-generated file on a user's
    // machine was already stamped with, so it is the one thing that must
    // never start moving underneath a rename.
    expect(agentsInject).toContain('const GENERATED_MARKER = "generated-by: opencodex";');

    const codexInject = readFileSync(join(REPO_ROOT, "src", "codex", "inject.ts"), "utf8");
    expect(APP_NAME_REFERENCE_PATTERN.test(codexInject)).toBe(false);
    expect(codexInject).toContain('"[model_providers.opencodex]"');
  });
});

describe("resolveAppDataPath — behavioural proof the identity path ignores the display name", () => {
  const ORIGINAL_BRIDGE = (globalThis as { opencodexDesktop?: unknown }).opencodexDesktop;

  function installBridge(path: string): void {
    (globalThis as { opencodexDesktop?: unknown }).opencodexDesktop = {
      isDesktop: true,
      appData: { path: async () => path, open: async () => ({ ok: true, path }) },
    };
  }
  function uninstallBridge(): void {
    if (ORIGINAL_BRIDGE === undefined) Reflect.deleteProperty(globalThis, "opencodexDesktop");
    else (globalThis as { opencodexDesktop?: unknown }).opencodexDesktop = ORIGINAL_BRIDGE;
  }

  afterEach(uninstallBridge);

  test("the resolved path is byte-identical under the shipped name, a short custom name, and a name containing the shipped name as a substring", async () => {
    const realPath = "C:\\Users\\swiftie\\AppData\\Local\\opencodex";
    installBridge(realPath);
    expect(hasDesktopAppDataBridge()).toBe(true);

    const storage = makeStorage();

    resetAppNameStoreForTests();
    const underShipped = await resolveAppDataPath();

    setAppName("Nightly Bot", storage);
    const underCustom = await resolveAppDataPath();

    // Deliberately chosen to contain the shipped name as a substring, so a
    // naive `path.replace(SHIPPED_APP_NAME, display)`-style "fix" would
    // still show up here as a changed result.
    setAppName(`${SHIPPED_APP_NAME} Turbo Edition`, storage);
    const underNameContainingShipped = await resolveAppDataPath();

    expect(underShipped).toBe(realPath);
    expect(underCustom).toBe(realPath);
    expect(underNameContainingShipped).toBe(realPath);
  });
});

/* ============================================================== part 4 ===
 * Bullet 3 of the contract, proven at runtime rather than by reading source:
 * the card's own disclosure that "diagnostics send the shipped name" must
 * actually render the shipped name after a rename — not the name the user
 * just chose, which is exactly the sentence this note exists to contradict
 * if it ever got that wrong.
 * ========================================================================= */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The card fires a best-effort, fire-and-forget history POST on every
  // rename (`recordRenameHistory` in `AppNameCard.tsx`). Stubbed rather than
  // left to hit a real relative URL, which is irrelevant noise for a test
  // about what RENDERS, not about the history side-channel.
  globalThis.fetch = (async () => new Response(JSON.stringify({ historyRecorded: true }), { status: 200 })) as typeof fetch;
  resetAppNameStoreForTests();
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  globalThis.fetch = originalFetch;
  resetAppNameStoreForTests();
});

/** A second, independent consumer — stands in for AdaptiveNav / App.tsx — proving the rename is not just the card echoing its own draft. */
function DisplayNameProbe() {
  const name = useAppDisplayName();
  return <span data-testid="probe">{name}</span>;
}

async function mountCardWithProbe(): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <TestProviders>
        <DisplayNameProbe />
        <AppNameCard />
      </TestProviders>,
    );
  });
  return { container, root };
}

function typeInto(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
}

function diagnosticNoteText(container: HTMLElement): string | undefined {
  return [...container.querySelectorAll("p")]
    .find(el => el.textContent?.includes("Diagnostics, crash logs"))
    ?.textContent ?? undefined;
}

describe("AppNameCard — the diagnostic disclosure always names the shipped app, never the chosen one", () => {
  test("before any rename, the diagnostic note already names the shipped app", async () => {
    const { container, root } = await mountCardWithProbe();
    expect(diagnosticNoteText(container)).toBe(
      `Diagnostics, crash logs and anything you file as an issue send the shipped name, ${SHIPPED_APP_NAME}, so whoever reads them knows which software it is.`,
    );
    await act(async () => { root.unmount(); });
  });

  test("after a real rename, the probe and the card's own status line pick up the new name — proving the surfaces DO update", async () => {
    const { container, root } = await mountCardWithProbe();
    const input = container.querySelector<HTMLInputElement>("#ocx-app-name")!;
    await act(async () => { typeInto(input, "Nightly Bot"); });
    const form = container.querySelector("form")!;
    await act(async () => { form.dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true }) as never); });

    expect(container.querySelector("[data-testid='probe']")?.textContent).toBe("Nightly Bot");
    expect(getAppNameSnapshot().display).toBe("Nightly Bot");

    await act(async () => { root.unmount(); });
  });

  test("after that same rename, the diagnostic note STILL names the shipped app, not 'Nightly Bot'", async () => {
    const { container, root } = await mountCardWithProbe();
    const input = container.querySelector<HTMLInputElement>("#ocx-app-name")!;
    await act(async () => { typeInto(input, "Nightly Bot"); });
    const form = container.querySelector("form")!;
    await act(async () => { form.dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true }) as never); });

    // Sanity: the rename genuinely took, so this note is not passing by
    // coincidence — the state line right above it DOES show the new name.
    const stateLine = container.querySelector("#ocx-app-name-state")?.textContent;
    expect(stateLine).toContain("Nightly Bot");

    const note = diagnosticNoteText(container);
    expect(note).toContain(SHIPPED_APP_NAME);
    expect(note).not.toContain("Nightly Bot");
    expect(note).toBe(
      `Diagnostics, crash logs and anything you file as an issue send the shipped name, ${SHIPPED_APP_NAME}, so whoever reads them knows which software it is.`,
    );

    await act(async () => { root.unmount(); });
  });
});
