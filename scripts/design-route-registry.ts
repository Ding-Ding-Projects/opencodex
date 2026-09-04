/**
 * Hand-written capture-route contract for the desktop parity run.
 *
 * This registry is deliberately separate from the app's route table. The app
 * can add a page without adding a real-built capture, and the capture harness
 * can lose a special interaction state without the router noticing. The route
 * completeness test compares the two sets exactly and also extracts the
 * hand-written special targets from `capture-shots.ts`.
 */

import type { Page } from "../gui/src/app-routing";

export const DESIGN_CAPTURE_TUPLE = {
  theme: "light",
  locale: "bi",
  desktop: { width: 1440, height: 900, scale: 2 },
  phone: { width: 393, height: 852, scale: 3 },
} as const;

export type CaptureReference =
  | { status: "parity-inventory"; note: string }
  | { status: "none"; reason: string };

export interface DesignPageCaptureRoute {
  readonly id: Page;
  readonly hash: string;
  readonly screen: string;
  readonly state: string;
  readonly theme: typeof DESIGN_CAPTURE_TUPLE.theme;
  readonly viewport: "desktop";
  readonly width: 1440;
  readonly height: 900;
  readonly scale: 2;
  readonly locale: typeof DESIGN_CAPTURE_TUPLE.locale;
  readonly reference: CaptureReference;
}

export interface DesignSpecialCaptureRoute {
  readonly id: string;
  readonly hash: string;
  readonly screen: string;
  readonly state: string;
  readonly theme: typeof DESIGN_CAPTURE_TUPLE.theme;
  readonly viewport: "desktop" | "phone";
  readonly width: 1440 | 393;
  readonly height: 900 | 852;
  readonly scale: 2 | 3;
  readonly locale: typeof DESIGN_CAPTURE_TUPLE.locale;
  readonly reference: CaptureReference;
}

const parityInventoryReference = (note: string): CaptureReference => ({
  status: "parity-inventory",
  note,
});

/** Every ordinary desktop `VALID_PAGES` entry appears exactly once here. */
export const DESIGN_PAGE_CAPTURE_REGISTRY = [
  ["dashboard", "Dashboard", "overview"],
  ["startup", "Startup", "startup controls"],
  ["providers", "Providers", "provider list"],
  ["models", "Models", "model catalogue"],
  ["combos", "Combos", "combo workspace"],
  ["subagents", "Subagents", "subagent defaults"],
  ["logs", "Logs & Debug", "logs tab"],
  ["usage", "Usage", "usage history"],
  ["storage", "Storage", "storage policy"],
  ["codex-auth", "Codex Auth", "authentication accounts"],
  ["api", "API", "API keys"],
  ["claude", "Claude", "Claude Code settings"],
  ["grok", "Grok", "Grok settings"],
  ["appearance", "Appearance", "appearance settings"],
  ["language", "Language & voice", "language and narration settings"],
  ["schedule", "Scheduled settings", "empty schedule editor"],
  ["regex", "Regex builder", "empty regex builder"],
  ["changelog", "Changelog", "released changelog entries"],
  ["history", "Version history", "local history list"],
  ["notifications", "Notifications", "notification centre"],
  ["network", "Remote access & backup", "network settings"],
  ["settings", "Settings", "settings landing tab"],
  ["terminal", "Terminal", "terminal page before command preparation"],
  ["docs", "Documentation", "first bundled article: Installation"],
  ["locks", "Toy locks", "empty toy-lock inventory"],
  ["authenticator", "Authenticator", "empty authenticator inventory"],
  ["pdf", "PDF tools", "PDF tool catalogue"],
  ["converter", "File converter", "converter adapter catalogue"],
  ["ollama", "Ollama", "Ollama model store"],
  ["ollama-chat", "Ollama Chat", "empty local chat"],
  ["downloads", "Downloads", "download history"],
] satisfies readonly (readonly [Page, string, string])[];

export const DESIGN_PAGE_CAPTURE_ROUTES: readonly DesignPageCaptureRoute[] =
  DESIGN_PAGE_CAPTURE_REGISTRY.map(([id, screen, state]) => ({
    id,
    hash: id,
    screen,
    state,
    theme: DESIGN_CAPTURE_TUPLE.theme,
    viewport: "desktop",
    width: DESIGN_CAPTURE_TUPLE.desktop.width,
    height: DESIGN_CAPTURE_TUPLE.desktop.height,
    scale: DESIGN_CAPTURE_TUPLE.desktop.scale,
    locale: DESIGN_CAPTURE_TUPLE.locale,
    reference: parityInventoryReference(
      "The checked-in counterpart is resolved by the hand-written design-parity inventory; this route row is never silently omitted when that inventory is reviewed.",
    ),
  })) as readonly DesignPageCaptureRoute[];

/**
 * Special captures are not app pages: they are real interaction states reached
 * from a page. Keep each one named so a missing target cannot hide behind the
 * page route it starts from.
 */
export const DESIGN_SPECIAL_CAPTURE_ROUTES: readonly DesignSpecialCaptureRoute[] = [
  {
    id: "mobile",
    hash: "mobile",
    screen: "opencodex remote",
    state: "phone remote shell",
    theme: DESIGN_CAPTURE_TUPLE.theme,
    viewport: "phone",
    width: DESIGN_CAPTURE_TUPLE.phone.width,
    height: DESIGN_CAPTURE_TUPLE.phone.height,
    scale: DESIGN_CAPTURE_TUPLE.phone.scale,
    locale: DESIGN_CAPTURE_TUPLE.locale,
    reference: {
      status: "none",
      reason: "The paired phone remote is a special mobile surface, not a checked-in desktop design-reference screen; it remains an explicit real-built capture row at its phone tuple.",
    },
  },
  {
    id: "onboarding",
    hash: "dashboard",
    screen: "Dashboard",
    state: "first-run welcome wizard",
    theme: DESIGN_CAPTURE_TUPLE.theme,
    viewport: "desktop",
    width: DESIGN_CAPTURE_TUPLE.desktop.width,
    height: DESIGN_CAPTURE_TUPLE.desktop.height,
    scale: DESIGN_CAPTURE_TUPLE.desktop.scale,
    locale: DESIGN_CAPTURE_TUPLE.locale,
    reference: parityInventoryReference("First-run overlay state is reviewed as a named special capture, not inferred from the dashboard row."),
  },
  {
    id: "confirm",
    hash: "network",
    screen: "Remote access & backup",
    state: "export confirmation dialog",
    theme: DESIGN_CAPTURE_TUPLE.theme,
    viewport: "desktop",
    width: DESIGN_CAPTURE_TUPLE.desktop.width,
    height: DESIGN_CAPTURE_TUPLE.desktop.height,
    scale: DESIGN_CAPTURE_TUPLE.desktop.scale,
    locale: DESIGN_CAPTURE_TUPLE.locale,
    reference: parityInventoryReference("Destructive confirmation is a named overlay state, distinct from its owning page."),
  },
  {
    id: "tab-menu",
    hash: "dashboard",
    screen: "Dashboard",
    state: "tab context menu",
    theme: DESIGN_CAPTURE_TUPLE.theme,
    viewport: "desktop",
    width: DESIGN_CAPTURE_TUPLE.desktop.width,
    height: DESIGN_CAPTURE_TUPLE.desktop.height,
    scale: DESIGN_CAPTURE_TUPLE.desktop.scale,
    locale: DESIGN_CAPTURE_TUPLE.locale,
    reference: parityInventoryReference("Tab context menu is a named overlay state, not covered by the dashboard page row alone."),
  },
  {
    id: "tab-appearance",
    hash: "dashboard",
    screen: "Dashboard",
    state: "tab appearance editor",
    theme: DESIGN_CAPTURE_TUPLE.theme,
    viewport: "desktop",
    width: DESIGN_CAPTURE_TUPLE.desktop.width,
    height: DESIGN_CAPTURE_TUPLE.desktop.height,
    scale: DESIGN_CAPTURE_TUPLE.desktop.scale,
    locale: DESIGN_CAPTURE_TUPLE.locale,
    reference: parityInventoryReference("Shift+right-click tab editor is a named overlay state, not covered by the dashboard page row alone."),
  },
  {
    id: "new-tab",
    hash: "dashboard",
    screen: "Dashboard",
    state: "new-tab picker",
    theme: DESIGN_CAPTURE_TUPLE.theme,
    viewport: "desktop",
    width: DESIGN_CAPTURE_TUPLE.desktop.width,
    height: DESIGN_CAPTURE_TUPLE.desktop.height,
    scale: DESIGN_CAPTURE_TUPLE.desktop.scale,
    locale: DESIGN_CAPTURE_TUPLE.locale,
    reference: parityInventoryReference("New-tab picker is a named overlay state, not covered by the dashboard page row alone."),
  },
  {
    id: "regex-popover",
    hash: "notifications",
    screen: "Notifications",
    state: "anchored regex builder popover",
    theme: DESIGN_CAPTURE_TUPLE.theme,
    viewport: "desktop",
    width: DESIGN_CAPTURE_TUPLE.desktop.width,
    height: DESIGN_CAPTURE_TUPLE.desktop.height,
    scale: DESIGN_CAPTURE_TUPLE.desktop.scale,
    locale: DESIGN_CAPTURE_TUPLE.locale,
    reference: parityInventoryReference("Anchored regex builder is a named overlay state, distinct from the Regex builder destination."),
  },
  {
    id: "notification-centre",
    hash: "dashboard",
    screen: "Dashboard",
    state: "anchored notification centre",
    theme: DESIGN_CAPTURE_TUPLE.theme,
    viewport: "desktop",
    width: DESIGN_CAPTURE_TUPLE.desktop.width,
    height: DESIGN_CAPTURE_TUPLE.desktop.height,
    scale: DESIGN_CAPTURE_TUPLE.desktop.scale,
    locale: DESIGN_CAPTURE_TUPLE.locale,
    reference: parityInventoryReference("Notification centre is a named overlay state, not covered by the dashboard page row alone."),
  },
  {
    id: "cost-meter",
    hash: "dashboard",
    screen: "Dashboard",
    state: "cost basis menu",
    theme: DESIGN_CAPTURE_TUPLE.theme,
    viewport: "desktop",
    width: DESIGN_CAPTURE_TUPLE.desktop.width,
    height: DESIGN_CAPTURE_TUPLE.desktop.height,
    scale: DESIGN_CAPTURE_TUPLE.desktop.scale,
    locale: DESIGN_CAPTURE_TUPLE.locale,
    reference: parityInventoryReference("Cost basis menu is a named overlay state, not covered by the dashboard page row alone."),
  },
  {
    id: "account-switcher",
    hash: "dashboard",
    screen: "Dashboard",
    state: "Codex account switcher",
    theme: DESIGN_CAPTURE_TUPLE.theme,
    viewport: "desktop",
    width: DESIGN_CAPTURE_TUPLE.desktop.width,
    height: DESIGN_CAPTURE_TUPLE.desktop.height,
    scale: DESIGN_CAPTURE_TUPLE.desktop.scale,
    locale: DESIGN_CAPTURE_TUPLE.locale,
    reference: parityInventoryReference("Account switcher is a named overlay state, not covered by the dashboard page row alone."),
  },
  {
    id: "snackbar",
    hash: "language",
    screen: "Language & voice",
    state: "narrator notification",
    theme: DESIGN_CAPTURE_TUPLE.theme,
    viewport: "desktop",
    width: DESIGN_CAPTURE_TUPLE.desktop.width,
    height: DESIGN_CAPTURE_TUPLE.desktop.height,
    scale: DESIGN_CAPTURE_TUPLE.desktop.scale,
    locale: DESIGN_CAPTURE_TUPLE.locale,
    reference: parityInventoryReference("The transient notification is a named state; its known shutter-timing gap remains open for the later capture lane."),
  },
  {
    id: "dimsum",
    hash: "dashboard",
    screen: "Dashboard",
    state: "deterministic dim-sum surprise",
    theme: DESIGN_CAPTURE_TUPLE.theme,
    viewport: "desktop",
    width: DESIGN_CAPTURE_TUPLE.desktop.width,
    height: DESIGN_CAPTURE_TUPLE.desktop.height,
    scale: DESIGN_CAPTURE_TUPLE.desktop.scale,
    locale: DESIGN_CAPTURE_TUPLE.locale,
    reference: parityInventoryReference("The startup surprise is a named transient state; it is not silently folded into the dashboard row."),
  },
  {
    id: "download-history",
    hash: "downloads",
    screen: "Downloads",
    state: "completed transfer history",
    theme: DESIGN_CAPTURE_TUPLE.theme,
    viewport: "desktop",
    width: DESIGN_CAPTURE_TUPLE.desktop.width,
    height: DESIGN_CAPTURE_TUPLE.desktop.height,
    scale: DESIGN_CAPTURE_TUPLE.desktop.scale,
    locale: DESIGN_CAPTURE_TUPLE.locale,
    reference: {
      status: "none",
      reason: "The historical image came from an unsaved browser-extension run; the later capture uses a named real transfer through the shipped download API and does not invent a design-reference counterpart.",
    },
  },
];
