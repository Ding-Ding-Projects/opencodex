/**
 * Where "delete the application-data folder" — the toy-lock recovery route —
 * actually points, in whichever context this build is running in.
 *
 * Two honest answers, never a guess:
 *
 *  - Inside the Electron desktop shell, `window.opencodexDesktop.appData`
 *    (added alongside this feature in `electron/preload.cjs` /
 *    `electron/main.mjs`) resolves the *real* `app.getPath("userData")` and
 *    can open it in the platform's file manager. The unlock prompt and the
 *    Support Tickets surface show that exact resolved path — never a template
 *    like `%APPDATA%\opencodex`, which could be wrong the moment packaging
 *    changes how the app is named.
 *  - In a plain browser tab (`npm run dev`, a deployed docs/site build, or
 *    simply the desktop bridge not being present for any reason), there is no
 *    OS-level application-data folder for this page to open — the shared
 *    contract's own fallback for exactly this case is to say so and point at
 *    clearing the browser's local storage for this site instead, which is
 *    where every toy lock's credential and every lock record actually lives
 *    in that context. See `credential-vault.ts` for the longer version of why.
 */

export interface OpencodexDesktopAppData {
  path: () => Promise<string>;
  open: () => Promise<{ ok: boolean; path: string; error?: string }>;
}

interface OpencodexDesktopGlobal {
  isDesktop?: boolean;
  appData?: OpencodexDesktopAppData;
}

function desktopBridge(): OpencodexDesktopAppData | null {
  const w = globalThis as unknown as { opencodexDesktop?: OpencodexDesktopGlobal };
  return w.opencodexDesktop?.appData ?? null;
}

export function hasDesktopAppDataBridge(): boolean {
  return desktopBridge() !== null;
}

/** The real resolved folder path, or `null` when there is none to resolve (browser context). */
export async function resolveAppDataPath(): Promise<string | null> {
  const bridge = desktopBridge();
  if (!bridge) return null;
  try {
    return await bridge.path();
  } catch {
    return null;
  }
}

/**
 * Opens the folder in the platform's file manager. Returns `false` when there
 * is no desktop bridge to ask, or when the bridge itself reports failure —
 * either way, this never deletes anything; it only ever stands the user in
 * front of the folder so they can.
 */
export async function openAppDataFolder(): Promise<boolean> {
  const bridge = desktopBridge();
  if (!bridge) return false;
  try {
    const result = await bridge.open();
    return result.ok;
  } catch {
    return false;
  }
}
