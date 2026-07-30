/**
 * Appearance — the prototype's surfaces, in its order: the page lead, the
 * settings-search row, one settings card (theme, seed + role swatches, density,
 * typography), the per-element editors, then the live preview.
 *
 * Everything writes through `usePrefs()`, so the whole shell retints live;
 * nothing here needs a reload or a save button.
 */

import { useState, type CSSProperties, type ReactNode } from "react";
import { Button, Card, Chip, Segmented, Slider, TextInput } from "../shell/m3-ui";
import { IconRegex, IconSearch } from "../icons";
import { useT } from "../i18n/shared";
import { ELEMENT_TARGETS, usePrefs } from "../theme/prefs-context";
import { FONT_CHOICES, SEED_SWATCHES, type DensityLevel, type ThemeMode } from "../theme/m3";
import { recordRevision } from "../shell/revisions";
import { useNotifications } from "../shell/notifications-context";
import type { TKey } from "../i18n/shared";

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Shown when a target carries no override of its own; mirrors the prototype. */
const EL_RADIUS_DEFAULT = 16;
const EL_PAD_DEFAULT = 16;

/**
 * `<input type="color">` refuses a CSS variable, so an override-less swatch has
 * to fall back to a concrete hex. The swatch's tooltip says "inherits theme" so
 * that fallback is never mistaken for an applied override.
 */
const COLOR_FALLBACK = "#000000";
const BG_FALLBACK = "#ffffff";

/** The regex builder's own cap, applied here too so one search cannot outgrow it. */
const PATTERN_CAP = 400;

const MONO: CSSProperties = { fontFamily: "var(--mono)" };

const COLOR_SWATCH: CSSProperties = {
  width: 56,
  height: 48,
  padding: 2,
  border: "1px solid var(--m3-outline)",
  borderRadius: "var(--r-s)",
  background: "var(--m3-surface-container-lowest)",
  cursor: "pointer",
};

/**
 * The six role chips the prototype prints under the seed picker: one look at
 * whether the derived palette is legible before it is applied everywhere.
 * These are the M3 roles themselves, so they are named by role, not by hex.
 */
const ROLE_SWATCHES: { tkey: TKey; bg: string; fg: string }[] = [
  { tkey: "appearance.rolePrimary", bg: "var(--m3-primary)", fg: "var(--m3-on-primary)" },
  { tkey: "appearance.roleContainer", bg: "var(--m3-primary-container)", fg: "var(--m3-on-primary-container)" },
  { tkey: "appearance.roleSecondary", bg: "var(--m3-secondary-container)", fg: "var(--m3-on-secondary-container)" },
  { tkey: "appearance.roleTertiary", bg: "var(--m3-tertiary-container)", fg: "var(--m3-on-tertiary-container)" },
  { tkey: "appearance.roleError", bg: "var(--m3-error-container)", fg: "var(--m3-on-error-container)" },
  { tkey: "appearance.roleSurface", bg: "var(--m3-surface-container-highest)", fg: "var(--m3-on-surface-variant)" },
];

const ROLE_SWATCH_STYLE: CSSProperties = {
  display: "grid",
  placeItems: "center",
  minWidth: 96,
  height: 56,
  borderRadius: "var(--r-m)",
  fontSize: "var(--t-label-m)",
};

const HIT_ROW: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 10,
  padding: "10px 12px",
  borderRadius: "var(--r-s)",
  background: "var(--m3-surface-container-highest)",
};

interface SettingRow {
  id: string;
  label: string;
  desc: string;
  value: string;
}

/** Plain text is the default; regex only when the `.*` chip is pressed. */
function makeMatcher(query: string, useRegex: boolean): { test: (text: string) => boolean; invalid: boolean } {
  if (!query) return { test: () => true, invalid: false };
  if (useRegex) {
    try {
      const re = new RegExp(query.slice(0, PATTERN_CAP), "i");
      return { test: (text: string) => re.test(text), invalid: false };
    } catch {
      return { test: () => false, invalid: true };
    }
  }
  const q = query.toLowerCase();
  return { test: (text: string) => text.toLowerCase().includes(q), invalid: false };
}

/** Label and hint above the control, the reading order the prototype uses. */
function Section({ label, hint, hintBelow, children }: {
  label?: string;
  hint?: string;
  /** Sliders carry their own label row, so their hint reads better underneath. */
  hintBelow?: boolean;
  children: ReactNode;
}) {
  const hintEl = hint
    ? <p className="m3-field-hint" style={hintBelow ? undefined : { margin: "0 0 var(--sp-2)" }}>{hint}</p>
    : null;
  return (
    <div className="m3-field">
      {label && <span className="m3-field-label">{label}</span>}
      {!hintBelow && hintEl}
      {children}
      {hintBelow && hintEl}
    </div>
  );
}

export default function Appearance() {
  const t = useT();
  const { prefs, setPrefs, setElementStyle, resetElementStyle, resetAppearance } = usePrefs();
  const { notify } = useNotifications();
  const [seedText, setSeedText] = useState(prefs.seed);
  const [target, setTarget] = useState<string>(ELEMENT_TARGETS[0].id);
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);

  const commitSeed = (value: string) => {
    setSeedText(value);
    if (HEX.test(value)) setPrefs({ seed: value });
  };

  const el = prefs.elementStyles[target] ?? {};
  const targetLabel = t((ELEMENT_TARGETS.find(x => x.id === target) ?? ELEMENT_TARGETS[0]).tkey as TKey);
  const overrideCount = Object.keys(prefs.elementStyles).length;
  const fontLabel = (FONT_CHOICES.find(f => f.id === prefs.fontId) ?? FONT_CHOICES[0]).label;

  // The settings index for this surface, carrying each setting's live value so a
  // search answers "what is it set to" without scrolling to the control.
  const here: SettingRow[] = [
    {
      id: "theme",
      label: t("appearance.themeTitle"),
      desc: t("appearance.themeSub"),
      value: t(prefs.theme === "light" ? "theme.light" : prefs.theme === "dark" ? "theme.dark" : "theme.system"),
    },
    { id: "seed", label: t("appearance.seedTitle"), desc: t("appearance.seedSub"), value: prefs.seed },
    { id: "density", label: t("appearance.densityTitle"), desc: t("appearance.densitySub"), value: String(prefs.density) },
    { id: "font", label: t("appearance.font"), desc: t("appearance.typeSub"), value: fontLabel },
    {
      id: "fontScale",
      label: t("appearance.fontScale"),
      desc: t("appearance.typeTitle"),
      value: `${Math.round(prefs.fontScale * 100)}%`,
    },
    { id: "fontWeight", label: t("appearance.fontWeight"), desc: t("appearance.typeTitle"), value: String(prefs.fontWeight) },
  ];

  /** Settings that live on another surface, so a miss here can still point somewhere. */
  const elsewhere = [
    { id: "langMode", label: t("lang.mode"), tab: t("nav.language") },
    { id: "funnyEn", label: t("lang.funnyEn"), tab: t("nav.language") },
    { id: "funnyYue", label: t("lang.funnyYue"), tab: t("nav.language") },
  ];

  const matcher = makeMatcher(query, useRegex);
  const hits = here.filter(row => matcher.test(`${row.label} ${row.desc} ${row.value}`));
  // Only claimed once something was actually typed — an untouched field has not
  // matched anything, here or anywhere else.
  const otherHits = query ? elsewhere.filter(row => matcher.test(row.label)) : [];
  const otherTabs = [...new Set(otherHits.map(row => row.tab))].join(", ");

  const onResetElement = () => {
    resetElementStyle(target);
    notify({ tone: "success", title: t("appearance.elResetDone"), body: targetLabel });
  };

  const onResetAllElements = () => {
    for (const id of Object.keys(prefs.elementStyles)) resetElementStyle(id);
    notify({ tone: "info", title: t("appearance.resetAllDone") });
  };

  const onResetAll = () => {
    recordRevision({ scope: "settings", label: t("appearance.title"), summary: t("appearance.resetRecorded") });
    resetAppearance();
    notify({ tone: "info", title: t("appearance.resetDone") });
  };

  return (
    <>
      <p className="m3-page-lead">{t("appearance.subtitle")}</p>

      <div className="m3-row" role="search">
        <IconSearch width={20} height={20} aria-hidden="true" />
        <TextInput
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("settings.search")}
          aria-label={t("settings.search")}
          aria-invalid={matcher.invalid}
          style={{ flex: "1 1 240px", width: "auto", minWidth: 0, maxWidth: 460 }}
        />
        {/* Plain text stays the default; `.*` is an explicit opt-in on every search bar. */}
        <Chip selected={useRegex} onClick={() => setUseRegex(v => !v)} title={t("regex.regexMode")}>
          <code style={MONO}>.*</code>
        </Chip>
        <a className="m3-icon-btn" href="#regex" title={t("settings.openBuilder")} aria-label={t("settings.openBuilder")}>
          <IconRegex width={20} height={20} aria-hidden="true" />
        </a>
      </div>
      <p
        role="status"
        style={{ minHeight: 20, margin: "4px 0 var(--sp-2)", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}
      >
        {matcher.invalid
          ? t("regex.invalid")
          : otherHits.length
            ? t("settings.otherTab", { count: otherHits.length, tabs: otherTabs })
            : query && hits.length === 0
              ? t("settings.noMatch")
              : ""}
      </p>
      <div data-settings-hits="" style={{ display: "grid", gap: 6, marginBottom: "var(--sp-3)" }}>
        {hits.map(row => (
          <div key={row.id} style={HIT_ROW}>
            <span style={{ fontSize: "var(--t-body-m)", fontWeight: 500 }}>{row.label}</span>
            <span style={{ color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}>{row.desc}</span>
            <span style={{ ...MONO, marginLeft: "auto", fontSize: "var(--t-label-m)" }}>{row.value}</span>
          </div>
        ))}
      </div>

      <Card>
        <Section label={t("appearance.themeTitle")} hint={t("appearance.themeSub")}>
          <Segmented<ThemeMode>
            label={t("theme.label")}
            value={prefs.theme}
            onChange={theme => setPrefs({ theme })}
            options={[
              { value: "light", label: t("theme.light") },
              { value: "dark", label: t("theme.dark") },
              { value: "system", label: t("theme.system") },
            ]}
          />
        </Section>

        <Section label={t("appearance.seedTitle")} hint={t("appearance.seedSub")}>
          <div className="m3-row">
            <input
              type="color"
              value={HEX.test(seedText) ? seedText : prefs.seed}
              onChange={e => commitSeed(e.target.value)}
              aria-label={t("appearance.seedPicker")}
              style={{ ...COLOR_SWATCH, width: 64 }}
            />
            <TextInput
              value={seedText}
              onChange={e => commitSeed(e.target.value)}
              aria-label={t("appearance.seedHex")}
              aria-invalid={!HEX.test(seedText)}
              spellCheck={false}
              style={{ width: 160, fontFamily: "var(--mono)" }}
            />
            <div className="m3-row" style={{ gap: 8 }}>
              {SEED_SWATCHES.map(hex => (
                <button
                  key={hex}
                  type="button"
                  onClick={() => commitSeed(hex)}
                  aria-label={hex}
                  aria-pressed={prefs.seed.toLowerCase() === hex.toLowerCase()}
                  title={hex}
                  style={{
                    width: 44, height: 44, borderRadius: "var(--r-pill)", cursor: "pointer",
                    background: hex,
                    border: prefs.seed.toLowerCase() === hex.toLowerCase()
                      ? "3px solid var(--m3-on-surface)"
                      : "1px solid var(--m3-outline-variant)",
                  }}
                />
              ))}
            </div>
          </div>
          {!HEX.test(seedText) && (
            <p className="m3-field-hint" style={{ color: "var(--m3-error)" }}>{t("appearance.seedInvalid")}</p>
          )}
          {/* The palette the seed just derived, in the roles that carry it. */}
          <div data-role-swatches="" className="m3-row" style={{ gap: 8, marginTop: "var(--sp-2)" }}>
            {ROLE_SWATCHES.map(role => (
              <span key={role.tkey} style={{ ...ROLE_SWATCH_STYLE, background: role.bg, color: role.fg }}>
                {t(role.tkey)}
              </span>
            ))}
          </div>
        </Section>

        <Section hint={t("appearance.densitySub")} hintBelow>
          <Slider
            id="ocx-density"
            label={t("appearance.densityTitle")}
            min={1}
            max={5}
            value={prefs.density}
            valueLabel={String(prefs.density)}
            onChange={v => setPrefs({ density: v as DensityLevel })}
          />
        </Section>

        <Section label={t("appearance.font")} hint={t("appearance.typeSub")}>
          <div className="m3-row" style={{ gap: 8 }}>
            {FONT_CHOICES.map(font => (
              <Chip key={font.id} selected={prefs.fontId === font.id} onClick={() => setPrefs({ fontId: font.id })}>
                <span style={{ fontFamily: font.stack }}>{font.label}</span>
              </Chip>
            ))}
          </div>
        </Section>

        <div className="m3-grid">
          <Slider
            id="ocx-fontscale"
            label={t("appearance.fontScale")}
            min={0.85}
            max={1.4}
            step={0.05}
            value={prefs.fontScale}
            valueLabel={`${Math.round(prefs.fontScale * 100)}%`}
            onChange={fontScale => setPrefs({ fontScale })}
          />
          <Slider
            id="ocx-fontweight"
            label={t("appearance.fontWeight")}
            min={300}
            max={600}
            step={50}
            value={prefs.fontWeight}
            valueLabel={String(prefs.fontWeight)}
            onChange={fontWeight => setPrefs({ fontWeight })}
          />
        </div>
      </Card>

      <Card title={t("appearance.elementsTitle")} subtitle={t("appearance.elementsSub")}>
        <div className="m3-row" style={{ gap: 8, marginBottom: "var(--sp-3)" }}>
          {ELEMENT_TARGETS.map(item => (
            <Chip key={item.id} selected={target === item.id} onClick={() => setTarget(item.id)}>
              {t(item.tkey as TKey)}
            </Chip>
          ))}
        </div>

        <div className="m3-grid">
          <div>
            <span className="m3-field-label">{t("appearance.elFont", { target: targetLabel })}</span>
            <div className="m3-row" style={{ gap: 6 }}>
              {FONT_CHOICES.map(font => (
                <Chip
                  key={font.id}
                  selected={el.font === font.stack}
                  onClick={() => setElementStyle(target, { font: font.stack })}
                >
                  <span style={{ fontFamily: font.stack }}>{font.label}</span>
                </Chip>
              ))}
            </div>
          </div>

          {/* Text and background sit side by side under one group caption, as in
              the prototype; the tooltip carries whether the swatch is an
              override, and the group label gives the pair the same standing as
              the font, radius and padding controls beside it. */}
          <div>
            <span className="m3-field-label">{t("appearance.elColourGroup")}</span>
            <div className="m3-row" style={{ gap: 10 }}>
              <input
                type="color"
                value={el.color ?? COLOR_FALLBACK}
                onChange={e => setElementStyle(target, { color: e.target.value })}
                aria-label={t("appearance.elColor")}
                title={el.color ?? t("appearance.elInherit")}
                style={COLOR_SWATCH}
              />
              <input
                type="color"
                value={el.bg ?? BG_FALLBACK}
                onChange={e => setElementStyle(target, { bg: e.target.value })}
                aria-label={t("appearance.elBg")}
                title={el.bg ?? t("appearance.elInherit")}
                style={COLOR_SWATCH}
              />
              <span style={{ color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}>
                {t("appearance.elColorCaption")}
              </span>
            </div>
          </div>

          <Slider
            id={`el-${target}-radius`}
            label={t("appearance.elRadius")}
            min={0}
            max={28}
            step={2}
            value={el.radius ?? EL_RADIUS_DEFAULT}
            valueLabel={t("appearance.pxValue", { n: String(el.radius ?? EL_RADIUS_DEFAULT) })}
            onChange={radius => setElementStyle(target, { radius })}
          />
          <Slider
            id={`el-${target}-pad`}
            label={t("appearance.elPad")}
            min={4}
            max={32}
            step={2}
            value={el.pad ?? EL_PAD_DEFAULT}
            valueLabel={t("appearance.pxValue", { n: String(el.pad ?? EL_PAD_DEFAULT) })}
            onChange={pad => setElementStyle(target, { pad })}
          />
        </div>

        <div className="m3-row" style={{ marginTop: "var(--sp-3)" }}>
          {/* Named, as the prototype names it: the button says which target it
              clears, so it can never be read as "reset everything". */}
          <Button variant="outlined" onClick={onResetElement}>
            {t("appearance.elResetTarget", { target: targetLabel })}
          </Button>
          <Button
            variant="text"
            onClick={onResetAllElements}
            disabled={overrideCount === 0}
            style={{ color: "var(--m3-error)" }}
          >
            {t("appearance.elResetAll", { count: overrideCount })}
          </Button>
          {/* The global reset also returns theme, seed, density and type to defaults. */}
          <Button variant="text" onClick={onResetAll} style={{ color: "var(--m3-error)" }}>
            {t("appearance.reset")}
          </Button>
        </div>
      </Card>

      <Card title={t("appearance.previewHeadline")}>
        {/* Specimens, not controls: the prototype renders these as spans so the
            preview never adds three focusable buttons that do nothing. */}
        <div style={{ fontSize: "var(--t-headline-s)", fontWeight: 500, marginBottom: 4 }}>
          {t("appearance.previewHeadlineSample")}
        </div>
        <div style={{ fontSize: "var(--t-title-m)", fontWeight: 500, marginBottom: 4 }}>
          {t("appearance.previewTitleSample")}
        </div>
        <p style={{ margin: "0 0 var(--sp-3)", fontSize: "var(--t-body-m)", color: "var(--m3-on-surface-variant)" }}>
          {t("appearance.previewBodySample")}
        </p>
        <div className="m3-row" style={{ gap: 8 }}>
          <span className="m3-btn m3-btn--filled">{t("appearance.previewFilled")}</span>
          <span className="m3-btn m3-btn--tonal">{t("appearance.previewTonal")}</span>
          <span className="m3-btn m3-btn--outlined">{t("appearance.previewOutlined")}</span>
        </div>
      </Card>
    </>
  );
}
