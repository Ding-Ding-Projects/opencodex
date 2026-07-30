/**
 * Appearance — the prototype's three surfaces, in order: one settings card
 * (theme, seed, density, typography), the per-element editors, then the live
 * preview.
 *
 * Everything writes through `usePrefs()`, so the whole shell retints live;
 * nothing here needs a reload or a save button.
 */

import { useState, type CSSProperties, type ReactNode } from "react";
import { Button, Card, Chip, Segmented, Slider, TextInput } from "../shell/m3-ui";
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
 * to fall back to a concrete hex. The readout beside it says "inherits theme"
 * so the value is never mistaken for an applied override.
 */
const COLOR_FALLBACK = "#000000";
const BG_FALLBACK = "#ffffff";

const COLOR_SWATCH: CSSProperties = {
  width: 56,
  height: 48,
  padding: 2,
  border: "1px solid var(--m3-outline)",
  borderRadius: "var(--r-s)",
  background: "var(--m3-surface-container-lowest)",
  cursor: "pointer",
};

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

function ColorField({ label, value, fallback, inheritLabel, onChange }: {
  label: string;
  value?: string;
  fallback: string;
  inheritLabel: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <span className="m3-field-label">{label}</span>
      <div className="m3-row" style={{ gap: 8 }}>
        <input
          type="color"
          value={value ?? fallback}
          onChange={e => onChange(e.target.value)}
          aria-label={label}
          style={COLOR_SWATCH}
        />
        <span style={{ fontFamily: "var(--mono)", fontSize: "var(--t-body-s)" }}>{value ?? inheritLabel}</span>
      </div>
    </div>
  );
}

export default function Appearance() {
  const t = useT();
  const { prefs, setPrefs, setElementStyle, resetElementStyle, resetAppearance } = usePrefs();
  const { notify } = useNotifications();
  const [seedText, setSeedText] = useState(prefs.seed);
  const [target, setTarget] = useState<string>(ELEMENT_TARGETS[0].id);

  const commitSeed = (value: string) => {
    setSeedText(value);
    if (HEX.test(value)) setPrefs({ seed: value });
  };

  const el = prefs.elementStyles[target] ?? {};
  const targetLabel = t((ELEMENT_TARGETS.find(x => x.id === target) ?? ELEMENT_TARGETS[0]).tkey as TKey);

  const onResetElement = () => {
    resetElementStyle(target);
    notify({ tone: "success", title: t("appearance.elReset"), body: targetLabel });
  };

  const onResetAll = () => {
    recordRevision({ scope: "settings", label: t("appearance.title"), summary: t("appearance.resetRecorded") });
    resetAppearance();
    notify({ tone: "info", title: t("appearance.resetDone") });
  };

  return (
    <>
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

        <Section label={t("appearance.fontFamily")} hint={t("appearance.typeSub")}>
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
            <span className="m3-field-label">{t("appearance.fontFamily")}</span>
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

          <div className="m3-row" style={{ alignItems: "flex-start", gap: "var(--sp-3)" }}>
            <ColorField
              label={t("appearance.elColor")}
              value={el.color}
              fallback={COLOR_FALLBACK}
              inheritLabel={t("appearance.elInherit")}
              onChange={color => setElementStyle(target, { color })}
            />
            <ColorField
              label={t("appearance.elBg")}
              value={el.bg}
              fallback={BG_FALLBACK}
              inheritLabel={t("appearance.elInherit")}
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

        <div className="m3-row" style={{ marginTop: "var(--sp-3)" }}>
          <Button variant="outlined" onClick={onResetElement}>{t("appearance.elReset")}</Button>
          <Button variant="text" onClick={onResetAll} style={{ color: "var(--m3-error)" }}>
            {t("appearance.reset")}
          </Button>
        </div>
      </Card>

      <Card title={t("appearance.previewHeadline")}>
        <p style={{ margin: "0 0 var(--sp-3)", fontSize: "var(--t-body-m)", color: "var(--m3-on-surface-variant)" }}>
          {t("appearance.previewBody")}
        </p>
        {/* Specimens, not controls: the prototype renders these as spans so the
            preview never adds three focusable buttons that do nothing. */}
        <div className="m3-row" style={{ gap: 8 }}>
          <span className="m3-btn m3-btn--filled">{t("appearance.previewPrimary")}</span>
          <span className="m3-btn m3-btn--tonal">{t("appearance.previewTonal")}</span>
          <span className="m3-btn m3-btn--outlined">{t("appearance.previewOutlined")}</span>
        </div>
      </Card>
    </>
  );
}
