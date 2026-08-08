/**
 * Every coding format an export can be written in.
 *
 * The rule is that anything the app can show, the user can take away — and in a
 * format that actually suits the data rather than the one format somebody
 * happened to implement first. Tabular things want CSV; structured records want
 * JSON or YAML; a document wants Markdown.
 *
 * ## The part that matters more than the formats
 *
 * **A format that would silently drop a field is not offered.** `describeFidelity`
 * answers, for a given shape of data, what each format can and cannot carry, and
 * callers are expected to show that *before* the export runs. Truncating quietly
 * is the failure this exists to prevent: a CSV of nested records looks like a
 * successful export and is missing most of the data, and nothing about the file
 * says so.
 *
 * Every writer here is pure — value in, string out, no filesystem, no clock, no
 * config. That is what makes the fidelity claims testable rather than asserted.
 */

/** The formats an export can be written in. */
export type ExportFormat =
  | "json" | "jsonl" | "yaml" | "toml" | "xml"
  | "csv" | "tsv" | "markdown" | "html" | "sql"
  | "ts" | "js" | "py" | "go" | "json-schema";

export const EXPORT_FORMATS: readonly ExportFormat[] = [
  "json", "jsonl", "yaml", "toml", "xml",
  "csv", "tsv", "markdown", "html", "sql",
  "ts", "js", "py", "go", "json-schema",
] as const;

export interface FormatMeta {
  /** What a file picker should call it. */
  label: string;
  extension: string;
  /** For HTTP and for the archive's own manifest. */
  mime: string;
}

export const FORMAT_META: Record<ExportFormat, FormatMeta> = {
  json: { label: "JSON", extension: "json", mime: "application/json" },
  jsonl: { label: "JSON Lines", extension: "jsonl", mime: "application/x-ndjson" },
  yaml: { label: "YAML", extension: "yaml", mime: "application/yaml" },
  toml: { label: "TOML", extension: "toml", mime: "application/toml" },
  xml: { label: "XML", extension: "xml", mime: "application/xml" },
  csv: { label: "CSV", extension: "csv", mime: "text/csv" },
  tsv: { label: "TSV", extension: "tsv", mime: "text/tab-separated-values" },
  markdown: { label: "Markdown", extension: "md", mime: "text/markdown" },
  html: { label: "HTML", extension: "html", mime: "text/html" },
  sql: { label: "SQL", extension: "sql", mime: "application/sql" },
  ts: { label: "TypeScript", extension: "ts", mime: "text/typescript" },
  js: { label: "JavaScript", extension: "js", mime: "text/javascript" },
  py: { label: "Python", extension: "py", mime: "text/x-python" },
  go: { label: "Go", extension: "go", mime: "text/x-go" },
  "json-schema": { label: "JSON Schema", extension: "schema.json", mime: "application/schema+json" },
};

/** A row-shaped export: a list of flat-ish records sharing a column set. */
export type Row = Record<string, unknown>;

export interface ExportInput {
  /** Used for the root element, the table name, the heading, the type name. */
  name: string;
  rows: Row[];
}

// ------------------------------------------------------------------ fidelity

export type FidelityLevel = "full" | "lossy" | "impossible";

export interface Fidelity {
  level: FidelityLevel;
  /** Said to the user before the export runs. Empty when nothing is lost. */
  losses: string[];
}

/** True for a value a flat text grid (CSV/TSV) cannot represent as one cell. */
function isNested(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

/**
 * What a format can and cannot carry for *this* data.
 *
 * Deliberately computed from the rows rather than declared per format: CSV is
 * lossless for flat records and lossy for nested ones, and saying so only in
 * general terms would be useless exactly when it matters.
 */
export function describeFidelity(input: ExportInput, format: ExportFormat): Fidelity {
  const rows = input.rows;
  const keys = columnsOf(rows);
  const nestedKeys = keys.filter(key => rows.some(row => isNested(row[key])));
  const ragged = rows.some(row => keys.some(key => !(key in row)));

  switch (format) {
    case "json":
    case "jsonl":
    case "yaml":
      // These carry arbitrary nesting, null, and absent-vs-empty distinctions.
      return { level: "full", losses: [] };

    case "toml":
      // TOML has no top-level null. A key whose value is null cannot be written
      // at all, so it is omitted — which is a real difference from JSON, where
      // `null` and "absent" are distinguishable.
      return nullKeys(rows).length
        ? {
          level: "lossy",
          losses: [`TOML cannot express null; ${nullKeys(rows).join(", ")} will be omitted where null.`],
        }
        : { level: "full", losses: [] };

    case "xml":
      return {
        level: "lossy",
        losses: ["XML records everything as text: numbers, booleans and null read back as strings unless the reader applies a schema."],
      };

    case "csv":
    case "tsv": {
      const losses: string[] = [];
      if (nestedKeys.length) {
        losses.push(`${nestedKeys.join(", ")} ${nestedKeys.length === 1 ? "holds" : "hold"} nested data, which is flattened to JSON text inside the cell.`);
      }
      if (ragged) losses.push("Records do not all share the same keys; missing ones become empty cells, indistinguishable from an empty value.");
      losses.push("Types are not carried: every value reads back as text.");
      return { level: "lossy", losses };
    }

    case "markdown":
    case "html":
      return {
        level: "lossy",
        losses: ["Written for reading, not for re-import: values are rendered as text and nesting is flattened."],
      };

    case "sql":
      return {
        level: "lossy",
        losses: ["Column types are inferred from the first non-null value in each column; a column mixing types is widened to TEXT."],
      };

    case "ts":
    case "js":
      return { level: "full", losses: [] };

    case "py":
      return {
        level: "lossy",
        losses: ["Written as a Python literal: JSON `null` becomes `None`, and booleans become `True`/`False`."],
      };

    case "go":
      return {
        level: "lossy",
        losses: ["Emitted as a typed struct slice; a column mixing types falls back to `any`, and column names are converted to exported Go identifiers."],
      };

    case "json-schema":
      return {
        level: "impossible",
        losses: ["A schema describes the shape of the data, not the data. No rows are written."],
      };
  }
}

function nullKeys(rows: Row[]): string[] {
  return columnsOf(rows).filter(key => rows.some(row => row[key] === null));
}

/** The union of every key, in first-seen order, so a ragged set still exports. */
export function columnsOf(rows: Row[]): string[] {
  const seen: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!seen.includes(key)) seen.push(key);
  }
  return seen;
}

// ------------------------------------------------------------------- writers

const cell = (value: unknown): string =>
  value === null || value === undefined ? "" : isNested(value) ? JSON.stringify(value) : String(value);

/** RFC 4180: quote when the value contains the delimiter, a quote or a newline. */
function delimited(input: ExportInput, sep: string): string {
  const keys = columnsOf(input.rows);
  const escape = (raw: string) =>
    /["\r\n]/.test(raw) || raw.includes(sep) ? `"${raw.replace(/"/g, '""')}"` : raw;
  const lines = [keys.map(escape).join(sep)];
  for (const row of input.rows) lines.push(keys.map(key => escape(cell(row[key]))).join(sep));
  return lines.join("\n") + "\n";
}

function yamlValue(value: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return "\n" + value.map(item => `${pad}- ${yamlValue(item, indent + 1).replace(/^\n/, "")}`).join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Row);
    if (!entries.length) return "{}";
    return "\n" + entries.map(([k, v]) => `${pad}${yamlKey(k)}: ${yamlValue(v, indent + 1)}`).join("\n");
  }
  if (typeof value === "string") {
    // Quote anything that would otherwise parse as another type, or that starts
    // with a character YAML gives meaning to.
    return /^[\s]|[\s]$|^$|^[-?:,[\]{}#&*!|>'"%@`]|^(true|false|null|yes|no|on|off|~)$|^-?\d+(\.\d+)?$/i.test(value)
      ? JSON.stringify(value)
      : value;
  }
  return String(value);
}

const yamlKey = (key: string) => (/^[A-Za-z_][\w.-]*$/.test(key) ? key : JSON.stringify(key));

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

const xmlEscape = (raw: string) =>
  raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** XML element names are far stricter than JSON keys; fall back to an attribute. */
function xmlTag(key: string): { tag: string; nameAttr: string } {
  return /^[A-Za-z_][\w.-]*$/.test(key)
    ? { tag: key, nameAttr: "" }
    : { tag: "field", nameAttr: ` name="${xmlEscape(key)}"` };
}

const htmlEscape = xmlEscape;

/** Markdown table cells cannot contain a raw pipe or a newline. */
const mdCell = (raw: string) => raw.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

const sqlString = (raw: string) => `'${raw.replace(/'/g, "''")}'`;

function sqlType(rows: Row[], key: string): string {
  const values = rows.map(row => row[key]).filter(value => value !== null && value !== undefined);
  if (!values.length) return "TEXT";
  if (values.every(value => typeof value === "boolean")) return "BOOLEAN";
  if (values.every(value => typeof value === "number")) {
    return values.every(value => Number.isInteger(value)) ? "INTEGER" : "REAL";
  }
  return "TEXT";
}

const sqlIdent = (raw: string) => `"${raw.replace(/"/g, '""')}"`;

/** A safe identifier for languages that need one, e.g. `total-cost` -> `totalCost`. */
function camel(raw: string): string {
  const cleaned = raw.replace(/[^\w]+(.)?/g, (_, chr: string | undefined) => (chr ? chr.toUpperCase() : ""));
  return /^\d/.test(cleaned) ? `_${cleaned}` : cleaned || "field";
}

const pascal = (raw: string) => {
  const c = camel(raw);
  return c.charAt(0).toUpperCase() + c.slice(1);
};

function pyLiteral(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (Array.isArray(value)) return `[${value.map(pyLiteral).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Row).map(([k, v]) => `${JSON.stringify(k)}: ${pyLiteral(v)}`).join(", ")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

function goType(rows: Row[], key: string): string {
  const values = rows.map(row => row[key]).filter(value => value !== null && value !== undefined);
  if (!values.length) return "any";
  if (values.every(value => typeof value === "boolean")) return "bool";
  if (values.every(value => typeof value === "number")) {
    return values.every(value => Number.isInteger(value)) ? "int64" : "float64";
  }
  if (values.every(value => typeof value === "string")) return "string";
  return "any";
}

function jsonSchemaType(rows: Row[], key: string): Record<string, unknown> {
  const values = rows.map(row => row[key]);
  const nullable = values.some(value => value === null || value === undefined);
  const present = values.filter(value => value !== null && value !== undefined);
  let type: string = "string";
  if (!present.length) type = "string";
  else if (present.every(value => typeof value === "boolean")) type = "boolean";
  else if (present.every(value => typeof value === "number")) {
    type = present.every(value => Number.isInteger(value)) ? "integer" : "number";
  } else if (present.every(value => Array.isArray(value))) type = "array";
  else if (present.every(value => value !== null && typeof value === "object")) type = "object";
  return { type: nullable ? [type, "null"] : type };
}

/**
 * Write the rows in `format`.
 *
 * Always returns a complete document. It never throws for lossy data — the loss
 * is described by `describeFidelity` and is the caller's job to surface *before*
 * calling this, because a writer that refused here would simply be a failure the
 * user could not have anticipated.
 */
export function serialize(input: ExportInput, format: ExportFormat): string {
  const { name, rows } = input;
  const keys = columnsOf(rows);

  switch (format) {
    case "json":
      return JSON.stringify(rows, null, 2) + "\n";

    case "jsonl":
      return rows.map(row => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : "");

    case "yaml":
      if (!rows.length) return "[]\n";
      return rows
        .map(row => {
          const body = Object.entries(row)
            .map(([k, v], i) => `${i === 0 ? "- " : "  "}${yamlKey(k)}: ${yamlValue(v, 2)}`)
            .join("\n");
          return body;
        })
        .join("\n") + "\n";

    case "toml":
      // An array of tables: the shape TOML has for a list of records.
      return rows
        .map(row => {
          const lines = [`[[${name}]]`];
          for (const [k, v] of Object.entries(row)) {
            if (v === null || v === undefined) continue; // see describeFidelity
            lines.push(`${yamlKey(k)} = ${tomlValue(v)}`);
          }
          return lines.join("\n");
        })
        .join("\n\n") + "\n";

    case "xml": {
      const body = rows
        .map(row => {
          const fields = Object.entries(row)
            .map(([k, v]) => {
              const { tag, nameAttr } = xmlTag(k);
              return `    <${tag}${nameAttr}>${xmlEscape(cell(v))}</${tag}>`;
            })
            .join("\n");
          return `  <record>\n${fields}\n  </record>`;
        })
        .join("\n");
      return `<?xml version="1.0" encoding="UTF-8"?>\n<${xmlTag(name).tag}>\n${body}\n</${xmlTag(name).tag}>\n`;
    }

    case "csv":
      return delimited(input, ",");

    case "tsv":
      return delimited(input, "\t");

    case "markdown": {
      if (!keys.length) return `# ${name}\n\n_No records._\n`;
      const header = `| ${keys.map(mdCell).join(" | ")} |`;
      const rule = `| ${keys.map(() => "---").join(" | ")} |`;
      const body = rows.map(row => `| ${keys.map(key => mdCell(cell(row[key]))).join(" | ")} |`);
      return `# ${name}\n\n${[header, rule, ...body].join("\n")}\n`;
    }

    case "html": {
      const header = keys.map(key => `<th>${htmlEscape(key)}</th>`).join("");
      const body = rows
        .map(row => `<tr>${keys.map(key => `<td>${htmlEscape(cell(row[key]))}</td>`).join("")}</tr>`)
        .join("\n");
      return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>${htmlEscape(name)}</title>
<table>
<caption>${htmlEscape(name)}</caption>
<thead><tr>${header}</tr></thead>
<tbody>
${body}
</tbody>
</table>
</html>
`;
    }

    case "sql": {
      const table = sqlIdent(name);
      const columns = keys.map(key => `  ${sqlIdent(key)} ${sqlType(rows, key)}`).join(",\n");
      const inserts = rows.map(row => {
        const values = keys
          .map(key => {
            const value = row[key];
            if (value === null || value === undefined) return "NULL";
            if (typeof value === "number") return String(value);
            if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
            return sqlString(cell(value));
          })
          .join(", ");
        return `INSERT INTO ${table} (${keys.map(sqlIdent).join(", ")}) VALUES (${values});`;
      });
      return `CREATE TABLE ${table} (\n${columns}\n);\n\n${inserts.join("\n")}\n`;
    }

    case "ts": {
      const typeName = pascal(name);
      const fields = keys
        .map(key => {
          const t = goType(rows, key); // reuse the same inference
          const ts = t === "int64" || t === "float64" ? "number" : t === "bool" ? "boolean" : t === "any" ? "unknown" : "string";
          const optional = rows.some(row => row[key] === null || row[key] === undefined) ? "?" : "";
          return `  ${/^[A-Za-z_]\w*$/.test(key) ? key : JSON.stringify(key)}${optional}: ${ts};`;
        })
        .join("\n");
      return `export interface ${typeName} {\n${fields}\n}\n\nexport const ${camel(name)}: ${typeName}[] = ${JSON.stringify(rows, null, 2)};\n`;
    }

    case "js":
      return `export const ${camel(name)} = ${JSON.stringify(rows, null, 2)};\n`;

    case "py":
      return `${camel(name)} = [\n${rows.map(row => `    ${pyLiteral(row)},`).join("\n")}\n]\n`;

    case "go": {
      const typeName = pascal(name);
      const fields = keys
        .map(key => `\t${pascal(key)} ${goType(rows, key)} \`json:"${key}"\``)
        .join("\n");
      const literals = rows
        .map(row => {
          const inner = keys
            .map(key => {
              const value = row[key];
              if (value === null || value === undefined) return null;
              const t = goType(rows, key);
              const rendered = t === "string" || t === "any" ? JSON.stringify(cell(value)) : String(value);
              return `${pascal(key)}: ${rendered}`;
            })
            .filter(Boolean)
            .join(", ");
          return `\t{${inner}},`;
        })
        .join("\n");
      return `package ${camel(name).toLowerCase() || "export"}\n\ntype ${typeName} struct {\n${fields}\n}\n\nvar ${typeName}s = []${typeName}{\n${literals}\n}\n`;
    }

    case "json-schema": {
      const properties: Record<string, unknown> = {};
      for (const key of keys) properties[key] = jsonSchemaType(rows, key);
      const required = keys.filter(key => rows.every(row => key in row && row[key] !== null && row[key] !== undefined));
      return JSON.stringify(
        {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          title: name,
          type: "array",
          items: { type: "object", properties, required, additionalProperties: false },
        },
        null,
        2,
      ) + "\n";
    }
  }
}

/**
 * `usage.csv`, `providers.schema.json` — the name a download should carry.
 *
 * Everything outside `[A-Za-z0-9_.-]` becomes a dash, so a separator can never
 * survive into the name and no export can be steered out of the directory it was
 * written to.
 *
 * Leading dots go too, which is not cosmetic: a record called `.env` would
 * otherwise export as `.env.json`, a dotfile that the user's file manager does
 * not show them by default. An export they cannot see is an export that did not
 * happen.
 */
export function filenameFor(name: string, format: ExportFormat): string {
  const safe = name
    .replace(/[^\w.-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "")
    || "export";
  return `${safe}.${FORMAT_META[format].extension}`;
}
