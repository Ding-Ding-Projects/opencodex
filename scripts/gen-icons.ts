/**
 * Generates `gui/src/icons.tsx` from the real Material Symbols Rounded geometry.
 *
 * The dashboard used to draw its own Lucide-style stroke icons. They were
 * legible, consistent with each other, and wrong: the design prototype renders
 * every glyph from Material Symbols Rounded, and M3 conformance is not a matter
 * of picking shapes that look roughly similar. Hand-drawn approximations of a
 * published icon set are exactly the "original design elements" the design rule
 * forbids, and the difference showed on five nav glyphs at a glance.
 *
 * So the paths come from Google's own `material-design-icons` repository rather
 * than from anybody's drawing hand. This script is the audit trail: the map
 * below is the whole editorial decision, and every path is fetched, never typed.
 * Re-run it to pick up upstream corrections; the output is committed so a build
 * never needs the network.
 *
 *   bun run scripts/gen-icons.ts
 *
 * Upstream ships `viewBox="0 -960 960 960"` filled paths, so the generated
 * components are `fill="currentColor"` with no stroke. That is safe here because
 * no caller passes `stroke`/`fill` and the stylesheet only ever sets `width`,
 * `height` and `color` on these SVGs — `color` drives `currentColor` either way.
 */

const ROOT = "https://raw.githubusercontent.com/google/material-design-icons/master/symbols/web";

/** App icon name -> upstream Material Symbols glyph name. */
const MAP: Record<string, string> = {
  IconGrid: "dashboard",
  IconServer: "dns",
  IconBoxes: "deployed_code",
  IconBot: "smart_toy",
  IconList: "list",
  IconMenu: "menu",
  IconTag: "sell",
  IconClock: "schedule",
  IconSwapVert: "swap_vert",
  IconDataUsage: "data_usage",
  IconCoin: "toll",
  IconGauge: "speed",
  IconSliders: "tune",
  IconSweep: "cleaning_services",
  // The window controls. These were hand-drawn Segoe Fluent marks until now, on
  // the reasoning that a filled Material glyph in that corner reads as a foreign
  // object on the OS it runs on. That reasoning lost: the app bar IS the title
  // bar in this frameless shell, so those three marks were the only Windows
  // chrome left inside a surface that is otherwise entirely M3 — which is
  // precisely the "legacy design elements" the design rule forbids, sitting in
  // the most visible place in the window.
  IconWinMinimize: "minimize",
  IconWinMaximize: "crop_square",
  IconWinRestore: "filter_none",
  IconTerminal: "terminal",
  IconActivity: "monitoring",
  IconHardDrive: "hard_drive",
  IconCheck: "check",
  IconX: "close",
  IconPlus: "add",
  IconRefresh: "refresh",
  IconPause: "pause",
  IconPlay: "play_arrow",
  IconTrash: "delete",
  IconAlert: "warning",
  IconInfo: "info",
  // The snackbar's tone marks. `IconCheck` is a bare tick used inside buttons
  // and status chips, where it reads as "this one" rather than as a severity;
  // the prototype's snackbars carry `check_circle` and `error`, which are the
  // enclosed forms that scan as a severity badge next to a warning triangle.
  // Repointing `IconCheck` at `check_circle` would have fixed the snackbar and
  // quietly changed every copy button and provider row in the app.
  IconCheckCircle: "check_circle",
  IconError: "error",
  IconSearch: "search",
  IconArrowUp: "arrow_upward",
  IconArrowDown: "arrow_downward",
  IconChevron: "expand_more",
  IconPower: "power_settings_new",
  IconExternal: "open_in_new",
  IconKey: "key",
  IconLock: "lock",
  IconTicket: "confirmation_number",
  IconLink: "link",
  IconSun: "light_mode",
  IconMoon: "dark_mode",
  IconMonitor: "desktop_windows",
  IconGlobe: "language",
  IconSparkle: "auto_awesome",
  IconShuffle: "shuffle",
  IconGrip: "drag_indicator",
  IconStar: "star",
  IconFilter: "filter_alt",
  IconPalette: "palette",
  IconTranslate: "translate",
  // `rule`, not `regular_expression`. The prototype uses `rule` for every regex
  // affordance it has and never reaches for `regular_expression` at all, so the
  // more literally-named glyph would have been a private guess about the design.
  IconRegex: "rule",
  IconChangelog: "history_edu",
  // The three below exist because the pages they belong to already had an icon
  // that is right somewhere else: `list` is correct on Storage, `language` on the
  // account picker, and `refresh` on ten different buttons. Repointing those
  // would have fixed one nav row and quietly changed a dozen unrelated glyphs.
  IconReceiptLong: "receipt_long",
  IconApi: "api",
  IconRestartAlt: "restart_alt",
  IconHistory: "history",
  IconBell: "notifications",
  IconPin: "push_pin",
  IconDevices: "devices",
  IconBolt: "bolt",
  IconUndo: "undo",
  IconCopy: "content_copy",
  // The colour picker's eyedropper. It was added straight to `gui/src/icons.tsx`
  // with the right upstream geometry but never recorded here, so the next run of
  // this script — this one — deleted it and broke the build. The file says
  // "GENERATED, do not edit by hand" for exactly this reason: an icon that is
  // not in this map does not exist as far as the generator is concerned.
  IconEyedropper: "colorize",
  IconDownload: "download",
  IconVolume: "volume_up",
  // The in-app documentation browser's nav glyph. `menu_book` rather than the
  // plainer `book` or `article`, because this destination is specifically a
  // browsable collection of pages with a contents list, not a single document.
  IconMenuBook: "menu_book",
};

/**
 * One glyph stays hand-drawn, for a reason that is not "we prefer ours".
 *
 * The GitHub mark is a third-party brand logo and simply does not exist in
 * Material Symbols — substituting a generic glyph would misidentify the
 * destination, which is the one thing a link icon must not do.
 *
 * The three window controls used to live here too. They were Segoe Fluent marks
 * on the argument that Windows chrome belongs in a Windows title bar; but this
 * shell has no Windows title bar to belong to. It is frameless, the M3 app bar
 * is the chrome, and those three strokes were the only non-Material thing in it.
 * They are Material Symbols now, in the map above.
 */
const KEEP: Record<string, string> = {
  IconGithub: `<svg {...SS(p)}><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 0 0-.9-2.6c3-.3 6.2-1.5 6.2-6.7A5.2 5.2 0 0 0 20 4.8 4.9 4.9 0 0 0 19.9 1S18.7.6 16 2.5a13.4 13.4 0 0 0-7 0C6.3.6 5.1 1 5.1 1A4.9 4.9 0 0 0 5 4.8a5.2 5.2 0 0 0-1.4 3.7c0 5.1 3.1 6.4 6.1 6.7a3.4 3.4 0 0 0-.9 2.5V22"/></svg>`,
};

/** Emission order, so the generated file stays readable and diffs stay small. */
const ORDER = [
  "IconGrid", "IconServer", "IconBoxes", "IconBot", "IconList", "IconMenu",
  "IconTag", "IconClock", "IconSwapVert", "IconDataUsage", "IconCoin",
  "IconGauge", "IconSliders", "IconSweep",
  "IconWinMinimize", "IconWinMaximize", "IconWinRestore",
  "IconTerminal", "IconActivity", "IconHardDrive", "IconCheck", "IconX",
  "IconPlus", "IconRefresh", "IconPause", "IconPlay", "IconTrash", "IconAlert",
  "IconInfo", "IconCheckCircle", "IconError",
  "IconSearch", "IconArrowUp", "IconArrowDown", "IconChevron",
  "IconGithub", "IconPower", "IconExternal", "IconKey", "IconLock",
  "IconTicket", "IconLink", "IconSun", "IconMoon", "IconMonitor", "IconGlobe",
  "IconSparkle", "IconShuffle", "IconGrip", "IconStar", "IconFilter",
  "IconPalette", "IconTranslate", "IconRegex", "IconChangelog", "IconHistory",
  "IconBell", "IconPin", "IconDevices", "IconBolt", "IconUndo", "IconCopy",
  "IconEyedropper", "IconDownload", "IconVolume",
  "IconReceiptLong", "IconApi", "IconRestartAlt", "IconMenuBook",
];

interface Geometry { inner: string; viewBox: string }

/**
 * Fetch a glyph's markup *and the grid it is drawn on*.
 *
 * Material Symbols is not one coordinate system. Most files use
 * `viewBox="0 -960 960 960"`, but a number of older ones carry no viewBox at all
 * and are implicitly `0 0 24 24`. Assuming the 960 grid for everything is not a
 * cosmetic mistake: 24-unit path data inside a 960-unit viewBox draws the shape
 * at 1/40th scale in the top-left corner, which renders as *nothing at all*.
 *
 * `auto_awesome` is one of those files, and it shipped as a blank space in the
 * Claude nav row — every neighbour had an icon, so the gap read as a layout bug
 * rather than a wrong viewBox.
 */
async function geometry(glyph: string): Promise<Geometry> {
  const url = `${ROOT}/${glyph}/materialsymbolsrounded/${glyph}_24px.svg`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${glyph}: HTTP ${res.status} — is that a real Material Symbols name?`);
  const svg = await res.text();

  const openTag = svg.match(/<svg[^>]*>/)?.[0] ?? "";
  const declared = openTag.match(/viewBox="([^"]+)"/)?.[1];
  const width = openTag.match(/width="(\d+)"/)?.[1];
  const height = openTag.match(/height="(\d+)"/)?.[1];
  const viewBox = declared ?? (width && height ? `0 0 ${width} ${height}` : null);
  if (!viewBox) throw new Error(`${glyph}: upstream SVG declares neither a viewBox nor width/height`);

  // Upstream files are a single <svg> wrapper around one or more paths. Take the
  // inner markup verbatim; rewriting path data by hand is how a faithful copy
  // stops being faithful.
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>[\s\S]*$/, "").trim();
  if (!inner.includes("<path")) throw new Error(`${glyph}: no path found in upstream SVG`);

  // The grid and the numbers in the path have to agree. This is the check that
  // was missing when `auto_awesome` went out invisible.
  // `\.\d+` matters: SVG path data writes fractions without a leading zero, so a
  // naive pattern reads `-.525` as the integer 525 and every glyph looks huge.
  const magnitudes = [...inner.matchAll(/-?(?:\d+\.?\d*|\.\d+)/g)].map(m => Math.abs(Number(m[0])));
  const largest = Math.max(...magnitudes);
  const bigGrid = viewBox.includes("960");
  if (bigGrid && largest < 100) throw new Error(`${glyph}: viewBox says 960-grid but no coordinate exceeds ${largest}`);
  if (!bigGrid && largest > 100) throw new Error(`${glyph}: viewBox says ${viewBox} but a coordinate reaches ${largest}`);

  return { inner, viewBox };
}

const bodies = new Map<string, string>();
const legacyGrid: string[] = [];
for (const name of ORDER) {
  if (KEEP[name]) { bodies.set(name, KEEP[name]); continue; }
  const glyph = MAP[name];
  if (!glyph) throw new Error(`${name} is in ORDER but has no glyph mapping`);
  const { inner, viewBox } = await geometry(glyph);
  bodies.set(name, `<svg {...S(p, ${JSON.stringify(viewBox)})}>${inner}</svg>`);
  if (!viewBox.includes("960")) legacyGrid.push(`${name} (${glyph})`);
  console.log(`  ${name} <- ${glyph}${viewBox.includes("960") ? "" : `  [${viewBox}]`}`);
}

for (const name of Object.keys(MAP)) {
  if (!ORDER.includes(name)) throw new Error(`${name} is mapped but missing from ORDER`);
}

const lines = ORDER.map(name => {
  const glyph = MAP[name];
  const note = glyph ? ` /* ${glyph} */` : "";
  return `export const ${name} = (p: P) => (${bodies.get(name)});${note}`;
});

const out = `/* GENERATED by scripts/gen-icons.ts — do not edit by hand.
 *
 * Glyph geometry is Material Symbols Rounded (weight 400, grade 0, optical size
 * 24), taken verbatim from google/material-design-icons. The trailing comment on
 * each line is the upstream glyph name, so a mismatch between what the app shows
 * and what the design prototype shows is a one-line lookup rather than a hunt.
 *
 * One icon is hand-drawn on purpose and says so where it is defined.
 */
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

/**
 * Material Symbols geometry: filled paths, \`currentColor\`.
 *
 * The grid is passed in per icon rather than fixed, because Material Symbols
 * ships two of them — most glyphs use \`0 -960 960 960\`, some older files use
 * \`0 0 24 24\`. Hard-coding either one silently mis-scales the other.
 */
const S = (props: P, viewBox: string) => ({
  viewBox, fill: "currentColor", ...props,
});

/** Stroke geometry, for the one glyph Material Symbols cannot supply. */
const SS = (props: P) => ({
  viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, ...props,
});

${lines.join("\n")}
`;

await Bun.write("gui/src/icons.tsx", out);
console.log(`\nWrote gui/src/icons.tsx — ${ORDER.length} icons (${Object.keys(KEEP).length} hand-drawn).`);
