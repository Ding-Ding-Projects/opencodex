/**
 * Regex builder.
 *
 * Engine: the **ECMAScript `RegExp`** built into this browser, evaluated
 * locally. No pattern ever leaves the page.
 *
 * Safety caps, all enforced below: 400-character pattern, 20 000-character
 * sample, 200 matches, and a forced index advance on a zero-width match so a
 * pattern like `(?:)` cannot spin forever.
 *
 * Layout follows the prototype's regex section: a body-large page lead and the
 * engine line, preset chips, the grouped guided-construction palette, the
 * pattern/flags/sample card with its safety note, then the matches and capture
 * groups panels side by side.
 */

import { useMemo, useState } from "react";
import { Button, Card, Chip, Field, TextArea, TextInput } from "../shell/m3-ui";
import { IconCopy } from "../icons";
import { useT } from "../i18n/shared";
import { useNotifications } from "../shell/notifications-context";
import type { TKey } from "../i18n/shared";

const PATTERN_CAP = 400;
const SAMPLE_CAP = 20_000;
const MATCH_CAP = 200;

/** Shown when a group participated in no capture, and for a zero-width match. */
const EMPTY_MARK = "∅";

/**
 * Where "Use in search" leaves the pattern for the receiving screen. Written on
 * the way out so the target search bar can adopt the pattern the moment it
 * learns to read this key; the snackbar carries the pattern in the meantime, so
 * the hand-off is never silent.
 */
const SEARCH_HANDOFF_KEY = "ocx-m3:search-handoff";

const FLAGS: { flag: string; tkey: TKey }[] = [
  { flag: "g", tkey: "regex.flagG" },
  { flag: "i", tkey: "regex.flagI" },
  { flag: "m", tkey: "regex.flagM" },
  { flag: "s", tkey: "regex.flagS" },
  { flag: "u", tkey: "regex.flagU" },
  { flag: "y", tkey: "regex.flagY" },
];

/**
 * Guided palette: insert a construct rather than remembering its syntax.
 *
 * Grouped exactly the way the prototype groups them — literals → character
 * classes → anchors → groups → alternation → quantifiers — so each section
 * carries its own heading and its own `role="group"` label.
 *
 * Every insert is a *complete* construct: `(?<name>)` and not `(?<name>…)`,
 * because the ellipsis is a literal character and silently broke the pattern
 * the moment it was inserted.
 */
const TOKEN_GROUPS: { tkey: TKey; items: { insert: string; tkey: TKey }[] }[] = [
  {
    tkey: "regex.groupLiterals",
    items: [
      { insert: "abc", tkey: "regex.tokLiteral" },
      { insert: "\\.", tkey: "regex.tokEscapedDot" },
      { insert: "\\\\", tkey: "regex.tokBackslash" },
    ],
  },
  {
    tkey: "regex.groupClasses",
    items: [
      { insert: "\\d", tkey: "regex.tokDigit" },
      { insert: "\\w", tkey: "regex.tokWord" },
      { insert: "\\s", tkey: "regex.tokSpace" },
      // `.` is not in the prototype's class list, but it is the construct users
      // reach for beside `\d`/`\w`, and it already has its own description key.
      { insert: ".", tkey: "regex.tokAny" },
      { insert: "[a-z]", tkey: "regex.tokClass" },
      { insert: "[^/]", tkey: "regex.tokNegated" },
      { insert: "\\p{Script=Han}", tkey: "regex.tokUnicodeScript" },
    ],
  },
  {
    tkey: "regex.groupAnchors",
    items: [
      { insert: "^", tkey: "regex.tokStart" },
      { insert: "$", tkey: "regex.tokEnd" },
      { insert: "\\b", tkey: "regex.tokBoundary" },
    ],
  },
  {
    tkey: "regex.groupGroups",
    items: [
      { insert: "()", tkey: "regex.tokCapture" },
      { insert: "(?<name>)", tkey: "regex.tokNamed" },
      { insert: "(?:)", tkey: "regex.tokGroup" },
      { insert: "(?=)", tkey: "regex.tokLookahead" },
    ],
  },
  {
    tkey: "regex.groupAlternation",
    items: [{ insert: "|", tkey: "regex.tokAlt" }],
  },
  {
    tkey: "regex.groupQuantifiers",
    items: [
      { insert: "*", tkey: "regex.tokStar" },
      { insert: "+", tkey: "regex.tokPlus" },
      { insert: "?", tkey: "regex.tokOpt" },
      { insert: "{1,3}", tkey: "regex.tokRange" },
      { insert: "+?", tkey: "regex.tokLazy" },
    ],
  },
];

/** A preset carries its own sample, or it would be tested against unrelated text. */
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
    sample: "authorization: Bearer sk-abcdef0123456789ABCDEF\nx-api-key: sk-0000",
  },
];

interface MatchRow {
  index: number;
  text: string;
  /** Positional captures, `undefined` where the group did not participate. */
  positional: (string | undefined)[];
  groups: Record<string, string | undefined>;
}

interface Evaluation {
  rows: MatchRow[];
  error: string | null;
  truncated: boolean;
}

function evaluate(pattern: string, flags: string, sample: string): Evaluation {
  if (!pattern) return { rows: [], error: null, truncated: false };
  let re: RegExp;
  try {
    // `g` is forced so the scan below can walk every match; the user's own `g` is harmless.
    re = new RegExp(pattern, flags.includes("g") ? flags : flags + "g");
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : String(e), truncated: false };
  }

  const rows: MatchRow[] = [];
  let truncated = false;
  let guard = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sample)) !== null) {
    rows.push({
      index: match.index,
      text: match[0],
      positional: match.slice(1),
      groups: { ...(match.groups ?? {}) } as Record<string, string | undefined>,
    });
    // Zero-width match: advance manually or exec() never moves and this loops forever.
    if (match[0] === "") re.lastIndex += 1;
    if (rows.length >= MATCH_CAP) { truncated = true; break; }
    if (++guard > SAMPLE_CAP) { truncated = true; break; }
  }
  return { rows, error: null, truncated };
}

/**
 * Named capture groups in pattern order, each with the positional number the
 * engine actually assigns it.
 *
 * Counting matters: a named group that follows two unnamed ones is `$3`, not
 * `$1`, so the panel has to walk the pattern rather than number the names it
 * finds. Escapes and character classes are skipped — `\(` and `[(]` open no
 * group — and every `(?…` form except `(?<name>` is non-capturing, including
 * the `(?<=` / `(?<!` lookbehinds that otherwise read as a named group.
 */
function namedGroups(pattern: string): { index: number; name: string }[] {
  const found: { index: number; name: string }[] = [];
  let captures = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") { i += 1; continue; }
    if (inClass) { if (ch === "]") inClass = false; continue; }
    if (ch === "[") { inClass = true; continue; }
    if (ch !== "(") continue;
    const rest = pattern.slice(i + 1);
    const named = /^\?<(?![=!])([A-Za-z_$][\w$]*)>/.exec(rest);
    if (named) { found.push({ index: ++captures, name: named[1] }); continue; }
    if (rest.startsWith("?")) continue;
    captures += 1;
  }
  return found;
}

/** `$1=… name=…` beside a match, so captures are readable without a second table. */
function groupsLabel(row: MatchRow): string {
  const parts = row.positional.map((g, i) => `$${i + 1}=${g ?? EMPTY_MARK}`);
  for (const [name, value] of Object.entries(row.groups)) parts.push(`${name}=${value ?? EMPTY_MARK}`);
  return parts.join("  ");
}

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
  /**
   * Read off the pattern, not off the matches: a group that captured nothing is
   * still a group the user declared, and the panel has to say so.
   */
  const captureGroups = useMemo(() => {
    if (result.error) return [];
    return namedGroups(pattern).map(g => ({
      ...g,
      value: result.rows.find(row => row.groups[g.name] != null)?.groups[g.name],
    }));
  }, [pattern, result]);

  const toggleFlag = (flag: string) => {
    setFlags(prev => (prev.includes(flag) ? prev.replace(flag, "") : prev + flag));
  };

  const insert = (token: string) => {
    setPattern(prev => (prev + token).slice(0, PATTERN_CAP));
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
              onChange={e => setPattern(e.target.value.slice(0, PATTERN_CAP))}
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
            onChange={e => setSample(e.target.value.slice(0, SAMPLE_CAP))}
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
                    {groupsLabel(row)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/*
          Empty state: the prototype shows the header alone when the pattern
          declares no named group, and no key exists for a sentence here — an
          unrelated string would be worse than the blank the design specifies.
        */}
        <Card title={t("regex.groups")}>
          {captureGroups.length > 0 && (
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {captureGroups.map(group => (
                <li key={group.name} className="m3-row" style={PANEL_ROW}>
                  <span style={{ ...MUTED_MONO, fontVariantNumeric: "tabular-nums" }}>${group.index}</span>
                  <span style={{ ...MONO, fontSize: "var(--t-label-m)", fontWeight: 600 }}>{group.name}</span>
                  <span style={{ ...MONO, fontSize: "var(--t-label-m)", color: "var(--m3-on-surface-variant)", minWidth: 0, overflowWrap: "anywhere" }}>
                    {group.value ?? EMPTY_MARK}
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
