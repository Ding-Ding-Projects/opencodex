# Appearance editors

The three controls behind the Appearance screen and the per-tab editor: the
infinite colour picker, the word-depth typography panel, and the font picker.

They replace five `<input type="color">` elements and a three-property
typography section (family, a global size scale, a global weight). The bare
colour input is not a shortfall of polish — it is swatch-and-spectrum in some
engines and a fixed grid in others, carries no alpha, names no colour space,
cannot warn before clipping, reports no contrast, and refuses a CSS variable, so
every call site that used one had to keep a concrete hex fallback beside it and
explain in a hint that the swatch was showing something other than the stored
value.

## Where the logic lives

Almost none of it is in `gui/`. The engines are shared with the documentation
site and are pure, synchronous and DOM-free so they can be exercised without a
browser:

| Module | Responsibility |
|---|---|
| `shared/m3/color.ts` | OKLCh colour model, parsing, formatting, the 14-space translator, gamut, clipping, WCAG contrast |
| `shared/m3/typography.ts` | `TypographyStyle`, the capability table, `typographyCss`, `readTypography` |
| `shared/m3/fonts.ts` | `queryLocalFonts`, the measurement probe, `fvar` axis parsing |
| `shared/m3/anchor.ts` | Placement for anchored, non-modal panels |

`gui/src/components/appearance/` holds the React surfaces, and
`gui/src/theme/fonts.ts` supplies the host description — which faces this app
actually ships — because the shared module's own bundled list describes the docs
site (Geist, Pretendard) and offering those here would list two families the
browser cannot draw.

## Infinite colour picker

`ColorField` renders a trigger showing the current value, and opens `PickerPanel`
in an anchored, non-modal popover.

- **Continuous, not a grid.** A 2-D chroma/lightness field plus a hue ramp and an
  alpha ramp. Swatches, recent colours and the eyedropper are shortcuts layered
  on that field, never replacements for it.
- **The field is a canvas, deliberately.** CSS gradients composite in sRGB, so an
  OKLCh field drawn with them is wrong through the middle of every ramp — the
  exact region a person drags through. A gradient also cannot show where sRGB
  *ends*; the canvas traces a contour along the boundary so the edge is visible
  before it is crossed.
- **Translator.** Named colours, HEX, HEX8, RGB, RGBA, HSL, HSLA, HSV/HSB, HWB,
  CIELAB, CIE LCH, OKLab, OKLCH and CMYK, each copyable. Alpha is carried through
  every conversion.
- **Readouts are computed, never asserted.** The gamut name, the clipping
  warning and both contrast ratios come from `shared/m3/color.ts`, and the
  contrast backdrop is read from the live `--m3-surface` token rather than
  assumed to be white — which is what makes the number true in dark mode.
- **What it emits** is whatever `toCssValue` produces: `oklch()` when the colour
  is outside sRGB, `#rrggbbaa` when alpha is in play, `#rrggbb` otherwise. It
  never normalises on the owner's behalf and never persists anything itself.

### The seed is the one exception

`buildScheme` derives the whole palette through `srgbToOklch`, which reads hex
digits and nothing else. A seed picked outside sRGB is therefore clipped to its
nearest hex on the way into `prefs.seed`. That is a real loss, and the picker's
own clipping warning is what tells the user it is about to happen.

## Word-depth typography

`TypographyEditor` exposes every property `TypographyStyle` models: variable-font
axes, italic and oblique with an angle, underline style/colour/thickness, single
and double strikethrough, overline, capitalization and small caps,
super/subscript, text colour, highlight, outline, shadow, glow, character and
word spacing, line height, baseline shift, direction and alignment.

- **Nothing has a default.** An unset property reads *Inherits* rather than a
  number, and its reset is disabled rather than hidden so rows do not change
  height as properties are cleared. Storing a copy of today's default would stop
  the element following a theme the user changes tomorrow.
- **A property the platform cannot honour stays visible** with a capability note
  explaining what it compiles to and where the mapping is imperfect. The note is
  read from the same `CAPABILITIES` table the CSS generator uses, so the
  explanation and the CSS cannot drift apart. `unknown` is its own state: a
  missing `CSS.supports` is not evidence a feature is missing.
- **Every colour control is the infinite picker.** There is no
  `<input type="color">` in the file.

### How element typography is applied

The six flat overrides (`font`, `color`, `bg`, `radius`, `size`, `pad`) travel as
`--el-<id>-*` custom properties that stylesheets read back through `var()`.
Typography cannot: twenty-eight more variables would each need a `var()` written
by hand into every rule meant to honour it.

So `applyElementTypography` compiles one generated stylesheet instead, mapping
each target id to the selector it renders as (`ELEMENT_SELECTORS`). Each rule is
prefixed `:root ` purely for specificity — the base rules are single-class and so
is the selector, which would otherwise leave the winner to stylesheet order.

Because that channel *concatenates* strings where the inline channel parses them,
`cssText` drops any declaration whose value contains `;`, `{`, `}`, `<`, `\`, a
comment opener or a `url(`. `readTypography` validates persisted values, but a
family name typed into the picker's free-text field never passes through it, so
the check belongs at the function that builds stylesheet text.

`typography.family` wins over the legacy `font` field when both are set; `font`
is still honoured so a profile saved by an older build keeps its face.

## Font picker

- **Three sources, honestly labelled.** `queryLocalFonts` (Chromium-only and
  permission-gated) gives the real list; otherwise families are *measured* by
  rendering candidates against three generics; the bundled faces are always
  present. The note says which happened, and a free-text field accepts any family
  name regardless — a probe list that silently omits the user's favourite face
  looks like a bug, whereas one that says it is a guess is a tool.
- **No unprompted permission dialog.** The catalogue loads on mount *without*
  `allowPrompt`; only the explicit "Use my installed fonts" button asks. A prompt
  nobody requested is one a reader denies permanently out of irritation.
- **Each family is drawn in its own face**, with a mixed-script sample, because a
  list of names in the UI font says nothing about two grotesques and nothing at
  all about whether a face covers 廣東話.
- **Axes are read from the file** via the `fvar` table, not from a hand-written
  table, which would be a claim about a file on someone else's computer.
  `undefined` (could not be read) and `[]` (read, and it is static) are rendered
  differently, because only the second is a reason to stop offering sliders.
- **A surface with nowhere to store axes gets no axis sliders.** The tab editor
  stores one stack; a slider that saves nothing is worse than an absent one.
- The catalogue is memoized in `gui/src/theme/fonts.ts`: the probe is ~700
  `measureText` calls and the shared loader caches nothing, so without it the
  sweep would re-run every time a popover opened.

## Accessibility

- The canvas is a pointer convenience; the numeric L/C/H inputs beneath it are
  the real controls, each focusable, labelled and announced. The field is also
  keyboard-operable (arrows, Shift for larger steps, Page Up/Down, Home/End), but
  nothing is reachable *only* through it.
- Sliders whose value is unset carry `aria-valuetext="Inherits"`, so a screen
  reader never reads the fallback as though it were a chosen value.
- The popover is `role="dialog"` **without** `aria-modal`: nothing behind it is
  inert, and claiming otherwise tells a screen reader the page is unavailable.
- Escape is handled on a **capture-phase** document listener that stops
  propagation, so one Escape closes one layer. The colour field opens inside the
  tab appearance editor, which has its own document-level Escape; without this,
  one keypress closed both.
- Focus returns to the trigger on close, always.
- Hit targets are 44px: ramps are 44px tall, swatches are 32px with a
  negative-inset pseudo-element extending the target without opening grid gaps.

## Failure modes

| Situation | Behaviour |
|---|---|
| No 2-D canvas context (test runner, hardened browser) | The field does not paint; every value, keyboard path and readout still works |
| `getBoundingClientRect` returns zeros | Pointer steering is skipped rather than committing `NaN` |
| Clipboard refused or absent | Copy silently no-ops; the value stays selectable in its row |
| `queryLocalFonts` denied or unsupported | Falls back to the measured probe with a note naming the reason |
| Unparseable text typed into the value field | Kept verbatim, marked `aria-invalid`, nothing committed |
| Corrupt or hand-edited persisted typography | `readTypography` clamps every number, checks every enum, drops unknown keys |

## Verification

```bash
cd gui && npx tsc --noEmit && npx eslint src --max-warnings=0 && bun test tests
```

`gui/tests/appearance-editors.test.tsx` covers the rendered surfaces — including
that no `<input type="color">` survives — and
`gui/tests/element-typography.test.ts` covers the selector map, the stylesheet
escaping guard and the persistence validator.
