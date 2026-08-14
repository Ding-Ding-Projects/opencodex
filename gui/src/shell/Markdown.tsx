/**
 * The app's one shared, isolated Markdown renderer.
 *
 * Provider-authored text — release notes, issue bodies, README previews, and
 * (the reason this exists) the in-app documentation browser's bundled
 * articles — has to be RENDERED as the markup it is, not printed as source.
 * `Changelog.tsx` already gets this half right by construction: its entries
 * are single conventional-commit lines with nothing to render, so there was
 * previously no surface in this app actually printing raw Markdown syntax at
 * a user. This component is that surface's renderer, built once so a second
 * one never has to reinvent headings, code fences and link handling from
 * scratch, and so every future provider-text surface renders identically.
 *
 * ## Isolated on purpose
 *
 * This is a hand-rolled Markdown-subset parser, not a full CommonMark
 * implementation, and it renders directly to React elements rather than ever
 * building an HTML string and injecting it. There is no `dangerouslySetInnerHTML`
 * anywhere in this file — a `<script>` tag or an `onerror=` attribute typed
 * into an article's body is inert text on the page, never live DOM, because
 * the renderer never round-trips through the browser's HTML parser at all.
 * That is the whole point of "isolated": remote-authored text can describe
 * *content*, never *behaviour*.
 *
 * ## What is supported
 *
 * Headings, paragraphs, **bold**, `` `inline code` ``, fenced code blocks,
 * ordered/unordered lists (with one level of nesting), blockquotes,
 * horizontal rules, pipe tables, links, and Starlight-style `:::note[Title]`
 * / `:::tip` / `:::caution` / `:::danger` aside blocks — every construct the
 * bundled documentation corpus actually uses (see `scripts/docs-article-source.ts`'s
 * header for which corpus that is). Underscore (`_..._`) is deliberately NOT
 * treated as italic: this corpus is full of `snake_case_identifiers`,
 * `ENV_VAR_NAMES` and config keys in running prose, and a parser that read
 * `_..._` as emphasis would light up an underscore in the middle of an
 * identifier as often as it found real italics. `*text*` is unambiguous here
 * because bare asterisks essentially never appear outside real emphasis in
 * the source corpus.
 */

import { Fragment, createElement, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { IconExternal } from "../icons";
import { useT } from "../i18n/shared";
import type { TFn, TKey } from "../i18n/shared";

export type AsideKind = "note" | "tip" | "caution" | "danger";

interface HeadingBlock { type: "heading"; level: number; text: string }
interface ParagraphBlock { type: "paragraph"; text: string }
interface CodeBlock { type: "code"; lang: string | null; code: string }
interface ListItem { text: string; children: Block[] }
interface ListBlock { type: "list"; ordered: boolean; items: ListItem[] }
interface QuoteBlock { type: "quote"; blocks: Block[] }
interface HrBlock { type: "hr" }
interface TableBlock { type: "table"; header: string[]; align: CellAlign[]; rows: string[][] }
interface AsideBlock { type: "aside"; kind: AsideKind; title: string | null; blocks: Block[] }

type Block = HeadingBlock | ParagraphBlock | CodeBlock | ListBlock | QuoteBlock | HrBlock | TableBlock | AsideBlock;

const ASIDE_KINDS = new Set<AsideKind>(["note", "tip", "caution", "danger"]);

function normalizeAsideKind(raw: string): AsideKind {
  const lower = raw.toLowerCase();
  return ASIDE_KINDS.has(lower as AsideKind) ? (lower as AsideKind) : "note";
}

/** Leading whitespace width, treating a tab as one column — the corpus never mixes tabs into lists. */
function indentOf(line: string): number {
  const m = /^ */.exec(line);
  return m ? m[0].length : 0;
}

const TABLE_ROW = /^\|(.*)\|\s*$/;
const TABLE_SEPARATOR_CELL = /^:?-+:?$/;

function splitTableRow(line: string): string[] {
  const m = TABLE_ROW.exec(line.trim());
  const inner = m ? m[1] : line.trim();
  return inner.split("|").map(cell => cell.trim());
}

function isTableSeparator(line: string): boolean {
  if (!TABLE_ROW.test(line.trim())) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every(c => TABLE_SEPARATOR_CELL.test(c));
}

type CellAlign = "left" | "center" | "right" | null;

function tableAlign(cell: string): CellAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function cellStyle(align: CellAlign): { textAlign: "left" | "center" | "right" } | undefined {
  return align ? { textAlign: align } : undefined;
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/**
 * Block-level parser. Recursive: a blockquote's and an aside's contents are
 * their own line arrays, parsed by calling this again, which is what lets a
 * list or a nested aside appear inside either without a second code path.
 */
function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  const isBlockStart = (line: string): boolean =>
    /^#{1,6}\s/.test(line) || /^```/.test(line) || /^:::\w/.test(line.trim())
    || /^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim()) || /^>/.test(line)
    || LIST_ITEM.test(line) || TABLE_ROW.test(line.trim());

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") { i++; continue; }

    const fence = /^(`{3,})\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const lang = fence[2] || null;
      const code: string[] = [];
      i++;
      while (i < lines.length && lines[i]!.trim() !== marker) { code.push(lines[i]!); i++; }
      i++; // consume the closing fence, if any — an unterminated fence just runs to EOF
      blocks.push({ type: "code", lang, code: code.join("\n") });
      continue;
    }

    const asideOpen = /^:::(\w+)(?:\[(.*)\])?\s*$/.exec(line.trim());
    if (asideOpen) {
      const inner: string[] = [];
      i++;
      while (i < lines.length && lines[i]!.trim() !== ":::") { inner.push(lines[i]!); i++; }
      i++;
      blocks.push({ type: "aside", kind: normalizeAsideKind(asideOpen[1]!), title: asideOpen[2] ?? null, blocks: parseBlocks(inner) });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
      i++;
      continue;
    }

    // A horizontal rule and a table separator row look similar (both are runs of
    // punctuation) but a separator always contains at least one pipe; ordering
    // the table check first below is what tells them apart, so this rule only
    // fires for a genuine `---`/`***`/`___` line.
    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (TABLE_ROW.test(line.trim()) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const header = splitTableRow(line);
      const align = splitTableRow(lines[i + 1]!).map(tableAlign);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i]!.trim())) { rows.push(splitTableRow(lines[i]!)); i++; }
      blocks.push({ type: "table", header, align, rows });
      continue;
    }

    if (/^>/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && /^>/.test(lines[i]!)) { inner.push(lines[i]!.replace(/^>\s?/, "")); i++; }
      blocks.push({ type: "quote", blocks: parseBlocks(inner) });
      continue;
    }

    const listItemMatch = LIST_ITEM.exec(line);
    if (listItemMatch) {
      const baseIndent = listItemMatch[1]!.length;
      const ordered = /\d/.test(listItemMatch[2]!);
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]!);
        if (!m || m[1]!.length !== baseIndent || /\d/.test(m[2]!) !== ordered) break;
        i++;
        const primary = m[3]!;
        // Continuation lines: anything indented further than this item's marker,
        // including a blank line that is itself followed by more indented text
        // (a nested list separated from its parent item by a blank line, which
        // this corpus's config-option lists use). Collected raw and re-parsed
        // as their own block list after dedenting, so a nested bullet list or a
        // wrapped paragraph inside one item both just work.
        const childLines: string[] = [];
        while (i < lines.length) {
          const next = lines[i]!;
          if (next.trim() === "") {
            const after = lines[i + 1];
            if (after !== undefined && after.trim() !== "" && indentOf(after) > baseIndent) { childLines.push(""); i++; continue; }
            break;
          }
          if (indentOf(next) > baseIndent) { childLines.push(next); i++; continue; }
          break;
        }
        const dedentBy = childLines.reduce((min, l) => l.trim() === "" ? min : Math.min(min, indentOf(l)), Infinity);
        const dedented = childLines.map(l => l.trim() === "" ? "" : l.slice(Number.isFinite(dedentBy) ? dedentBy : 0));
        items.push({ text: primary, children: dedented.length ? parseBlocks(dedented) : [] });
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paraLines = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() !== "" && !isBlockStart(lines[i]!)) { paraLines.push(lines[i]!); i++; }
    blocks.push({ type: "paragraph", text: paraLines.join(" ").trim() });
  }

  return blocks;
}

export interface MarkdownLinkTarget {
  /** True when the href pointed inside the app (a leading "/"); false for http(s) links, mailto, and bare fragments. */
  internal: boolean;
  href: string;
}

/** GitHub/Starlight-style heading slug: lowercase, spaces to hyphens, punctuation dropped. */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/`([^`]*)`/g, "$1")
    .replace(/[^\p{L}\p{N}\s-]+/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

interface InlineCtx {
  onLink?: (target: MarkdownLinkTarget, event: ReactMouseEvent) => void;
  keyBase: string;
}

/** Finds the `]` that closes a `[` opened at `openAt`, ignoring nested brackets one level deep. */
function findClosingBracket(text: string, openAt: number): number {
  let depth = 0;
  for (let j = openAt; j < text.length; j++) {
    if (text[j] === "[") depth++;
    else if (text[j] === "]") { depth--; if (depth === 0) return j; }
  }
  return -1;
}

function renderLink(label: ReactNode[], href: string, ctx: InlineCtx, key: number): ReactNode {
  // `#anchor` is a same-article jump — still "internal" in the sense that it
  // must never leave the app, even though there is nothing to look up beyond
  // the article already open.
  const internal = href.startsWith("/") || href.startsWith("../") || href.startsWith("./") || href.startsWith("#");
  if (internal) {
    return (
      <a
        key={`${ctx.keyBase}-lnk-${key}`}
        href={href}
        onClick={(event) => { event.preventDefault(); ctx.onLink?.({ internal: true, href }, event); }}
      >
        {label}
      </a>
    );
  }
  return (
    <a key={`${ctx.keyBase}-lnk-${key}`} href={href} target="_blank" rel="noreferrer noopener">
      {label}
      <IconExternal className="m3-md-extlink-icon" width={12} height={12} aria-hidden="true" />
    </a>
  );
}

/** Inline-level parser. Renders straight to React nodes — no intermediate HTML string ever exists. */
function renderInline(text: string, ctx: InlineCtx): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buf = "";
  let key = 0;
  const flush = () => { if (buf) { nodes.push(buf); buf = ""; } };
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        nodes.push(<code key={`${ctx.keyBase}-c-${key++}`}>{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }

    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end !== -1 && end > i + 2) {
        flush();
        nodes.push(<strong key={`${ctx.keyBase}-b-${key++}`}>{renderInline(text.slice(i + 2, end), ctx)}</strong>);
        i = end + 2;
        continue;
      }
    }

    // Single-`*` italics only — see the module header for why `_..._` is not
    // treated as emphasis. Requires non-whitespace immediately inside both
    // marks, which is what CommonMark calls "left/right-flanking" and is
    // enough here to keep a bare `*` in running prose from ever matching.
    if (ch === "*" && text[i + 1] !== "*" && text[i + 1] !== " " && text[i + 1] !== undefined) {
      const end = text.indexOf("*", i + 1);
      if (end !== -1 && text[end - 1] !== " " && text[end - 1] !== "*") {
        flush();
        nodes.push(<em key={`${ctx.keyBase}-i-${key++}`}>{renderInline(text.slice(i + 1, end), ctx)}</em>);
        i = end + 1;
        continue;
      }
    }

    if (ch === "[") {
      const closeBracket = findClosingBracket(text, i);
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          const label = text.slice(i + 1, closeBracket);
          const href = text.slice(closeBracket + 2, closeParen);
          flush();
          nodes.push(renderLink(renderInline(label, ctx), href, ctx, key++));
          i = closeParen + 1;
          continue;
        }
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return nodes;
}

const ASIDE_TITLE_KEY: Record<AsideKind, TKey> = {
  note: "docs.aside.note", tip: "docs.aside.tip", caution: "docs.aside.caution", danger: "docs.aside.danger",
};

function renderBlocks(blocks: Block[], ctx: InlineCtx, t: TFn, path: string): ReactNode[] {
  return blocks.map((block, idx) => {
    const key = `${path}-${idx}`;
    switch (block.type) {
      case "heading": {
        // +1: an article's own title is the page's h1 (rendered by the host,
        // not by this component), so a level-1 Markdown heading inside the body
        // becomes an h2 — the document keeps one real h1 rather than two.
        // `createElement` with a plain string tag rather than a JSX spread onto
        // a variable component name, which needs a capitalized identifier and
        // (depending on the JSX transform's typing) a statically known tag.
        return createElement(
          `h${Math.min(block.level + 1, 6)}`,
          { key, id: slugifyHeading(block.text), className: "m3-md-heading" },
          renderInline(block.text, { ...ctx, keyBase: key }),
        );
      }
      case "paragraph":
        return <p key={key} className="m3-md-p">{renderInline(block.text, { ...ctx, keyBase: key })}</p>;
      case "code":
        return (
          <pre key={key} className="m3-md-pre">
            <code className={block.lang ? `language-${block.lang}` : undefined}>{block.code}</code>
          </pre>
        );
      case "hr":
        return <hr key={key} className="m3-md-hr" />;
      case "quote":
        return <blockquote key={key} className="m3-md-quote">{renderBlocks(block.blocks, ctx, t, key)}</blockquote>;
      case "list": {
        const Tag = block.ordered ? "ol" : "ul";
        return (
          <Tag key={key} className="m3-md-list">
            {block.items.map((item, i2) => (
              <li key={`${key}-${i2}`}>
                {renderInline(item.text, { ...ctx, keyBase: `${key}-${i2}` })}
                {item.children.length > 0 && renderBlocks(item.children, ctx, t, `${key}-${i2}`)}
              </li>
            ))}
          </Tag>
        );
      }
      case "table":
        return (
          <div key={key} className="m3-table-wrap">
            <table className="m3-table m3-md-table">
              <thead>
                <tr>
                  {block.header.map((cell, ci) => (
                    <th key={ci} style={cellStyle(block.align[ci])}>
                      {renderInline(cell, { ...ctx, keyBase: `${key}-h${ci}` })}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci} style={cellStyle(block.align[ci])}>
                        {renderInline(cell, { ...ctx, keyBase: `${key}-${ri}-${ci}` })}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case "aside":
        return (
          <div key={key} className={`m3-md-aside m3-md-aside--${block.kind}`} role="note">
            <p className="m3-md-aside-title">{block.title ?? t(ASIDE_TITLE_KEY[block.kind])}</p>
            {renderBlocks(block.blocks, ctx, t, key)}
          </div>
        );
      default:
        return null;
    }
  });
}

export interface MarkdownProps {
  /** The article body, frontmatter already stripped. */
  text: string;
  /**
   * Fires instead of navigating for a link whose href starts with `/`, `./`
   * or `../` — an in-app documentation link. Absent link handling falls back
   * to an ordinary same-tab navigation, which is only correct for a host that
   * genuinely wants that (nothing in this app does; every caller passes this).
   */
  onInternalLink?: (target: MarkdownLinkTarget, event: ReactMouseEvent) => void;
  /** Disambiguates node keys when more than one Markdown instance is mounted at once. */
  idPrefix?: string;
}

export default function Markdown({ text, onInternalLink, idPrefix = "md" }: MarkdownProps) {
  // The only i18n this component needs: the fallback title on an aside block
  // that did not carry its own `[Title]`. Everything else in an article's body
  // is the article's own text, in whatever language it was written, and stays
  // exactly as written — this renderer's job is formatting, not translation.
  const t = useT();
  const blocks = parseBlocks(text.split(/\r?\n/));
  return (
    <Fragment>
      {renderBlocks(blocks, { onLink: onInternalLink, keyBase: idPrefix }, t, idPrefix)}
    </Fragment>
  );
}
