/* ============================================================================
   Material 3 token engine — ported from `design/OpenCodex M3.dc.html`
   (`Component.buildScheme` / `densityTokens` / `typeTokens` / `applyTokens`).

   Seed hex -> OKLCh -> six tonal palettes -> M3 role tokens. Tone maps to
   OKLab lightness with `L = (tone + 16) / 116` above tone 8, which is exact
   for neutrals (OKLab L of a grey is Y^(1/3)) and tracks HCT closely enough
   that we do not have to ship a colour-science dependency.
   ============================================================================ */

import { cssText, typographyCss, type TypographyStyle } from '../../../shared/m3/typography'

export type ThemeMode = 'light' | 'dark' | 'system'
export type DensityLevel = 1 | 2 | 3 | 4 | 5

/** Per-element appearance overrides, written as `--el-<id>-*` custom properties. */
export interface ElementStyle {
  font?: string
  color?: string
  bg?: string
  radius?: number
  size?: number
  pad?: number
  /**
   * The full word-processor typography for this target.
   *
   * Kept apart from the six fields above because it cannot travel the same way.
   * Those are single values a stylesheet reads back through `var()`, and adding
   * twenty-eight more would mean twenty-eight new `var()` calls hand-written
   * into every rule — a surface nobody could keep in step. This one is compiled
   * to a real CSS rule instead (see `applyElementTypography`).
   *
   * `typography.family` wins over `font` when both are set. `font` predates this
   * and is still honoured so a profile saved by an older build keeps its face,
   * but the editor writes only `typography` now.
   */
  typography?: TypographyStyle
}

export interface ApplyTokensOptions {
  seed: string
  dark: boolean
  density: DensityLevel
  fontStack: string
  fontScale: number
  fontWeight: number
  elementStyles?: Record<string, ElementStyle | undefined>
}

/* ---------------------------------------------------------------- colour -- */

interface Chroma {
  C: number
  H: number
}

/** sRGB hex -> OKLCh chroma + hue. Lightness is discarded; tone drives it. */
export function srgbToOklch(hex: string): Chroma {
  const h = String(hex).replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0').slice(0, 6)
  const to = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  const r = lin(to(0))
  const g = lin(to(2))
  const b = lin(to(4))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  let hue = (Math.atan2(B, A) * 180) / Math.PI
  if (hue < 0) hue += 360
  return { C: Math.sqrt(A * A + B * B), H: hue }
}

/** HCT tone (= CIE L*) mapped to OKLab lightness; exact for neutrals. */
export function toneL(t: number): number {
  return t > 8 ? (t + 16) / 116 : Math.cbrt(t / 903.3)
}

/** One tonal-palette entry as an `oklch()` string. */
export function swatch(hue: number, chroma: number, tone: number): string {
  const L = toneL(tone)
  // Taper chroma at the extremes so containers stay legible instead of clipping hard.
  const taper = 1 - Math.pow(Math.min(1, Math.abs(L - 0.58) / 0.58), 2) * 0.42
  const C = Math.max(0, chroma * taper)
  return `oklch(${(L * 100).toFixed(2)}% ${C.toFixed(4)} ${hue.toFixed(2)})`
}

type PaletteKey = 'p' | 's' | 't' | 'n' | 'v' | 'e' | 'ok' | 'warn'

/**
 * Derive the full M3 role-token map from a seed colour.
 *
 * Keys are returned unprefixed (`primary`, `on-primary`, …); `applyTokens`
 * writes them as `--m3-<key>`.
 */
export function buildScheme(seedHex: string, dark: boolean): Record<string, string> {
  const { C, H } = srgbToOklch(seedHex)
  const pc = Math.max(0.055, Math.min(C, 0.17))
  const pal: Record<PaletteKey, { h: number; c: number }> = {
    p: { h: H, c: pc },
    s: { h: H, c: Math.max(0.022, pc * 0.34) },
    t: { h: (H + 60) % 360, c: Math.max(0.03, pc * 0.52) },
    n: { h: H, c: 0.006 },
    v: { h: H, c: 0.016 },
    e: { h: 27, c: 0.16 },
    ok: { h: 158, c: 0.11 },
    warn: { h: 75, c: 0.13 },
  }
  const S = (k: PaletteKey, tone: number) => swatch(pal[k].h, pal[k].c, tone)

  return dark
    ? {
        primary: S('p', 80), 'on-primary': S('p', 20), 'primary-container': S('p', 30), 'on-primary-container': S('p', 90),
        secondary: S('s', 80), 'on-secondary': S('s', 20), 'secondary-container': S('s', 30), 'on-secondary-container': S('s', 90),
        tertiary: S('t', 80), 'on-tertiary': S('t', 20), 'tertiary-container': S('t', 30), 'on-tertiary-container': S('t', 90),
        error: S('e', 80), 'on-error': S('e', 20), 'error-container': S('e', 30), 'on-error-container': S('e', 90),
        ok: S('ok', 80), 'on-ok-container': S('ok', 90), 'ok-container': S('ok', 30),
        warn: S('warn', 80), 'on-warn-container': S('warn', 90), 'warn-container': S('warn', 30),
        surface: S('n', 6), 'on-surface': S('n', 90), 'surface-variant': S('v', 30), 'on-surface-variant': S('v', 80),
        'surface-container-lowest': S('n', 4), 'surface-container-low': S('n', 10), 'surface-container': S('n', 12),
        'surface-container-high': S('n', 17), 'surface-container-highest': S('n', 22),
        'surface-dim': S('n', 6), 'surface-bright': S('n', 24),
        'inverse-surface': S('n', 90), 'inverse-on-surface': S('n', 20), 'inverse-primary': S('p', 40),
        outline: S('v', 60), 'outline-variant': S('v', 30), scrim: S('n', 0),
      }
    : {
        primary: S('p', 40), 'on-primary': S('p', 100), 'primary-container': S('p', 90), 'on-primary-container': S('p', 10),
        secondary: S('s', 40), 'on-secondary': S('s', 100), 'secondary-container': S('s', 90), 'on-secondary-container': S('s', 10),
        tertiary: S('t', 40), 'on-tertiary': S('t', 100), 'tertiary-container': S('t', 90), 'on-tertiary-container': S('t', 10),
        error: S('e', 40), 'on-error': S('e', 100), 'error-container': S('e', 90), 'on-error-container': S('e', 10),
        ok: S('ok', 38), 'on-ok-container': S('ok', 10), 'ok-container': S('ok', 90),
        warn: S('warn', 36), 'on-warn-container': S('warn', 10), 'warn-container': S('warn', 90),
        surface: S('n', 98), 'on-surface': S('n', 10), 'surface-variant': S('v', 90), 'on-surface-variant': S('v', 30),
        'surface-container-lowest': S('n', 100), 'surface-container-low': S('n', 96), 'surface-container': S('n', 94),
        'surface-container-high': S('n', 92), 'surface-container-highest': S('n', 90),
        'surface-dim': S('n', 87), 'surface-bright': S('n', 98),
        'inverse-surface': S('n', 20), 'inverse-on-surface': S('n', 95), 'inverse-primary': S('p', 80),
        outline: S('v', 50), 'outline-variant': S('v', 80), scrim: S('n', 0),
      }
}

/* --------------------------------------------------------------- density -- */

/** Level 1 is M3 comfortable; level 5 matches the legacy console density. */
export function densityTokens(level: DensityLevel): Record<string, string> {
  const k = (a: number, b: number) => Math.round(a + ((b - a) * (level - 1)) / 4)
  return {
    '--h-btn': k(56, 36) + 'px',
    '--h-row': k(64, 40) + 'px',
    '--h-appbar': k(72, 56) + 'px',
    '--h-tab': k(44, 34) + 'px',
    '--h-nav': k(56, 44) + 'px',
    '--h-stat': k(112, 76) + 'px',
    '--pad-card': k(24, 12) + 'px',
    '--page-pad-y': k(32, 16) + 'px',
    '--page-pad-x': k(32, 16) + 'px',
    '--sp-1': k(8, 4) + 'px',
    '--sp-2': k(12, 8) + 'px',
    '--sp-3': k(16, 10) + 'px',
    '--sp-4': k(24, 14) + 'px',
    '--sp-5': k(32, 18) + 'px',
  }
}

/** M3 type scale times a user scale multiplier. */
export function typeTokens(scale: number): Record<string, string> {
  const t = (px: number) => (px * scale).toFixed(2) + 'px'
  return {
    '--t-display-s': t(36), '--t-headline-s': t(24), '--t-title-l': t(22), '--t-title-m': t(16),
    '--t-title-s': t(14), '--t-body-l': t(16), '--t-body-m': t(14), '--t-body-s': t(12.5),
    '--t-label-l': t(14), '--t-label-m': t(12), '--t-label-s': t(11),
  }
}

/* ----------------------------------------------------------------- shape -- */

/**
 * The M3 corner scale.
 *
 * `--r-xs` (4dp, M3's extra-small — chips, snackbars, small indicator rails) was
 * missing, and its absence was doing visible damage rather than nothing: with no
 * token to reach for, stylesheets wrote `border-radius: 4px` by hand, and a
 * hand-written radius is one the appearance editor cannot reach. Every corner in
 * this app is supposed to be a customisation target; a literal silently opts out
 * of that and there is no way to tell from the screen which corners did.
 *
 * The steps are M3's own — 4 / 8 / 12 / 16 / 28 / full — so a value that does not
 * appear here is a value that does not belong in the design system either. When
 * something wants 10px, the answer is 8 or 12, not a sixth step.
 */
export const SHAPE_TOKENS: Record<string, string> = {
  '--r-xs': '4px',
  '--r-s': '8px',
  '--r-m': '12px',
  '--r-l': '16px',
  '--r-xl': '28px',
  '--r-pill': '999px',
}

export function elevationTokens(dark: boolean): Record<string, string> {
  return {
    '--e1': dark
      ? '0 1px 3px rgba(0,0,0,.5), 0 1px 2px rgba(0,0,0,.4)'
      : '0 1px 3px rgba(0,0,0,.10), 0 1px 2px rgba(0,0,0,.06)',
    '--e2': dark
      ? '0 2px 6px rgba(0,0,0,.55), 0 1px 2px rgba(0,0,0,.4)'
      : '0 2px 6px rgba(0,0,0,.12), 0 1px 2px rgba(0,0,0,.07)',
    '--e3': dark
      ? '0 8px 24px rgba(0,0,0,.6), 0 2px 6px rgba(0,0,0,.4)'
      : '0 8px 24px rgba(0,0,0,.14), 0 2px 6px rgba(0,0,0,.08)',
  }
}

/* ----------------------------------------------------------------- apply -- */

/** Resolve a `ThemeMode` against the OS preference. */
export function resolveDark(theme: ThemeMode): boolean {
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches
}

/** Write the whole token set onto an element (normally `document.documentElement`). */
export function applyTokens(el: HTMLElement, opts: ApplyTokensOptions): void {
  const { seed, dark, density, fontStack, fontScale, fontWeight, elementStyles } = opts

  const scheme = buildScheme(seed, dark)
  for (const key in scheme) el.style.setProperty('--m3-' + key, scheme[key])

  for (const [key, value] of Object.entries(densityTokens(density))) el.style.setProperty(key, value)
  for (const [key, value] of Object.entries(typeTokens(fontScale))) el.style.setProperty(key, value)
  // The raw multiplier, not just the derived `--t-*` roles.
  //
  // `styles.css` carries its own eight-step type scale in fixed pixels, and 83
  // live elements still render through it. Those sizes were aliased onto
  // nothing, so the font-size slider moved `--t-*` while every legacy `.text-*`
  // element stayed exactly where it was — the control appeared to do nothing on
  // any screen that had not been migrated. Exporting the multiplier lets that
  // scale multiply itself without restating the M3 ramp, and without changing
  // any size at the default scale of 1.
  el.style.setProperty('--m3-type-scale', String(fontScale))
  for (const [key, value] of Object.entries(SHAPE_TOKENS)) el.style.setProperty(key, value)
  for (const [key, value] of Object.entries(elevationTokens(dark))) el.style.setProperty(key, value)

  el.style.setProperty('--m3-font', fontStack)
  el.style.setProperty('--m3-fw', String(fontWeight))
  el.style.colorScheme = dark ? 'dark' : 'light'

  for (const id in elementStyles) {
    const o = elementStyles[id]
    if (!o) continue
    if (o.font) el.style.setProperty(`--el-${id}-font`, o.font)
    if (o.color) el.style.setProperty(`--el-${id}-color`, o.color)
    if (o.bg) el.style.setProperty(`--el-${id}-bg`, o.bg)
    if (o.radius != null) el.style.setProperty(`--el-${id}-radius`, o.radius + 'px')
    if (o.size != null) el.style.setProperty(`--el-${id}-size`, o.size + 'px')
    if (o.pad != null) el.style.setProperty(`--el-${id}-pad`, o.pad + 'px')
  }
}

/** Clear every `--el-<id>-*` override for one target. */
export function clearElementStyle(el: HTMLElement, id: string): void {
  for (const prop of ['font', 'color', 'bg', 'radius', 'size', 'pad']) {
    el.style.removeProperty(`--el-${id}-${prop}`)
  }
}

/* --------------------------------------------------- element typography -- */

/**
 * The CSS selector each editable target actually renders as.
 *
 * The `--el-<id>-*` channel needs no such map — a stylesheet names its own
 * variables — but a compiled typography rule has to be *written*, so it needs to
 * know what to write it against. Keys match `ELEMENT_TARGETS` in
 * `prefs-context.ts`; a target with no entry here simply gets no typography rule
 * rather than a rule against a selector that matches nothing.
 */
export const ELEMENT_SELECTORS: Record<string, string> = {
  navRail: '.m3-nav',
  tabStrip: '.m3-tabstrip',
  appBar: '.m3-appbar',
  card: '.m3-card',
  table: '.m3-table',
  button: '.m3-btn',
  iconButton: '.m3-icon-btn',
  input: '.m3-input',
  chip: '.m3-chip',
  menu: '.m3-menu',
  select: '.m3-select',
  // The visible card, not `.m3-dialog` — that is the native `<dialog>` element
  // itself, which spans the viewport and IS the scrim. Styling the scrim when
  // the user right-clicked the dialog is not what they asked for.
  dialog: '.m3-dialog__surface',
  banner: '.m3-banner',
  bottomNav: '.m3-bottom-nav',
  statCard: '.dash-stat-card',
  remotePanel: '.m3-mob__session',
}

/** The id of the single generated `<style>` element. */
export const ELEMENT_TYPE_STYLE_ID = 'ocx-element-typography'

/**
 * Compile every target's typography into one stylesheet.
 *
 * Returned as text rather than written, so the whole mapping can be asserted in
 * a test with no DOM at all — which matters because the failure mode here is
 * silent: a rule against the wrong selector applies to nothing and looks exactly
 * like a control that does not work.
 *
 * Each rule is prefixed with `:root ` purely for specificity. The base rules it
 * has to beat (`.m3-card { font-family: var(--el-card-font, inherit) }`) are
 * single-class, and so is `.m3-card` — leaving which one wins to stylesheet
 * order, which is a bundler's decision and not ours to rely on. `:root .m3-card`
 * outranks them without reaching for `!important`, which would in turn be
 * unbeatable by anything downstream.
 */
export function elementTypographyCss(elementStyles: Record<string, ElementStyle | undefined> | undefined): string {
  if (!elementStyles) return ''
  const rules: string[] = []
  for (const id of Object.keys(elementStyles)) {
    const selector = ELEMENT_SELECTORS[id]
    const typography = elementStyles[id]?.typography
    if (!selector || !typography) continue
    const declarations = cssText(typographyCss(typography))
    if (declarations) rules.push(`:root ${selector} { ${declarations} }`)
  }
  return rules.join('\n')
}

/**
 * Put that stylesheet into the document, creating or clearing the one node.
 *
 * One node reused rather than one per target: a node per target leaks a `<style>`
 * every time a target is edited and then reset, and the order they end up in
 * decides which of two overlapping rules wins.
 */
export function applyElementTypography(
  doc: Document,
  elementStyles: Record<string, ElementStyle | undefined> | undefined,
): void {
  const css = elementTypographyCss(elementStyles)
  let node = doc.getElementById(ELEMENT_TYPE_STYLE_ID)
  if (!css) {
    node?.remove()
    return
  }
  if (!node) {
    node = doc.createElement('style')
    node.id = ELEMENT_TYPE_STYLE_ID
    doc.head.appendChild(node)
  }
  if (node.textContent !== css) node.textContent = css
}

/* --------------------------------------------------------------- layout -- */

export type WindowClass = 'compact' | 'medium' | 'expanded'

/** M3 adaptive breakpoints, measured in JS so an emulated frame width works too. */
export function windowClass(width: number): WindowClass {
  return width < 600 ? 'compact' : width < 1240 ? 'medium' : 'expanded'
}

/** Nav geometry for the current window class: bottom bar / rail / drawer. */
export function applyLayout(el: HTMLElement, width: number): WindowClass {
  const mode = windowClass(width)
  el.style.setProperty('--nav-w', mode === 'compact' ? '0px' : mode === 'medium' ? '88px' : '300px')
  el.style.setProperty('--nav-pad', mode === 'expanded' ? '12px' : '8px')
  el.style.setProperty('--nav-brand-pad', mode === 'expanded' ? '8px' : '0px')
  return mode
}

/* ---------------------------------------------------------------- fonts -- */

export interface FontChoice {
  id: string
  label: string
  stack: string
}

/**
 * Bundled faces only — `docs/design-system/foundations.md` forbids CDN fonts
 * because the dashboard has to open offline.
 */
export const FONT_CHOICES: FontChoice[] = [
  { id: 'roboto-flex', label: 'Roboto Flex', stack: "'Roboto Flex', 'Noto Sans HK', system-ui, sans-serif" },
  { id: 'roboto', label: 'Roboto', stack: "Roboto, 'Noto Sans HK', system-ui, sans-serif" },
  { id: 'system', label: 'System UI', stack: "system-ui, -apple-system, 'Noto Sans HK', sans-serif" },
  { id: 'noto-hk', label: 'Noto Sans HK', stack: "'Noto Sans HK', 'Roboto Flex', sans-serif" },
  { id: 'mono', label: 'Roboto Mono', stack: "'Roboto Mono', ui-monospace, monospace" },
]

export const DEFAULT_FONT_STACK = FONT_CHOICES[0].stack

export function fontStackFor(id: string): string {
  return FONT_CHOICES.find((f) => f.id === id)?.stack ?? DEFAULT_FONT_STACK
}

/** Curated seeds offered beside the free colour picker on the Appearance screen. */
/**
 * The eight curated seeds, in the prototype's order and with its exact values.
 *
 * These had drifted: four of the eight differed, the order differed, and the
 * teal was `#00696E` against the design's `#00696D` — one digit, which no
 * screenshot comparison would ever catch but which derives a whole tonal palette
 * from the wrong starting point. The design also carries a mauve the dashboard
 * had dropped, and the dashboard had gained a violet the design never had.
 *
 * Read off `design/OpenCodex M3.dc.html`. If they diverge again, that file wins.
 */
export const SEED_SWATCHES = [
  '#2F6B4F', '#6750A4', '#0B57D0', '#8C4A1F',
  '#B3261E', '#00696D', '#7D5260', '#4A4458',
]

export const DEFAULT_SEED = SEED_SWATCHES[0]
