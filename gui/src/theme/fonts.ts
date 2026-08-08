/**
 * The dashboard's own font host.
 *
 * `shared/m3/fonts.ts` does the hard part — `queryLocalFonts`, the measurement
 * probe, and parsing `fvar` out of the actual file — but it cannot know which
 * faces *this* app ships. Its own constants describe the docs site (Geist,
 * Pretendard), and offering those here would put two families in the picker that
 * render as a fallback and nothing else, which is precisely the failure a font
 * list exists to prevent. So the dashboard declares its faces here and passes
 * them in.
 *
 * The four below are exactly the `@font-face` blocks in `styles/fonts.css`, and
 * that is the contract: an entry here with no `@font-face` behind it is a face
 * the picker promises and the browser cannot draw.
 *
 * Axes are claimed only where the bundled file proves them. Roboto Flex is
 * delivered with `font-weight: 100 1000`, so `wght` is real; the family carries
 * a dozen more axes upstream, but the vendored Latin subset does not necessarily
 * ship them and a slider for an axis the file lacks moves nothing while looking
 * like it works.
 */

import {
  loadAxesFor,
  loadFontCatalogue,
  stackFor,
  type FontCatalogue,
  type FontFamily,
  type FontHost,
  type VariationAxis,
} from "../../../shared/m3/fonts";

/**
 * The tail every stack ends in.
 *
 * Noto Sans HK is bundled Latin-only on purpose (`styles/fonts.css` explains the
 * 20 MB it would otherwise cost), so the Chinese glyphs come from whatever the
 * system ships — JhengHei on Windows, PingFang on macOS. Naming both means
 * Cantonese renders without the app carrying a CJK font at all.
 */
export const CJK_TAIL = "'Noto Sans HK', 'Microsoft JhengHei', 'PingFang HK', system-ui, sans-serif";

export const GUI_BUNDLED_FAMILIES: readonly FontFamily[] = [
  {
    family: "Roboto Flex",
    source: "bundled",
    stack: `'Roboto Flex', ${CJK_TAIL}`,
    axes: [{ tag: "wght", name: "Weight", min: 100, max: 1000, default: 400 }],
  },
  { family: "Roboto", source: "bundled", stack: `Roboto, ${CJK_TAIL}`, axes: [] },
  { family: "Noto Sans HK", source: "bundled", stack: `'Noto Sans HK', 'Roboto Flex', sans-serif`, axes: [] },
  {
    family: "Roboto Mono",
    source: "bundled",
    stack: "'Roboto Mono', ui-monospace, 'Cascadia Code', Consolas, monospace",
    axes: [],
  },
];

/** The generic families, tailed for CJK so `sans-serif` still renders 廣東話. */
export const GUI_GENERIC_FAMILIES: readonly FontFamily[] = [
  { family: "system-ui", source: "bundled", generic: true, stack: `system-ui, ${CJK_TAIL}`, axes: [] },
  { family: "sans-serif", source: "bundled", generic: true, stack: `sans-serif, ${CJK_TAIL}`, axes: [] },
  { family: "serif", source: "bundled", generic: true, stack: "serif, 'Noto Serif CJK SC', serif", axes: [] },
  {
    family: "monospace",
    source: "bundled",
    generic: true,
    stack: "ui-monospace, 'Roboto Mono', Consolas, monospace",
    axes: [],
  },
];

export const GUI_FONT_HOST: FontHost = {
  bundled: GUI_BUNDLED_FAMILIES,
  generic: GUI_GENERIC_FAMILIES,
  cjkTail: CJK_TAIL,
};

/**
 * The catalogue, with this app's faces as its floor, computed at most once.
 *
 * The probe measures ~116 candidate families against three generics, twice each
 * — around 700 `measureText` calls — and `loadFontCatalogue` caches nothing. The
 * picker opens inside a popover that mounts and unmounts every time it is
 * toggled, so without this the whole sweep runs again on every open.
 *
 * The promise is cached rather than its result, so two pickers mounting in the
 * same tick share one sweep instead of racing two.
 *
 * `allowPrompt` bypasses and replaces the cache: it is the explicit "use my
 * installed fonts" path, and answering it from a probe cached before permission
 * was granted would make the button appear to do nothing.
 */
let cached: Promise<FontCatalogue> | null = null;

export function loadGuiFontCatalogue(options: { allowPrompt?: boolean } = {}): Promise<FontCatalogue> {
  if (options.allowPrompt) {
    cached = loadFontCatalogue({ allowPrompt: true, host: GUI_FONT_HOST });
    return cached;
  }
  cached ??= loadFontCatalogue({ host: GUI_FONT_HOST });
  return cached;
}

/** Drop the cached sweep. Exists so a test can start from a known state. */
export function resetGuiFontCatalogue(): void {
  cached = null;
}

/** Axes for one family, resolved against this app's bundled faces first. */
export function loadGuiAxesFor(family: string): Promise<VariationAxis[] | undefined> {
  return loadAxesFor(family, GUI_FONT_HOST);
}

/** A family name to the stack this app would apply for it. */
export function guiStackFor(family: string): string {
  return stackFor(family, GUI_FONT_HOST);
}

/**
 * The family name out of a stack, so a stored stack re-selects its own row.
 *
 * Quotes are stripped because a stack is stored as written — `'Roboto Flex', …`
 * — while the catalogue keys on the bare family name, and a row that never
 * matches leaves the picker showing nothing as selected while the font is
 * plainly applied.
 */
export function familyOf(stack: string | undefined): string | null {
  if (!stack) return null;
  const first = stack.split(",")[0]?.trim() ?? "";
  return first.replace(/^["']|["']$/g, "") || null;
}
