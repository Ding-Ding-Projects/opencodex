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
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import { ColorField } from "../components/appearance/ColorPicker";
import { FontPicker } from "../components/appearance/FontPicker";
import { TypographyEditor } from "../components/appearance/TypographyEditor";
import { TYPOGRAPHY_LABEL_KEYS } from "../components/appearance/typography-labels";
import { IconSearch } from "../icons";
import { useT } from "../i18n/shared";
import { ELEMENT_TARGETS, usePrefs } from "../theme/prefs-context";
import { DEFAULT_SEED, SEED_SWATCHES, fontStackFor, type DensityLevel, type ThemeMode } from "../theme/m3";
import { familyOf } from "../theme/fonts";
import { formatHex, parseColor } from "../../../shared/m3/color";
import { elsewhereFor } from "./settings-elsewhere";
import { recordRevision } from "../shell/revisions";
import { useNotifications } from "../shell/notifications-context";
import type { TKey } from "../i18n/shared";

/** Shown when a target carries no override of its own; mirrors the prototype. */
const EL_RADIUS_DEFAULT = 16;
const EL_PAD_DEFAULT = 16;

/** The regex builder's own cap, applied here too so one search cannot outgrow it. */
const PATTERN_CAP = 400;

const MONO: CSSProperties = { fontFamily: "var(--mono)" };

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
  const { prefs, setPrefs, setElementStyle, setElementTypography, resetElementStyle, resetAppearance } = usePrefs();
  const { notify } = useNotifications();
  const [target, setTarget] = useState<string>(ELEMENT_TARGETS[0].id);
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  // The typography panel's own search, kept separate from the page search
  // above: they filter different things, and one shared string would make
  // typing in either quietly reach into the other.
  const [typeQuery, setTypeQuery] = useState("");
  const [typeRegex, setTypeRegex] = useState(false);

  /**
   * The seed is stored as a hex, and the picker is not restricted to one.
   *
   * `buildScheme` derives the whole palette through `srgbToOklch`, which reads
   * hex digits and nothing else — hand it an `oklch()` string and it parses
   * garbage and returns a palette nobody chose. So a colour picked outside sRGB
   * is clipped to its nearest hex on the way in. That is a real loss, and it is
   * the picker's own clipping warning that tells the user it is about to happen.
   */
  const commitSeed = (value: string | undefined) => {
    const parsed = value ? parseColor(value) : null;
    setPrefs({ seed: parsed ? formatHex(parsed) : DEFAULT_SEED });
  };

  const el = prefs.elementStyles[target] ?? {};
  const elType = el.typography ?? {};
  const targetLabel = t((ELEMENT_TARGETS.find(x => x.id === target) ?? ELEMENT_TARGETS[0]).tkey as TKey);
  const overrideCount = Object.keys(prefs.elementStyles).length;
  const activeStack = prefs.fontStack || fontStackFor(prefs.fontId);
  const fontLabel = familyOf(activeStack) ?? activeStack;

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

  /**
   * Settings that live on another surface, so a miss here can still point
   * somewhere. Taken from the shared registry rather than listed here: this
   * screen knew about three entries on one tab while `Settings` knew about five
   * on four others, so the same query answered differently depending on which
   * search bar it was typed into.
   */
  const elsewhere = elsewhereFor("nav.appearance").map(entry => ({
    id: entry.tkey,
    label: t(entry.tkey),
    desc: entry.descKey ? t(entry.descKey) : "",
    tab: t(entry.tabKey),
  }));

  const matcher = makeMatcher(query, useRegex);
  const hits = here.filter(row => matcher.test(`${row.label} ${row.desc} ${row.value}`));

  const typeMatcher = makeMatcher(typeQuery, typeRegex);
  const typeLabels = TYPOGRAPHY_LABEL_KEYS.map(key => t(key));
  // Only asked once something was typed: an untouched field has not failed to
  // match anything, so claiming "no match" there would be a lie about a search
  // nobody ran.
  const typeHasHits = !typeQuery || typeLabels.some(label => typeMatcher.test(label));
  // Only claimed once something was actually typed — an untouched field has not
  // matched anything, here or anywhere else.
  // Descriptions are matched too, so a search for what a setting *does* finds it
  // as readily as a search for what it is called.
  const otherHits = query ? elsewhere.filter(row => matcher.test(`${row.label} ${row.desc}`)) : [];
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
        <RegexBuilderButton
          value={query}
          onApply={pattern => setQuery(pattern)}
          regex={useRegex}
          onRegexChange={setUseRegex}
          // This screen's own settings rows, values included, so a pattern can be
          // tried against the text the search actually runs over.
          sample={here.map(row => `${row.label} ${row.desc} ${row.value}`).join("\n")}
          label={t("settings.openBuilder")}
        />
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
          <div className="m3-row" style={{ alignItems: "flex-start" }}>
            {/* The infinite picker, not a swatch grid: a continuous field plus
                numeric entry in every colour space, with the gamut and contrast
                readouts a seed decision actually needs. */}
            <div style={{ flex: "1 1 260px", minWidth: 0, maxWidth: 360 }}>
              <ColorField label={t("appearance.seedPicker")} value={prefs.seed} onChange={commitSeed} />
            </div>
            {/* The eight curated seeds stay as one-tap shortcuts. The picker
                offers them too, but reaching them here costs no popover. */}
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
                    // 48, not 44: Material's minimum, and these are the one
                    // control here whose size is set inline where no stylesheet
                    // floor can reach it.
                    width: 48, height: 48, borderRadius: "var(--r-pill)", cursor: "pointer",
                    background: hex,
                    border: prefs.seed.toLowerCase() === hex.toLowerCase()
                      ? "3px solid var(--m3-on-surface)"
                      : "1px solid var(--m3-outline-variant)",
                  }}
                />
              ))}
            </div>
          </div>
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

        {/* Every family this machine has, each drawn in itself — not the five
            bundled chips this replaces, which could not name a face the user had
            installed and could not show what any of them looked like. */}
        <Section label={t("appearance.fontPickerTitle")} hint={t("appearance.fontPickerSub")}>
          <FontPicker
            value={activeStack}
            onChange={stack => setPrefs({ fontStack: stack })}
            // The interface font is applied through `--m3-font`, a single stack
            // with nowhere to carry axis values, so no axis sliders are offered
            // here. The per-element editor below has them.
          />
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
          {/* The element's own surface colours, distinct from the typography
              below: these are the box — its text colour and its background —
              and they feed the `--el-<id>-*` variables that some forty rules
              across three stylesheets already read. `type.highlight` in the
              editor underneath is the run behind the glyphs, which is a
              different thing that CSS paints differently. */}
          <div>
            <span className="m3-field-label">{t("appearance.elColourGroup")}</span>
            <ColorField
              label={t("appearance.elColor")}
              value={el.color}
              onChange={color => setElementStyle(target, { color })}
            />
            <ColorField
              label={t("appearance.elBg")}
              value={el.bg}
              onChange={bg => setElementStyle(target, { bg })}
            />
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

        {/* Word-processor depth, for this one target. Its own search, because
            thirty controls is more than anyone scrolls: the rule that every
            settings surface carries a search bar applies inside a panel as much
            as it does to a page. */}
        <div className="m3-field" style={{ marginTop: "var(--sp-4)" }}>
          <span className="m3-field-label">{t("appearance.elTypeTitle", { target: targetLabel })}</span>
          <p className="m3-field-hint" style={{ margin: "0 0 var(--sp-2)" }}>{t("appearance.elTypeSub")}</p>

          <div className="m3-row" role="search">
            <IconSearch width={20} height={20} aria-hidden="true" />
            <TextInput
              value={typeQuery}
              onChange={e => setTypeQuery(e.target.value)}
              placeholder={t("appearance.elTypeSearch")}
              aria-label={t("appearance.elTypeSearch")}
              aria-invalid={typeMatcher.invalid}
              style={{ flex: "1 1 200px", width: "auto", minWidth: 0, maxWidth: 380 }}
            />
            <Chip selected={typeRegex} onClick={() => setTypeRegex(v => !v)} title={t("regex.regexMode")}>
              <code style={MONO}>.*</code>
            </Chip>
            <RegexBuilderButton
              value={typeQuery}
              onApply={pattern => setTypeQuery(pattern)}
              regex={typeRegex}
              onRegexChange={setTypeRegex}
              sample={typeLabels.join("\n")}
              label={t("settings.openBuilder")}
            />
          </div>
          <p role="status" style={{ minHeight: 20, margin: "4px 0", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}>
            {typeMatcher.invalid ? t("regex.invalid") : typeHasHits ? "" : t("appearance.elTypeNoMatch")}
          </p>

          <TypographyEditor
            style={elType}
            onChange={patch => setElementTypography(target, patch)}
            match={typeQuery ? typeMatcher.test : undefined}
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
