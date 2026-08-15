/**
 * The app's **display name** — the name this app calls itself when it is
 * talking to the person using it — and nothing else.
 *
 * ## Where this sits
 *
 * Modelled on `app-logo.ts`, which is modelled on `i18n/personal-vocabulary.ts`:
 * a React-free module singleton with a `subscribe`/`getSnapshot` pair, bound in
 * exactly one place (`use-app-name.ts`) so the nav rail's name plate, the OS
 * window title and the first-run welcome all read one live value without a
 * provider tree of their own.
 *
 * Its own store rather than a field on `Prefs` for two reasons, both of which
 * the logo store already ran into:
 *
 * - `resetAppearance()` spreads `DEFAULT_PREFS`, so a name living in `Prefs`
 *   would be silently un-named by a button whose label says "Reset appearance".
 *   Renaming the app is not a theme decision and must not ride along with one.
 * - `usePrefs()` resolves through the draft coordinator on the settings
 *   screens, which stages edits behind an Apply bar. A name that only takes
 *   effect after Apply is a name that does not change the window title while
 *   you are looking at it. Committing here means the rename lands live, which
 *   is the more literal reading of "applies live wherever feasible".
 *
 * ## Identity is a constant; display is a setting. They never read each other.
 *
 * This is the whole safety property of the feature, so it is stated once here
 * and enforced by construction: **nothing in this module is ever consulted to
 * decide where anything lives.** The application's identity is baked in at
 * build time and is unreachable from the renderer:
 *
 * - the application-data directory is Electron's `app.getPath("userData")`,
 *   derived from `productName`/`appId` in `electron-builder.yml` — see
 *   `electron/main.mjs` and `shell/app-data-path.ts`, neither of which imports
 *   this file;
 * - the package identity (`@bitkyc08/opencodex`), the installer name and the
 *   update feed all come from `package.json` and `electron-builder.yml`, which
 *   no renderer code writes;
 * - every browser-storage key this app owns is a literal constant declared
 *   beside the store that uses it (`ocx-m3:v1`, `ocx-applogo:v1`,
 *   `ocx-m3:revisions`, and {@link STORAGE_KEY} below). None is built from a
 *   name, so a rename cannot orphan a stored profile, a lock, a credential or
 *   a revision log.
 *
 * The consequence worth spelling out: a user who renames the app and then
 * cannot find their data has not lost it, because the rename never touched
 * where it is. That is the failure this separation exists to make impossible.
 *
 * ## And where the *real* name still has to win
 *
 * {@link SHIPPED_APP_NAME} is what a diagnostic, a crash report or an issue
 * must carry, because a reader handed "Mum's Robot v2.7.42" has no idea what
 * software they are looking at. Surfaces that report outward send the shipped
 * name; surfaces that talk to the user send {@link AppNameSnapshot.display}.
 * The Appearance card says so in as many words rather than leaving it for
 * somebody to discover.
 */

/**
 * The name this app ships under, and the name every outward-facing report uses.
 *
 * A display default, *not* an identity: `package.json`'s `name`,
 * `electron-builder.yml`'s `appId` and `productName`, and the storage keys
 * above are each declared where they are used and none of them reads this.
 */
export const SHIPPED_APP_NAME = "opencodex";

/** Longest display name, in code points rather than UTF-16 units. */
export const APP_NAME_MAX_LENGTH = 60;

const STORAGE_KEY = "ocx-appname:v1";

/**
 * Characters a display name may never contain, whatever a user pastes in.
 *
 * This name is written into `document.title`, into an `aria-label`, and into
 * the nav rail's own name plate, so the bar is not "is it rude" — it is "can
 * it misrepresent the chrome around it". Newlines and other C0/C1 controls
 * would break a single-line title; bidi overrides can reorder the characters
 * *after* the name and make a version string read backwards; zero-width
 * characters make two visibly identical names compare unequal, which turns
 * "reset when it matches the shipped name" into a coin toss.
 */
const FORBIDDEN = new RegExp(
  [
    "[",
    // C0/C1 controls. Tab and newline are deliberately absent: they are
    // whitespace, and the collapse below turns them into a single space
    // rather than deleting them and welding two words together.
    "\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F",
    // Zero-width space and joiners, then the LTR/RTL marks.
    "\\u200B-\\u200F",
    // Bidi embedding, pop and override.
    "\\u202A-\\u202E",
    // Word joiner, the invisible operators, and the bidi isolates.
    "\\u2060-\\u2064\\u2066-\\u206F",
    // Zero-width no-break space, better known as a stray byte-order mark.
    "\\uFEFF",
    "]",
  ].join(""),
  "g",
);

/**
 * Everything the user typed that is safe to render, which may be `""`.
 *
 * Separate from {@link normalizeAppName} because the two `null`s that function
 * returns mean opposite things to a caller: "you gave me nothing" is a mistake
 * worth reporting, and "you gave me the shipped name" is a deliberate reset.
 * Folding both into one return value is how a name containing an invisible
 * character alongside the shipped one gets reported as an empty field.
 */
export function sanitizeAppName(raw: unknown): string {
  const clean = cleanAppNameText(raw);
  if (!clean) return "";
  // Cap by code point, not by `.slice`: cutting at a UTF-16 boundary can split
  // a surrogate pair and store half an emoji, which renders as a replacement
  // character in the one place the user is most likely to notice.
  return [...clean].slice(0, APP_NAME_MAX_LENGTH).join("");
}

/**
 * The same cleanup **without** the length cap.
 *
 * Exported so the editor can tell the difference between "this is your name"
 * and "this is your name, shortened" *before* saving. A field that silently
 * drops the tail of what somebody typed is the small dishonesty that makes
 * people stop trusting a form; comparing this against
 * {@link sanitizeAppName} is what lets the card say so instead.
 */
export function cleanAppNameText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const stripped = raw.replace(FORBIDDEN, "");
  // Collapse runs of whitespace so a name cannot be padded into looking like
  // two words, and trim the ends. Done after stripping, so a removed control
  // character cannot leave a double space behind.
  return stripped.replace(/\s+/g, " ").trim();
}

/**
 * The stored form of what the user typed, or `null` when there is nothing to
 * store.
 *
 * `null` is also what an exact match for {@link SHIPPED_APP_NAME} normalizes
 * to: typing the shipped name back in is the same request as pressing reset,
 * and storing it as a "custom" name would leave a profile carrying a custom
 * name identical to the default, which then reports "custom name active" about
 * a screen that looks untouched.
 */
export function normalizeAppName(raw: unknown): string | null {
  const clean = sanitizeAppName(raw);
  if (!clean || clean === SHIPPED_APP_NAME) return null;
  return clean;
}

/** The persisted custom name, re-validated on every read, or `null`. */
export function readAppName(storage?: Pick<Storage, "getItem">): string | null {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    if (!store) return null;
    const raw = store.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    // Re-normalized rather than trusted: a hand-edited or older profile could
    // hold a name this build would refuse from the field, and the field is not
    // the only way bytes reach this key.
    return normalizeAppName((parsed as Record<string, unknown>).name);
  } catch {
    return null;
  }
}

function writeAppName(name: string | null, storage?: Pick<Storage, "setItem" | "removeItem">): void {
  try {
    const store = storage ?? localStorage;
    if (name === null) store.removeItem(STORAGE_KEY);
    else store.setItem(STORAGE_KEY, JSON.stringify({ name }));
  } catch { /* quota or a blocked store — the rename still applies this session */ }
}

/* -------------------------------------------------------------- the store - */

export interface AppNameSnapshot {
  /** What the user chose, or `null` when the shipped name is in use. */
  readonly custom: string | null;
  /** What every user-facing surface renders. Never `null`. */
  readonly display: string;
}

const SHIPPED_SNAPSHOT: AppNameSnapshot = { custom: null, display: SHIPPED_APP_NAME };

let snapshot: AppNameSnapshot = SHIPPED_SNAPSHOT;
let hydrated = false;
const listeners = new Set<() => void>();

function snapshotFor(custom: string | null): AppNameSnapshot {
  return custom === null ? SHIPPED_SNAPSHOT : { custom, display: custom };
}

function ensureHydrated(storage?: Pick<Storage, "getItem">): void {
  if (hydrated) return;
  hydrated = true;
  snapshot = snapshotFor(readAppName(storage));
}

export function getAppNameSnapshot(): AppNameSnapshot {
  ensureHydrated();
  return snapshot;
}

export function subscribeAppName(listener: () => void): () => void {
  ensureHydrated();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Why a commit did nothing, so the card can say which of the two it was. */
export type AppNameRejection = "empty" | "unchanged";

export interface AppNameCommit {
  /** True only when the stored name actually moved. */
  readonly applied: boolean;
  readonly rejection: AppNameRejection | null;
  /** The custom name now in force, or `null` for the shipped one. */
  readonly custom: string | null;
  /** What the shell renders after this call. */
  readonly display: string;
  /** What it rendered before, so a caller can record an honest revision. */
  readonly previousDisplay: string;
}

function commit(next: string | null, storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">): AppNameCommit {
  ensureHydrated(storage);
  const previous = snapshot;
  if (next === previous.custom) {
    return {
      applied: false,
      rejection: "unchanged",
      custom: previous.custom,
      display: previous.display,
      previousDisplay: previous.display,
    };
  }
  writeAppName(next, storage);
  snapshot = snapshotFor(next);
  for (const listener of listeners) listener();
  return {
    applied: true,
    rejection: null,
    custom: snapshot.custom,
    display: snapshot.display,
    previousDisplay: previous.display,
  };
}

/**
 * Apply what the user typed.
 *
 * A value that normalizes away entirely is reported as `"empty"` rather than
 * silently treated as a reset: clearing the field and pressing save is a
 * plausible typo, and resetting the app's name on the strength of it would be
 * an action nobody asked for. {@link resetAppName} is the one action that does
 * that, and it says so on the button.
 */
export function setAppName(
  raw: string,
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): AppNameCommit {
  const clean = sanitizeAppName(raw);
  if (!clean) {
    ensureHydrated(storage);
    return {
      applied: false,
      rejection: "empty",
      custom: snapshot.custom,
      display: snapshot.display,
      previousDisplay: snapshot.display,
    };
  }
  // `clean === SHIPPED_APP_NAME` normalizes to `null`, which commits as a
  // reset — typing the shipped name back in is the same request as pressing
  // the reset button, and refusing it would be pedantry about a name the app
  // is happy to be called.
  return commit(clean === SHIPPED_APP_NAME ? null : clean, storage);
}

/** Back to {@link SHIPPED_APP_NAME}, in one action, from anywhere. */
export function resetAppName(storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">): AppNameCommit {
  return commit(null, storage);
}

/** Drop hydrated state so a test can start from a known store. */
export function resetAppNameStoreForTests(): void {
  hydrated = false;
  snapshot = SHIPPED_SNAPSHOT;
  listeners.clear();
}
