/* Inline SVG icons (Lucide-style, stroke=currentColor). No icon-library dependency. */
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const S = (props: P) => ({
  viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, ...props,
});

export const IconGrid = (p: P) => (<svg {...S(p)}><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>);
export const IconServer = (p: P) => (<svg {...S(p)}><rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/></svg>);
export const IconBoxes = (p: P) => (<svg {...S(p)}><path d="M12 2 4 6v6l8 4 8-4V6l-8-4Z"/><path d="m4 6 8 4 8-4M12 10v8"/></svg>);
export const IconBot = (p: P) => (<svg {...S(p)}><rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V4M8 2h8"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/></svg>);
export const IconList = (p: P) => (<svg {...S(p)}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>);
export const IconMenu = (p: P) => (<svg {...S(p)}><path d="M4 6h16M4 12h16M4 18h16"/></svg>);
/* Stat-tile marks the prototype leads its usage and dashboard figures with. Named
   after the Material Symbols glyph each one stands in for, so a future swap to the
   real icon font is a rename rather than a hunt. */
export const IconTag = (p: P) => (<svg {...S(p)}><path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.2"/></svg>);
export const IconClock = (p: P) => (<svg {...S(p)}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>);
export const IconSwapVert = (p: P) => (<svg {...S(p)}><path d="M7 4v16M7 4 4 7.5M7 4l3 3.5"/><path d="M17 20V4m0 16 3-3.5M17 20l-3-3.5"/></svg>);
export const IconDataUsage = (p: P) => (<svg {...S(p)}><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 9 9h-9Z"/></svg>);
export const IconCoin = (p: P) => (<svg {...S(p)}><circle cx="12" cy="12" r="9"/><path d="M14.5 9.2a3 3 0 0 0-5 2.2c0 2.6 5 1.4 5 3.6a3 3 0 0 1-5 1.9M12 7.2v9.6"/></svg>);
export const IconGauge = (p: P) => (<svg {...S(p)}><path d="M3.5 17a9 9 0 1 1 17 0"/><path d="M12 17l4-5"/></svg>);

/* Window controls for the frameless desktop shell. Thinner strokes than the rest of
   the set on purpose: these sit where the OS used to draw its own, and a 2px glyph
   there reads as a toolbar button rather than window chrome. */
export const IconWinMinimize = (p: P) => (<svg {...S(p)} strokeWidth={1.5}><path d="M6 12h12"/></svg>);
export const IconWinMaximize = (p: P) => (<svg {...S(p)} strokeWidth={1.5}><rect x="6.5" y="6.5" width="11" height="11" rx="1"/></svg>);
export const IconWinRestore = (p: P) => (<svg {...S(p)} strokeWidth={1.5}><rect x="5.5" y="8.5" width="10" height="10" rx="1"/><path d="M8.5 5.5h10v10"/></svg>);
export const IconTerminal = (p: P) => (<svg {...S(p)}><path d="m4 17 6-5-6-5"/><path d="M12 19h8"/></svg>);
export const IconActivity = (p: P) => (<svg {...S(p)}><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>);
export const IconHardDrive = (p: P) => (<svg {...S(p)}><path d="M22 12H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/><path d="M6 16h.01M10 16h.01"/></svg>);

export const IconCheck = (p: P) => (<svg {...S(p)}><path d="m20 6-11 11-5-5"/></svg>);
export const IconX = (p: P) => (<svg {...S(p)}><path d="M18 6 6 18M6 6l12 12"/></svg>);
export const IconPlus = (p: P) => (<svg {...S(p)}><path d="M12 5v14M5 12h14"/></svg>);
export const IconRefresh = (p: P) => (<svg {...S(p)}><path d="M21 12a9 9 0 0 1-9 9 9.8 9.8 0 0 1-6.7-2.7L3 16M3 21v-5h5M3 12a9 9 0 0 1 9-9 9.8 9.8 0 0 1 6.7 2.7L21 8M21 3v5h-5"/></svg>);
export const IconPause = (p: P) => (<svg {...S(p)}><path d="M8 5v14M16 5v14"/></svg>);
export const IconPlay = (p: P) => (<svg {...S(p)}><path d="m7 4 13 8-13 8Z"/></svg>);
export const IconTrash = (p: P) => (<svg {...S(p)}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>);
export const IconAlert = (p: P) => (<svg {...S(p)}><path d="M10.3 3.7 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>);
export const IconInfo = (p: P) => (<svg {...S(p)}><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>);
export const IconSearch = (p: P) => (<svg {...S(p)}><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>);
export const IconArrowUp = (p: P) => (<svg {...S(p)}><path d="M12 19V5M5 12l7-7 7 7"/></svg>);
export const IconArrowDown = (p: P) => (<svg {...S(p)}><path d="M12 5v14M19 12l-7 7-7-7"/></svg>);
export const IconChevron = (p: P) => (<svg {...S(p)}><path d="m9 18 6-6-6-6"/></svg>);
export const IconGithub = (p: P) => (<svg {...S(p)}><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 0 0-.9-2.6c3-.3 6.2-1.5 6.2-6.7A5.2 5.2 0 0 0 20 4.8 4.9 4.9 0 0 0 19.9 1S18.7.6 16 2.5a13.4 13.4 0 0 0-7 0C6.3.6 5.1 1 5.1 1A4.9 4.9 0 0 0 5 4.8a5.2 5.2 0 0 0-1.4 3.7c0 5.1 3.1 6.4 6.1 6.7a3.4 3.4 0 0 0-.9 2.5V22"/></svg>);
export const IconPower = (p: P) => (<svg {...S(p)}><path d="M18.4 5.6a9 9 0 1 1-12.8 0"/><path d="M12 2v10"/></svg>);
export const IconExternal = (p: P) => (<svg {...S(p)}><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>);
export const IconKey = (p: P) => (<svg {...S(p)}><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.6-9.6M16 7l3 3M14 9l2 2"/></svg>);

export const IconLock = (p: P) => (<svg {...S(p)}><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>);
export const IconTicket = (p: P) => (<svg {...S(p)}><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/></svg>);
export const IconLink = (p: P) => (<svg {...S(p)}><path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8"/></svg>);
export const IconSun = (p: P) => (<svg {...S(p)}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>);
export const IconMoon = (p: P) => (<svg {...S(p)}><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg>);
export const IconMonitor = (p: P) => (<svg {...S(p)}><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>);
export const IconGlobe = (p: P) => (<svg {...S(p)}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>);
export const IconSparkle = (p: P) => (<svg {...S(p)}><path d="M12 3v18M5.6 5.6l12.8 12.8M3 12h18M5.6 18.4 18.4 5.6"/></svg>);
/** Crossed arrows — Combos workspace nav / rail marker (load-balance / hop). */
export const IconShuffle = (p: P) => (
  <svg {...S(p)}>
    <path d="m18 14 4 4-4 4" />
    <path d="m18 2 4 4-4 4" />
    <path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22" />
    <path d="M2 6h1.972a4 4 0 0 1 3.6 2.2" />
    <path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45" />
  </svg>
);
export const IconGrip = (p: P) => (
  <svg {...S(p)}>
    <circle cx="9" cy="6" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="6" r="1" fill="currentColor" stroke="none" />
    <circle cx="9" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="9" cy="18" r="1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="18" r="1" fill="currentColor" stroke="none" />
  </svg>
);
export const IconStar = (p: P) => (<svg {...S(p)}><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>);
export const IconFilter = (p: P) => (<svg {...S(p)}><path d="M4 5h16l-6 7v5l-4 2v-7L4 5z"/></svg>);

/* --- Material 3 shell additions: nav entries and app-bar affordances --- */
export const IconPalette = (p: P) => (<svg {...S(p)}><path d="M12 21a9 9 0 1 1 9-9c0 2-1.6 3-3 3h-1.5a2 2 0 0 0-1.4 3.4A1.8 1.8 0 0 1 12 21Z"/><circle cx="7.5" cy="12" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="15" cy="8" r="1"/></svg>);
export const IconTranslate = (p: P) => (<svg {...S(p)}><path d="M3 5h10M8 3v2M10.5 5c0 4-3 8-7 9"/><path d="M5 12c2 2.5 4.5 4 7 4.5"/><path d="m13 21 4.5-11L22 21M14.8 17.5h5.4"/></svg>);
export const IconRegex = (p: P) => (<svg {...S(p)}><path d="M17 4v8M13.5 6l7 4M20.5 6l-7 4"/><rect x="3" y="15" width="5" height="5" rx="1.5"/></svg>);
export const IconChangelog = (p: P) => (<svg {...S(p)}><path d="M5 4h9l5 5v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M14 4v5h5M8 13h7M8 17h5"/></svg>);
export const IconHistory = (p: P) => (<svg {...S(p)}><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3.5 2"/></svg>);
export const IconBell = (p: P) => (<svg {...S(p)}><path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>);
export const IconPin = (p: P) => (<svg {...S(p)}><path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Z"/></svg>);
export const IconDevices = (p: P) => (<svg {...S(p)}><rect x="2" y="5" width="13" height="9" rx="1.5"/><path d="M5 18h7"/><rect x="16" y="9" width="6" height="11" rx="1.5"/></svg>);
export const IconBolt = (p: P) => (<svg {...S(p)}><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/></svg>);
export const IconUndo = (p: P) => (<svg {...S(p)}><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/></svg>);
export const IconCopy = (p: P) => (<svg {...S(p)}><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>);
export const IconDownload = (p: P) => (<svg {...S(p)}><path d="M12 3v12M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>);
export const IconVolume = (p: P) => (<svg {...S(p)}><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/></svg>);
