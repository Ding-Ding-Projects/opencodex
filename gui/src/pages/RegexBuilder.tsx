/**
 * Regex builder.
 *
 * Engine: the **ECMAScript `RegExp`** built into this browser, evaluated
 * locally. No pattern ever leaves the page.
 *
 * Safety caps, all enforced below: 400-character pattern, 20 000-character
 * sample, 200 matches, and a forced index advance on a zero-width match so a
 * pattern like `(?:)` cannot spin forever.
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
 * Ordered the way the prototype groups them (literals → classes → anchors →
 * groups → alternation → quantifiers) so the headings drop in unchanged once
 * the group keys exist. `tkey` is optional because several constructs have no
 * description key yet, and a chip labelled with the construct itself is better
 * than no chip at all.
 *
 * Every insert is a *complete* construct: `(?<name>)` and not `(?<name>…)`,
 * because the ellipsis is a literal character and silently broke the pattern
 * the moment it was inserted.
 */
const TOKENS: { insert: string; tkey?: TKey }[] = [
  { insert: "abc" },
  { insert: "\\." },
  { insert: "\\\\" },
  { insert: "\\d", tkey: "regex.tokDigit" },
  { insert: "\\w", tkey: "regex.tokWord" },
  { insert: "\\s", tkey: "regex.tokSpace" },
  { insert: ".", tkey: "regex.tokAny" },
  { insert: "[a-z]", tkey: "regex.tokClass" },
  { insert: "[^/]" },
  { insert: "\\p{Script=Han}" },
  { insert: "^", tkey: "regex.tokStart" },
  { insert: "$", tkey: "regex.tokEnd" },
  { insert: "\\b", tkey: "regex.tokBoundary" },
  { insert: "()" },
  { insert: "(?<name>)", tkey: "regex.tokNamed" },
  { insert: "(?:)", tkey: "regex.tokGroup" },
  { insert: "(?=)" },
  { insert: "|", tkey: "regex.tokAlt" },
  { insert: "*", tkey: "regex.tokStar" },
  { insert: "+", tkey: "regex.tokPlus" },
  { insert: "?", tkey: "regex.tokOpt" },
  { insert: "{1,3}", tkey: "regex.tokRange" },
  { insert: "+?" },
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

/** `$1=… name=…` beside a match, so captures are readable without a second table. */
function groupsLabel(row: MatchRow): string {
  const parts = row.positional.map((g, i) => `$${i + 1}=${g ?? EMPTY_MARK}`);
  for (const [name, value] of Object.entries(row.groups)) parts.push(`${name}=${value ?? EMPTY_MARK}`);
  return parts.join("  ");
}

const MONO = { fontFamily: "var(--mono)" } as const;

export default function RegexBuilder() {
  const t = useT();
  const { notify } = useNotifications();
  const [pattern, setPattern] = useState(PRESETS[0].pattern);
  const [flags, setFlags] = useState(PRESETS[0].flags);
  const [sample, setSample] = useState(PRESETS[0].sample);

  const result = useMemo(() => evaluate(pattern, flags, sample), [pattern, flags, sample]);
  const groupNames = useMemo(() => {
    const names = new Set<string>();
    for (const row of result.rows) for (const name of Object.keys(row.groups)) names.add(name);
    return [...names];
  }, [result.rows]);

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
    const lines = [
      `# ${t("regex.title")}`,
      "",
      `- ${t("regex.engineLabel")}: ${t("regex.engineValue")}`,
      `- ${t("regex.pattern")}: \`${pattern}\``,
      `- ${t("regex.flags")}: \`${flags || "—"}\``,
      `- ${t("regex.matchCount")}: ${result.rows.length}${result.truncated ? "+" : ""}`,
      "",
      "| # | " + t("regex.colIndex") + " | " + t("regex.colMatch") + (groupNames.length ? " | " + groupNames.join(" | ") : "") + " |",
      "|---|---|---" + groupNames.map(() => "|---").join("") + "|",
      ...result.rows.map((row, i) =>
        `| ${i + 1} | ${row.index} | \`${row.text}\`` + groupNames.map(n => ` | ${row.groups[n] ?? ""}`).join("") + " |"),
    ];
    void copy(lines.join("\n"), t("regex.exported"));
  };

  return (
    <>
      <Card title={t("regex.title")} subtitle={t("regex.sub")}>
        <p style={{ margin: "0 0 var(--sp-3)", fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)" }}>
          {t("regex.engineNote")}
        </p>

        <Field label={t("regex.presets")}>
          <div className="m3-row" style={{ gap: 8 }} role="group" aria-label={t("regex.presets")}>
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
        </Field>
      </Card>

      <Card title={t("regex.palette")}>
        <div className="m3-row" style={{ gap: 6 }} role="group" aria-label={t("regex.palette")}>
          {TOKENS.map(tok => (
            <Chip key={tok.insert} onClick={() => insert(tok.insert)} title={tok.tkey ? t(tok.tkey) : undefined}>
              <code style={MONO}>{tok.insert}</code>
            </Chip>
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
            onChange={e => setSample(e.target.value.slice(0, SAMPLE_CAP))}
          />
        </Field>

        <div className="m3-row">
          <Button onClick={() => void copy(`/${pattern}/${flags}`, t("regex.copied"))}>
            <IconCopy aria-hidden="true" />
            {t("regex.copy")}
          </Button>
          <Button variant="outlined" onClick={exportMarkdown}>{t("regex.export")}</Button>
        </div>
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
                <li
                  key={`${row.index}-${i}`}
                  className="m3-row"
                  style={{ gap: 10, alignItems: "baseline", padding: "8px 0", borderBottom: "1px solid var(--m3-outline-variant)" }}
                >
                  <span style={{ ...MONO, fontSize: "var(--t-label-s)", color: "var(--m3-on-surface-variant)", fontVariantNumeric: "tabular-nums" }}>
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
                  <span style={{ ...MONO, fontSize: "var(--t-label-s)", color: "var(--m3-on-surface-variant)", minWidth: 0, overflowWrap: "anywhere" }}>
                    {groupsLabel(row)}
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
