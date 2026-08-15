/**
 * Finds the management endpoints a source file actually *requests*, as opposed
 * to the ones it merely *talks about*.
 *
 * The naive version of this — regex `/api/[\w./-]+` over the raw file text —
 * cannot tell a call site from prose, and `gui/src/docs/generated-articles.ts`
 * is a file made entirely of prose: the documentation browser's bundled corpus,
 * where each article body is one enormous string literal. That corpus quotes
 * third-party base URLs (`https://openrouter.ai/api/v1`,
 * `https://api.kilo.ai/api/gateway`) and names opencodex routes inside Markdown
 * reference tables (`GET /api/key-providers`). None of those are things the GUI
 * calls, and a scanner that reports them is reporting the documentation rather
 * than the application.
 *
 * So the scan works on the parsed source rather than on its characters, and
 * accepts a path only when it sits inside a **request target**: a string or
 * template literal, appearing in code, that is *itself* a URL. Two properties
 * do all the work:
 *
 *   - Text nested inside a string literal is not code. A backtick inside an
 *     article body is a character; a backtick in the file is a template
 *     literal. Only a real lexer can tell those apart, so the TypeScript
 *     parser does the lexing.
 *   - A URL has no whitespace. Prose does. An article body is therefore
 *     rejected whole, with no guessing about which of its sentences look
 *     path-shaped — and a comment is never a literal in the first place.
 *
 * A literal carrying its own `://` scheme is somebody else's origin rather than
 * this proxy's management API: the GUI reaches its own routes through an
 * interpolated base (`${apiBase}/api/...`) or a bare absolute path.
 *
 * Deliberately not an ignore list. A route that stops being called anywhere
 * drops out of the scan on its own, and a new route that only ever appears in a
 * docs table still fails to count as reachable — which is the honest answer,
 * because nothing calls it.
 */
import ts from "typescript";

/**
 * Stands in for a `${...}` interpolation while a literal's shape is judged.
 * Not whitespace, so an interpolated base URL cannot make its own literal read
 * as prose; outside the endpoint character class, so no path is ever read
 * across one.
 */
const INTERPOLATION = "*";

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(m|c)?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** The cooked text of a literal, with every interpolation replaced by a marker. */
function literalShape(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.reduce(
      (shape, span) => `${shape}${INTERPOLATION}${span.literal.text}`,
      node.head.text,
    );
  }
  return null;
}

/** True when a literal reads as a URL rather than as something written for a human. */
function isRequestTarget(shape: string): boolean {
  if (/\s/.test(shape)) return false; // prose, Markdown, a whole article
  if (shape.includes("://")) return false; // a third party's origin, not this API
  return shape.includes("/api/");
}

/**
 * Every `/api/...` path this source requests, normalised the way the parity
 * coverage table spells them: query string dropped, trailing `/` and `.` trimmed.
 */
export function collectApiCallSites(source: string, fileName = "module.ts"): Set<string> {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, scriptKind(fileName));
  const endpoints = new Set<string>();
  const visit = (node: ts.Node): void => {
    const shape = literalShape(node);
    if (shape !== null && isRequestTarget(shape)) {
      for (const match of shape.matchAll(/\/api\/[A-Za-z0-9_./-]+/g)) {
        endpoints.add(match[0].replace(/\.+$/, "").replace(/\/$/, ""));
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(parsed, visit);
  return endpoints;
}
