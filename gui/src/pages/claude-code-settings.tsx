import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Trans } from "../i18n/provider";
import { useT } from "../i18n/shared";
import { joinBilingual } from "../i18n/resolve";
import { IconSearch } from "../icons";
import { Card, Chip, TextInput } from "../shell/m3-ui";
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import { onOutsidePress } from "../shell/outside-press";
import { useMenuFilter, focusMenuFilterField, reactNodeText } from "../shell/menu-filter";
import { MenuFilterField, MenuFilterStatus } from "../shell/MenuFilterField";
import { claudeSettingLabels } from "./claude-settings-search";
import type { ClaudeSettingsSearch } from "./claude-settings-search";

/**
 * The settings-search row the prototype puts at the top of the Claude Code tab, and
 * that every settings surface owes its user: plain-text search by default, an
 * explicit `.*` opt-in, and the full builder one click away — anchored to this field
 * rather than hidden behind a menu. The status line under it reports a cross-tab hit
 * by name, so a miss here can still say where the setting actually lives.
 */
export function ClaudeSettingsSearchRow({
  query,
  onQuery,
  regexOn,
  onRegex,
  search,
}: {
  query: string;
  onQuery: (next: string) => void;
  regexOn: boolean;
  onRegex: (next: boolean) => void;
  search: ClaudeSettingsSearch;
}) {
  const t = useT();
  const note = search.error
    ? `${t("regex.invalid")}: ${search.error}`
    : search.otherHits > 0
      // Tab names are `t()` results, so each is a bilingual pair; regrouped into
      // one pair rather than comma-joined, which would interleave the languages.
      ? t("settings.otherTab", { count: search.otherHits, tabs: joinBilingual(search.otherTabs, ", ") })
      : search.active && search.hits === 0
        ? t("settings.noMatch")
        : "";
  return (
    <>
      <div className="m3-row" role="search" style={{ gap: 8, marginBottom: 8 }}>
        <IconSearch width={20} height={20} aria-hidden="true" />
        <TextInput
          type="search"
          value={query}
          onChange={e => onQuery(e.target.value)}
          placeholder={t("settings.search")}
          aria-label={t("settings.search")}
          aria-invalid={search.error !== null}
          style={{ flex: "1 1 240px", width: "auto", minWidth: 0, maxWidth: 420 }}
        />
        {/* Plain text stays the default; `.*` is the explicit opt-in every search bar carries. */}
        <Chip selected={regexOn} onClick={() => onRegex(!regexOn)} title={t("regex.regexMode")} aria-label={t("regex.regexMode")}>
          <code style={{ fontFamily: "var(--mono)" }}>.*</code>
        </Chip>
        <RegexBuilderButton
          value={query}
          onApply={pattern => onQuery(pattern)}
          regex={regexOn}
          onRegexChange={onRegex}
          // The names of the settings this tab owns, so a pattern is tried against
          // the same words the row above filters on.
          sample={claudeSettingLabels(t).map(row => row.label).join("\n")}
          label={t("settings.openBuilder")}
        />
      </div>
      <p
        role={search.error ? "alert" : "status"}
        style={{
          minHeight: 20,
          margin: "0 0 16px",
          color: search.error ? "var(--m3-error)" : "var(--m3-on-surface-variant)",
          fontSize: "var(--t-label-m)",
        }}
      >
        {note}
      </p>
    </>
  );
}

/**
 * M3 settings row: label stack on the left, control on the right, hairline rule
 * between rows. `last` drops the rule so a card never ends on a dangling border.
 * Inline styles because the shared stylesheets are off-limits to a screen rewrite.
 */
export function SettingRow({
  title,
  desc,
  control,
  align = "center",
  last = false,
}: {
  title: ReactNode;
  desc?: ReactNode;
  control?: ReactNode;
  align?: "center" | "flex-start";
  last?: boolean;
}) {
  return (
    <div
      className="m3-row m3-row--split"
      style={{
        alignItems: align,
        padding: "12px 0",
        borderBottom: last ? "none" : "1px solid var(--m3-outline-variant)",
      }}
    >
      <div style={{ flex: "1 1 240px", minWidth: 0 }}>
        <div style={{ fontSize: "var(--t-body-m)", fontWeight: 500 }}>{title}</div>
        {desc && <div style={{ marginTop: "2px", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>{desc}</div>}
      </div>
      {control && <div className="m3-row" style={{ flex: "0 0 auto", gap: "8px" }}>{control}</div>}
    </div>
  );
}

/**
 * The connection/feature switch. `role="switch"` + `aria-checked` is the a11y
 * contract for M3 toggles; it replaces the legacy checkbox-in-a-label, but keeps
 * the same `aria-label` / `aria-describedby` wiring the callers rely on.
 */
export function SettingToggle({
  label,
  checked,
  onChange,
  disabled = false,
  describedBy,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      className={`m3-switch${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="m3-switch-thumb" aria-hidden="true" />
    </button>
  );
}

/**
 * A small M3 combobox that keeps ReactNode labels intact (native option text
 * would stringify model icons to the dreaded [object Object]).
 *
 * Carries the same filter field every dropdown in the app owes — the model
 * catalogue `SmallFastModelSetting` hands this can run long, and "it only has
 * four items" is not an exemption for the context-window picker either.
 * `reactNodeText` recovers a plain string to filter on from a label that may
 * be an icon-plus-text element rather than a string itself.
 */
export function RichSelect({
  value,
  options,
  onChange,
  label,
  describedBy,
  style,
}: {
  value: string;
  options: readonly { value: string; label: ReactNode }[];
  onChange: (value: string) => void;
  label: string;
  describedBy?: string;
  style?: CSSProperties;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value) ?? options[0];
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const filterId = useId();
  const labelOfOption = useCallback((option: { value: string; label: ReactNode }) => reactNodeText(option.label), []);
  const filter = useMenuFilter(options, labelOfOption);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The anchored regex builder is a nested dialog with its own Escape; the
      // filter field's own first-stage clear is handled inside
      // `MenuFilterField`. Only an Escape from neither reaches here.
      if ((event.target as Element | null)?.closest?.('[role="dialog"]')) return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const stopOutsidePress = onOutsidePress(onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      stopOutsidePress();
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Opens focused on the filter field, matching every other converted
  // dropdown — typing is the point, and ArrowDown reaches the options below.
  useEffect(() => {
    if (!open) return;
    focusMenuFilterField(filterId);
  }, [open, filterId]);

  const onItemKeyDown = (event: React.KeyboardEvent, index: number) => {
    const count = filter.visible.length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      itemRefs.current[(index + 1) % count]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index === 0) focusMenuFilterField(filterId);
      else itemRefs.current[index - 1]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      itemRefs.current[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      itemRefs.current[count - 1]?.focus();
    }
  };

  const choose = (optionValue: string) => {
    onChange(optionValue);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", minWidth: 190, ...style }}>
      <button
        ref={triggerRef}
        type="button"
        className="m3-select"
        role="combobox"
        aria-label={label}
        aria-describedby={describedBy}
        aria-expanded={open}
        onClick={() => {
          // A fresh filter every time the dropdown opens; a query left over
          // from the last visit would silently hide options the next one.
          filter.setQuery("");
          filter.setRegex(false);
          setOpen(current => !current);
        }}
        style={{ width: "100%", justifyContent: "space-between" }}
      >
        <span>{selected?.label}</span><span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div role="listbox" className="m3-menu" style={{ position: "absolute", zIndex: 10, insetInline: 0, top: "calc(100% + 4px)", maxHeight: 280, overflowY: "auto" }}>
          <MenuFilterField
            id={filterId}
            query={filter.query}
            onQuery={filter.setQuery}
            regex={filter.regex}
            onRegexChange={filter.setRegex}
            flags={filter.flags}
            onFlags={filter.setFlags}
            sample={filter.sample}
            searchLabel={t("richSelect.filterLabel")}
            builderLabel={t("richSelect.filterBuilder")}
            onArrowDown={() => itemRefs.current[0]?.focus()}
            onEnterSingle={() => choose(filter.visible[0].value)}
            resultCount={filter.visible.length}
          />
          <MenuFilterStatus matcher={filter.matcher} query={filter.query} resultCount={filter.visible.length} />
          {filter.visible.map((option, index) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              key={option.value}
              className="m3-menu-item"
              ref={element => { itemRefs.current[index] = element; }}
              onKeyDown={event => onItemKeyDown(event, index)}
              onClick={() => choose(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function AutoConnectSetting({
  supported,
  checked,
  onChange,
  last = false,
}: {
  supported: boolean;
  checked: boolean;
  onChange: (value: boolean) => void;
  last?: boolean;
}) {
  const t = useT();
  const unsupportedDescriptionId = supported ? undefined : "claude-system-env-unsupported";

  return (
    <SettingRow
      title={t("claude.systemEnv")}
      last={last}
      desc={
        <>
          {supported ? (
            <span>{t("claude.systemEnvDesc")}</span>
          ) : (
            <span id={unsupportedDescriptionId}>
              <Trans k="claude.systemEnvUnsupported" cmd="ocx claude" />
            </span>
          )}
          {supported && checked && (
            <span style={{ display: "block", marginTop: "4px", color: "var(--m3-error)" }}>
              {t("claude.systemEnvWarn")}
            </span>
          )}
        </>
      }
      control={
        <SettingToggle
          label={t("claude.systemEnv")}
          checked={supported && checked}
          disabled={!supported}
          describedBy={unsupportedDescriptionId}
          onChange={onChange}
        />
      }
    />
  );
}

export function SmallFastModelSetting({
  value,
  tierHaikuModel,
  options,
  onChange,
}: {
  value: string;
  tierHaikuModel?: string;
  options: readonly { value: string; label: ReactNode }[];
  onChange: (value: string) => void;
}) {
  const t = useT();
  const effectiveHelperModel = tierHaikuModel ?? value;
  return (
    <Card title={t("claude.smallFastModel")} subtitle={t("claude.smallFastModelAccurateHint")}>
      <RichSelect
        value={value}
        options={options}
        onChange={onChange}
        label={t("claude.smallFastModel")}
        style={{ maxWidth: 420 }}
      />
      <select
        aria-label={t("claude.smallFastModel")}
        value={value}
        onChange={event => onChange(event.target.value)}
        style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
        tabIndex={-1}
      >
        {options.map(option => <option key={option.value} value={option.value}>{option.value || String(option.label)}</option>)}
      </select>
      {effectiveHelperModel === "" && (
        <p
          className="notice-warn"
          role="status"
          style={{
            margin: "12px 0 0",
            padding: "10px 14px",
            borderRadius: "var(--r-s)",
            background: "var(--m3-warn-container)",
            color: "var(--m3-on-warn-container)",
            fontSize: "var(--t-body-s)",
          }}
        >
          {t("claude.smallFastModelNativeWarning")}
        </p>
      )}
    </Card>
  );
}
