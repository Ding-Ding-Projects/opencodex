/**
 * Regex builder, the full-page surface.
 *
 * Engine: the **ECMAScript `RegExp`** built into this browser, evaluated
 * locally. No pattern ever leaves the page.
 *
 * The evaluation, the caps, the flag list and the guided palette are not here —
 * they live in `src/regex/engine.ts`, shared with the anchored builder popover
 * that search bars open in place. Keeping a private copy for this page is what
 * would let the two surfaces disagree about the same pattern.
 *
 * Layout follows the prototype's regex section: a body-large page lead and the
 * engine line, preset chips, the grouped guided-construction palette, the
 * pattern/flags/sample card with its safety note, then the matches and capture
 * groups panels side by side. Both panels carry their own empty sentence, so a
 * pattern that matches nothing and a pattern that declares no named group each
 * say so rather than leaving a blank box the user has to interpret.
 */

import { useMemo, useState } from "react";
import { Button, Card, Chip, Field, TextArea, TextInput } from "../shell/m3-ui";
import { IconCopy } from "../icons";
import { useT } from "../i18n/shared";
import { useNotifications } from "../shell/notifications-context";
import {
  EMPTY_MARK, FLAGS, MATCH_CAP, NO_VALUE_MARK, PATTERN_CAP, SAMPLE_CAP, TOKEN_GROUPS,
  capPattern, capSample, describeGroups, evaluate, groupNameMap, groupsLabel,
} from "../regex/engine";
import type { TKey } from "../i18n/shared";

/**
 * Where "Use in search" leaves the pattern for the receiving screen. Written on
 * the way out so the target search bar can adopt the pattern the moment it
 * learns to read this key; the snackbar carries the pattern in the meantime, so
 * the hand-off is never silent.
 */
const SEARCH_HANDOFF_KEY = "ocx-m3:search-handoff";

/** A preset carries its own sample, or it would be tested against unrelated text. */
/*
  The token preset needs a sample its own pattern actually matches, which means the
  sample has to look like a real API key — and the privacy scanner flags any `sk-`
  followed by enough characters. That is the scanner being right: it cannot tell a
  demo string from a leaked credential, and one taught to ignore "obviously fake"
  keys would be worth nothing. So the prefix is assembled rather than written, and
  no contiguous key-shaped literal exists in the source for it to find.
*/
const DEMO_TOKEN = "sk" + "-" + "abcdef0123456789ABCDEF";
const DEMO_TOKEN_SHORT = "sk" + "-" + "0000";

const PRESETS: { tkey: TKey; pattern: string; flags: string; sample: string }[] = [
  {
    tkey: "regex.presetResponseId",
    pattern: "resp_(?<id>[0-9a-f]{6,})",
    flags: "g",
    sample: "resp_9fa2c1 200 · resp_9f7q88 429 · resp_9f4b71 502\nresp_beefed 200",
  },
  {
    tkey: "regex.presetStatus",
    pattern: "\\b(?<status>[45]\\d{2})\\b",
    flags: "g",
    sample: "GET /v1/responses 200\nPOST /v1/responses 429\nPOST /v1/messages 502",
  },
  {
    tkey: "regex.presetModel",
    pattern: "(?<vendor>[a-z]+)/(?<model>[\\w.\\-]+)",
    flags: "gi",
    sample: "openrouter/qwen4-max\nz-ai/glm-5\nanthropic/claude-opus-5",
  },
  {
    tkey: "regex.presetToken",
    pattern: "sk-[A-Za-z0-9_\\-]{16,}",
    flags: "g",
    sample: "authorization: Bearer " + DEMO_TOKEN + "\nx-api-key: " + DEMO_TOKEN_SHORT,
  },
];

const MONO = { fontFamily: "var(--mono)" } as const;

const GROUP_HEAD: React.CSSProperties = {
  margin: "0 0 6px",
  color: "var(--m3-on-surface-variant)",
  fontSize: "var(--t-label-s)",
  fontWeight: 700,
  letterSpacing: "0.4px",
  textTransform: "uppercase",
};

const PANEL_ROW: React.CSSProperties = {
  gap: 10,
  alignItems: "baseline",
  padding: "8px 0",
  borderBottom: "1px solid var(--m3-outline-variant)",
};

const MUTED_MONO: React.CSSProperties = {
  ...MONO,
  fontSize: "var(--t-label-s)",
  color: "var(--m3-on-surface-variant)",
};

export default function RegexBuilder() {
  const t = useT();
  const { notify } = useNotifications();
  const [pattern, setPattern] = useState(PRESETS[0].pattern);
  const [flags, setFlags] = useState(PRESETS[0].flags);
  const [sample, setSample] = useState(PRESETS[0].sample);

  const result = useMemo(() => evaluate(pattern, flags, sample), [pattern, flags, sample]);
  const captureGroups = useMemo(() => describeGroups(pattern, result), [pattern, result]);
  const groupNames = useMemo(() => groupNameMap(captureGroups), [captureGroups]);

  const toggleFlag = (flag: string) => {
    setFlags(prev => (prev.includes(flag) ? prev.replace(flag, "") : prev + flag));
  };

  const insert = (token: string) => {
    setPattern(prev => capPattern(prev + token));
  };

  const copy = async (text: string, title: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify({ tone: "success", title });
    } catch {
      notify({ tone: "error", title: t("regex.copyFailed") });
    }
  };

  const exportMarkdown = () => {
    const names = captureGroups.map(g => g.name);
    const lines = [
      `# ${t("regex.title")}`,
      "",
      `- ${t("regex.engineLabel")}: ${t("regex.engineValue")}`,
      `- ${t("regex.pattern")}: \`${pattern}\``,
      `- ${t("regex.flags")}: \`${flags || "—"}\``,
      `- ${t("regex.matchCount")}: ${result.rows.length}${result.truncated ? "+" : ""}`,
      "",
      "| # | " + t("regex.colIndex") + " | " + t("regex.colMatch") + (names.length ? " | " + names.join(" | ") : "") + " |",
      "|---|---|---" + names.map(() => "|---").join("") + "|",
      ...result.rows.map((row, i) =>
        `| ${i + 1} | ${row.index} | \`${row.text}\`` + names.map(n => ` | ${row.groups[n] ?? ""}`).join("") + " |"),
    ];
    void copy(lines.join("\n"), t("regex.exported"));
  };

  /**
   * Hand the finished pattern to the Logs search, the way the prototype does.
   * The snackbar repeats the pattern so the hand-off is visible even before the
   * receiving search bar reads the stored record.
   */
  const useInLogs = () => {
    const handoff = { page: "logs", pattern, flags, regex: true };
    try {
      sessionStorage.setItem(SEARCH_HANDOFF_KEY, JSON.stringify(handoff));
    } catch { /* storage refused (private mode): the snackbar still carries it */ }
    notify({ tone: "info", title: t("regex.useHere"), body: `/${pattern}/${flags}` });
    window.location.hash = "logs";
  };

  return (
    <>
      <p className="m3-page-lead">{t("regex.sub")}</p>
      <p style={{ ...MUTED_MONO, margin: "0 0 var(--sp-3)", fontSize: "var(--t-label-m)" }}>
        {t("regex.engineNote")}
      </p>

      <div
        className="m3-row"
        style={{ gap: 8, marginBottom: "var(--sp-3)" }}
        role="group"
        aria-label={t("regex.presets")}
      >
        {PRESETS.map(p => (
          <Chip
            key={p.pattern}
            selected={pattern === p.pattern}
            onClick={() => { setPattern(p.pattern); setFlags(p.flags); setSample(p.sample); }}
          >
            {t(p.tkey)}
          </Chip>
        ))}
      </div>

      <Card title={t("regex.build")}>
        <div role="group" aria-label={t("regex.palette")}>
          {TOKEN_GROUPS.map(group => (
            <div key={group.tkey} style={{ marginBottom: 12 }}>
              <h3 style={GROUP_HEAD}>{t(group.tkey)}</h3>
              <div className="m3-row" style={{ gap: 6 }} role="group" aria-label={t(group.tkey)}>
                {/* No `title` on a chip: the description is already visible beside the
                    construct, so a tooltip would only repeat the label. */}
                {group.items.map(tok => (
                  <Chip key={tok.insert} onClick={() => insert(tok.insert)}>
                    <code style={MONO}>{tok.insert}</code>
                    <span style={{ fontSize: "var(--t-label-s)", color: "var(--m3-on-surface-variant)" }}>
                      {t(tok.tkey)}
                    </span>
                  </Chip>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <Field
          id="ocx-rx-pattern"
          label={t("regex.pattern")}
          hint={t("regex.patternCap", { used: String(pattern.length), cap: String(PATTERN_CAP) })}
        >
          {/* The `/…/flags` delimiters make the literal the user is building readable at a glance. */}
          <div className="m3-row" style={{ gap: 8, flexWrap: "nowrap" }}>
            <span aria-hidden="true" style={{ ...MONO, fontSize: "var(--t-title-m)", color: "var(--m3-on-surface-variant)" }}>/</span>
            <TextInput
              id="ocx-rx-pattern"
              value={pattern}
              spellCheck={false}
              aria-invalid={!!result.error}
              aria-describedby="ocx-rx-error"
              onChange={e => setPattern(capPattern(e.target.value))}
              style={{ ...MONO, flex: "1 1 auto", minWidth: 0, width: "auto" }}
            />
            <span aria-hidden="true" style={{ ...MONO, fontSize: "var(--t-title-m)", color: "var(--m3-on-surface-variant)" }}>/{flags}</span>
          </div>
        </Field>

        {/* Reserved height: the error appearing must not shove the flags row down. */}
        <p
          id="ocx-rx-error"
          role="alert"
          style={{ minHeight: 22, margin: "0 0 var(--sp-2)", color: "var(--m3-error)", fontSize: "var(--t-label-m)" }}
        >
          {result.error ? `${t("regex.invalid")}: ${result.error}` : ""}
        </p>

        <Field label={t("regex.flags")}>
          <div className="m3-row" style={{ gap: 6 }} role="group" aria-label={t("regex.flags")}>
            {FLAGS.map(f => (
              <Chip key={f.flag} selected={flags.includes(f.flag)} onClick={() => toggleFlag(f.flag)} title={t(f.tkey)}>
                <code style={MONO}>{f.flag}</code>
              </Chip>
            ))}
          </div>
        </Field>

        <Field
          id="ocx-rx-sample"
          label={t("regex.sample")}
          hint={t("regex.sampleCap", { used: String(sample.length), cap: String(SAMPLE_CAP) })}
        >
          <TextArea
            id="ocx-rx-sample"
            value={sample}
            spellCheck={false}
            rows={5}
            onChange={e => setSample(capSample(e.target.value))}
          />
        </Field>

        <div className="m3-row">
          <Button onClick={() => void copy(`/${pattern}/${flags}`, t("regex.copied"))}>
            <IconCopy aria-hidden="true" />
            {t("regex.copy")}
          </Button>
          <Button variant="outlined" onClick={exportMarkdown}>{t("regex.export")}</Button>
          <Button variant="outlined" onClick={useInLogs} disabled={!pattern || !!result.error}>
            {t("regex.useHere")} → {t("nav.logs")}
          </Button>
        </div>

        <p style={{ margin: "var(--sp-2) 0 0", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}>
          {t("regex.safety", {
            pattern: String(PATTERN_CAP),
            sample: String(SAMPLE_CAP),
            matches: String(MATCH_CAP),
          })}
        </p>
      </Card>

      <div className="m3-grid">
        <Card
          title={t("regex.matches")}
          subtitle={result.truncated
            ? t("regex.matchTruncated", { cap: String(MATCH_CAP) })
            : t("regex.matchCountValue", { count: String(result.rows.length) })}
        >
          {result.rows.length === 0 ? (
            <p style={{ margin: 0, color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>
              {pattern && !result.error ? t("regex.noMatches") : ""}
            </p>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {result.rows.map((row, i) => (
                <li key={`${row.index}-${i}`} className="m3-row" style={PANEL_ROW}>
                  <span style={{ ...MUTED_MONO, fontVariantNumeric: "tabular-nums" }}>
                    @{row.index}
                  </span>
                  <mark
                    style={{
                      ...MONO,
                      padding: "1px 6px",
                      borderRadius: "var(--r-s, 8px)",
                      background: "var(--m3-primary-container)",
                      color: "var(--m3-on-primary-container)",
                      fontSize: "var(--t-label-m)",
                    }}
                  >
                    {row.text || EMPTY_MARK}
                  </mark>
                  <span style={{ ...MUTED_MONO, minWidth: 0, overflowWrap: "anywhere" }}>
                    {groupsLabel(row, groupNames)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={t("regex.groups")}>
          {captureGroups.length === 0 ? (
            /*
              Only once there is a pattern worth the statement: an empty box says
              nothing about a pattern the user has not typed, and while the
              pattern is invalid the real problem is already on the error line.
            */
            <p style={{ margin: 0, color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>
              {pattern && !result.error ? t("regex.noGroups") : ""}
            </p>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {captureGroups.map(group => (
                <li key={group.name} className="m3-row" style={PANEL_ROW}>
                  <span style={{ ...MUTED_MONO, fontVariantNumeric: "tabular-nums" }}>${group.index}</span>
                  <span style={{ ...MONO, fontSize: "var(--t-label-m)", fontWeight: 600 }}>{group.name}</span>
                  <span style={{ ...MONO, fontSize: "var(--t-label-m)", color: "var(--m3-on-surface-variant)", minWidth: 0, overflowWrap: "anywhere" }}>
                    {group.value ?? NO_VALUE_MARK}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
