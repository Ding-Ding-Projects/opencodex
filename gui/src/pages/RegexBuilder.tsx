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
import { useT } from "../i18n/shared";
import { useNotifications } from "../shell/notifications-context";
import type { TKey } from "../i18n/shared";

const PATTERN_CAP = 400;
const SAMPLE_CAP = 20_000;
const MATCH_CAP = 200;

const FLAGS: { flag: string; tkey: TKey }[] = [
  { flag: "g", tkey: "regex.flagG" },
  { flag: "i", tkey: "regex.flagI" },
  { flag: "m", tkey: "regex.flagM" },
  { flag: "s", tkey: "regex.flagS" },
  { flag: "u", tkey: "regex.flagU" },
  { flag: "y", tkey: "regex.flagY" },
];

/** Guided palette: insert a construct rather than remembering its syntax. */
const TOKENS: { insert: string; tkey: TKey }[] = [
  { insert: "\\d", tkey: "regex.tokDigit" },
  { insert: "\\w", tkey: "regex.tokWord" },
  { insert: "\\s", tkey: "regex.tokSpace" },
  { insert: ".", tkey: "regex.tokAny" },
  { insert: "[a-z]", tkey: "regex.tokClass" },
  { insert: "+", tkey: "regex.tokPlus" },
  { insert: "*", tkey: "regex.tokStar" },
  { insert: "?", tkey: "regex.tokOpt" },
  { insert: "{1,3}", tkey: "regex.tokRange" },
  { insert: "(?<name>…)", tkey: "regex.tokNamed" },
  { insert: "(?:…)", tkey: "regex.tokGroup" },
  { insert: "^", tkey: "regex.tokStart" },
  { insert: "$", tkey: "regex.tokEnd" },
  { insert: "\\b", tkey: "regex.tokBoundary" },
  { insert: "|", tkey: "regex.tokAlt" },
];

const PRESETS: { tkey: TKey; pattern: string; flags: string }[] = [
  { tkey: "regex.presetResponseId", pattern: "resp_(?<id>[0-9a-f]{6,})", flags: "g" },
  { tkey: "regex.presetStatus", pattern: "\\b(?<status>[45]\\d{2})\\b", flags: "g" },
  { tkey: "regex.presetModel", pattern: "(?<vendor>[a-z]+)/(?<model>[\\w.\\-]+)", flags: "gi" },
  { tkey: "regex.presetToken", pattern: "sk-[A-Za-z0-9_\\-]{16,}", flags: "g" },
];

interface MatchRow {
  index: number;
  text: string;
  groups: Record<string, string>;
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
      groups: { ...(match.groups ?? {}) } as Record<string, string>,
    });
    // Zero-width match: advance manually or exec() never moves and this loops forever.
    if (match[0] === "") re.lastIndex += 1;
    if (rows.length >= MATCH_CAP) { truncated = true; break; }
    if (++guard > SAMPLE_CAP) { truncated = true; break; }
  }
  return { rows, error: null, truncated };
}

export default function RegexBuilder() {
  const t = useT();
  const { notify } = useNotifications();
  const [pattern, setPattern] = useState("resp_(?<id>[0-9a-f]{6,})");
  const [flags, setFlags] = useState("g");
  const [sample, setSample] = useState(
    "resp_9fa2c1 200 · resp_9f7q88 429 · resp_9f4b71 502\nresp_beefed 200",
  );

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
          <div className="m3-row" style={{ gap: 8 }}>
            {PRESETS.map(p => (
              <Chip key={p.pattern} onClick={() => { setPattern(p.pattern); setFlags(p.flags); }}>
                {t(p.tkey)}
              </Chip>
            ))}
          </div>
        </Field>

        <Field label={t("regex.palette")}>
          <div className="m3-row" style={{ gap: 6 }}>
            {TOKENS.map(tok => (
              <Chip key={tok.insert} onClick={() => insert(tok.insert)} title={t(tok.tkey)}>
                <code style={{ fontFamily: "var(--mono)" }}>{tok.insert}</code>
              </Chip>
            ))}
          </div>
        </Field>

        <Field
          id="ocx-rx-pattern"
          label={t("regex.pattern")}
          hint={t("regex.patternCap", { used: String(pattern.length), cap: String(PATTERN_CAP) })}
        >
          <TextInput
            id="ocx-rx-pattern"
            value={pattern}
            spellCheck={false}
            aria-invalid={!!result.error}
            onChange={e => setPattern(e.target.value.slice(0, PATTERN_CAP))}
            style={{ fontFamily: "var(--mono)" }}
          />
        </Field>

        <Field label={t("regex.flags")}>
          <div className="m3-row" style={{ gap: 6 }}>
            {FLAGS.map(f => (
              <Chip key={f.flag} selected={flags.includes(f.flag)} onClick={() => toggleFlag(f.flag)} title={t(f.tkey)}>
                <code style={{ fontFamily: "var(--mono)" }}>{f.flag}</code>
              </Chip>
            ))}
          </div>
        </Field>

        {result.error && (
          <p role="alert" style={{ color: "var(--m3-error)", fontSize: "var(--t-body-s)" }}>
            {t("regex.invalid")}: {result.error}
          </p>
        )}

        <div className="m3-row">
          <Button variant="tonal" onClick={() => void copy(`/${pattern}/${flags}`, t("regex.copied"))}>
            {t("regex.copy")}
          </Button>
          <Button variant="outlined" onClick={exportMarkdown}>{t("regex.export")}</Button>
        </div>
      </Card>

      <Card
        title={t("regex.sample")}
        subtitle={t("regex.sampleCap", { used: String(sample.length), cap: String(SAMPLE_CAP) })}
      >
        <TextArea
          value={sample}
          spellCheck={false}
          aria-label={t("regex.sample")}
          onChange={e => setSample(e.target.value.slice(0, SAMPLE_CAP))}
        />
      </Card>

      <Card
        title={t("regex.matches")}
        subtitle={result.truncated
          ? t("regex.matchTruncated", { cap: String(MATCH_CAP) })
          : t("regex.matchCountValue", { count: String(result.rows.length) })}
      >
        {result.rows.length === 0 ? (
          <p style={{ color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>{t("regex.noMatches")}</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="m3-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t("regex.colIndex")}</th>
                  <th>{t("regex.colMatch")}</th>
                  {groupNames.map(name => <th key={name}>{name}</th>)}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={`${row.index}-${i}`}>
                    <td>{i + 1}</td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{row.index}</td>
                    <td><code style={{ fontFamily: "var(--mono)" }}>{row.text || "∅"}</code></td>
                    {groupNames.map(name => (
                      <td key={name}><code style={{ fontFamily: "var(--mono)" }}>{row.groups[name] ?? ""}</code></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
