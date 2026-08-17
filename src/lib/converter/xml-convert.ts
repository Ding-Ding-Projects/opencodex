/**
 * JSON <-> XML — a bounded, dependency-free adapter.
 *
 * Both directions are pure functions with no filesystem or network access.
 * `structured-service.ts` is the fs-facing layer.
 *
 * ## How this defeats a billion-laughs style entity-expansion attack
 *
 * A billion-laughs document defines a handful of custom general entities via
 * `<!ENTITY ...>` inside a `<!DOCTYPE ...>`, each referencing the previous
 * one several times, so a few hundred bytes of markup expands recursively
 * into gigabytes once every reference is substituted. This parser cannot be
 * made vulnerable to that by a missed limit, because it does not implement
 * the feature at all, on two independent, redundant paths:
 *
 *  1. **Any markup declaration is refused outright.** Every `<!...>` other
 *     than a comment (`<!--`) or a CDATA section (`<![CDATA[`) — which
 *     covers `<!DOCTYPE`, `<!ENTITY`, `<!ELEMENT`, `<!ATTLIST`, `<!NOTATION`
 *     and any conditional section — is refused before it is even inspected.
 *  2. **Only the five predefined XML entities and numeric character
 *     references are decoded** (`decodeXmlText` below). A reference to any
 *     other name is refused. Since custom entities are never recognised at
 *     all, there is nothing for an expansion to substitute even if a
 *     `<!ENTITY>` declaration somehow reached the decoder.
 *
 * Depth and node-count bombs that use no entities at all (a document that is
 * simply millions of `<a>` elements, or a few hundred thousand nested one
 * inside another) are bounded separately by `MAX_XML_NODES` and
 * `MAX_STRUCTURED_DEPTH`, checked as each element opens. The parser itself is
 * iterative — an explicit stack, never recursion — specifically so a
 * pathologically deep document is refused with a clean, catchable boundary
 * result rather than crashing the process with an uncontrolled
 * `RangeError: Maximum call stack size exceeded` before the depth check ever
 * gets a chance to run.
 *
 * ## The lossy disclosure this format always carries
 *
 * XML has attributes, mixed text-and-element content and a fixed document
 * order that JSON has no equivalent for; JSON has a distinction between a
 * single value and a one-element array that XML has no equivalent for. The
 * mapping used here is a deliberate, documented convention (see
 * `nodeToJsonValue` / `jsonToXmlElement` below), not a lossless format
 * translation, and every `jsonToXml` result says so.
 */
import {
  MAX_STRUCTURED_DEPTH,
  MAX_STRUCTURED_INPUT_BYTES,
  MAX_XML_NODES,
} from "./bounds";

// --------------------------------------------------------------------- entities

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' };

function decodeXmlText(raw: string): { ok: true; text: string } | { ok: false; reason: string } {
  if (!raw.includes("&")) return { ok: true, text: raw };
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch !== "&") { out += ch; i++; continue; }
    const semi = raw.indexOf(";", i);
    if (semi === -1 || semi - i > 32) {
      return { ok: false, reason: "an '&' is not part of a valid, bounded entity or character reference" };
    }
    const body = raw.slice(i + 1, semi);
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const digits = isHex ? body.slice(2) : body.slice(1);
      const digitPattern = isHex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/;
      const code = digitPattern.test(digits) ? parseInt(digits, isHex ? 16 : 10) : NaN;
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
        return { ok: false, reason: `invalid numeric character reference "&${body};"` };
      }
      out += String.fromCodePoint(code);
    } else if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) {
      out += NAMED_ENTITIES[body];
    } else {
      return {
        ok: false,
        reason: `custom entity "&${body};" is not supported — only the five predefined XML entities and numeric character references are ever decoded, which is what keeps a billion-laughs style entity expansion impossible here rather than merely rate-limited`,
      };
    }
    i = semi + 1;
  }
  return { ok: true, text: out };
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

// --------------------------------------------------------------------- parsing

const TAG_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;

interface XmlElement {
  tag: string;
  attributes: Record<string, string>;
  children: XmlNode[];
}
type XmlNode = XmlElement | { text: string };

export type XmlParseBoundary = "too-large" | "malformed" | "unsupported" | "bomb-suspected";

export type XmlToJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; boundary: XmlParseBoundary; reason: string };

/**
 * Parse an attribute list starting just after the tag name. Returns the
 * attributes, whether the tag is self-closing, and the index just past the
 * closing `>`. Scans for the first unquoted `>` — per the XML grammar an
 * unescaped `<` may never appear inside an attribute value, so no quote can
 * ever hide the tag's real end from a naive scan for `<`, but a literal `>`
 * legitimately can appear unescaped inside a quoted value, which is why this
 * scan explicitly tracks quote state rather than using `indexOf(">")` alone.
 */
function parseTag(text: string, start: number): { ok: true; end: number; selfClosing: boolean; attributes: Record<string, string> } | { ok: false; reason: string } {
  let i = start;
  let quote: '"' | "'" | null = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
    if (ch === ">") break;
    i++;
  }
  if (i >= text.length) return { ok: false, reason: "an opening tag is never closed" };
  let body = text.slice(start, i);
  let selfClosing = false;
  if (body.trimEnd().endsWith("/")) { selfClosing = true; body = body.slice(0, body.lastIndexOf("/")); }

  const attributes: Record<string, string> = {};
  const attrPattern = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  let residue = body;
  while ((match = attrPattern.exec(body))) {
    const rawValue = match[3] !== undefined ? match[3] : match[4];
    const decoded = decodeXmlText(rawValue ?? "");
    if (!decoded.ok) return { ok: false, reason: decoded.reason };
    attributes[match[1]] = decoded.text;
    residue = residue.replace(match[0], "");
  }
  if (residue.trim().length > 0) return { ok: false, reason: `an attribute could not be parsed near "${residue.trim().slice(0, 40)}"` };
  return { ok: true, end: i + 1, selfClosing, attributes };
}

/**
 * Parse a bounded XML document into a small internal tree.
 *
 * Iterative by construction (an explicit `stack`, never recursion) so a
 * pathologically deep document is refused as a clean boundary result rather
 * than crashing the process on a call-stack overflow.
 */
function parseXmlDocument(text: string): { ok: true; root: XmlElement } | { ok: false; boundary: XmlParseBoundary; reason: string } {
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let nodeCount = 0;
  let i = 0;
  const n = text.length;

  function appendText(raw: string): { ok: true } | { ok: false; reason: string } {
    if (stack.length === 0) return { ok: true }; // ignore text outside the root element (whitespace, prolog gaps)
    const decoded = decodeXmlText(raw);
    if (!decoded.ok) return decoded;
    if (decoded.text.length > 0) stack[stack.length - 1].children.push({ text: decoded.text });
    return { ok: true };
  }

  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt === -1) {
      const tail = appendText(text.slice(i));
      if (!tail.ok) return { ok: false, boundary: "malformed", reason: tail.reason };
      break;
    }
    if (lt > i) {
      const gap = appendText(text.slice(i, lt));
      if (!gap.ok) return { ok: false, boundary: "malformed", reason: gap.reason };
    }

    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end === -1) return { ok: false, boundary: "malformed", reason: "an XML comment is never closed" };
      i = end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      if (end === -1) return { ok: false, boundary: "malformed", reason: "a CDATA section is never closed" };
      if (stack.length > 0) stack[stack.length - 1].children.push({ text: text.slice(lt + 9, end) });
      i = end + 3;
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt + 2);
      if (end === -1) return { ok: false, boundary: "malformed", reason: "a processing instruction is never closed" };
      i = end + 2;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      // Any markup declaration — DOCTYPE, ENTITY, ELEMENT, ATTLIST, NOTATION,
      // a conditional section — is refused outright rather than parsed. This
      // is the primary defense against a billion-laughs style attack; see
      // this module's header.
      return {
        ok: false,
        boundary: "unsupported",
        reason: "markup declarations such as <!DOCTYPE ...> or <!ENTITY ...> are not supported — refusing them outright is what keeps entity-expansion attacks impossible here",
      };
    }
    if (text.startsWith("</", lt)) {
      const end = text.indexOf(">", lt + 2);
      if (end === -1) return { ok: false, boundary: "malformed", reason: "a closing tag is never closed" };
      const name = text.slice(lt + 2, end).trim();
      const top = stack.pop();
      if (!top || top.tag !== name) {
        return { ok: false, boundary: "malformed", reason: `closing tag "</${name}>" does not match the currently open element` };
      }
      if (stack.length === 0) root = top;
      i = end + 1;
      continue;
    }

    // An opening (or self-closing) tag.
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(text[j])) j++;
    const tag = text.slice(lt + 1, j);
    if (!TAG_NAME_PATTERN.test(tag)) {
      return { ok: false, boundary: "malformed", reason: `"${tag}" is not a supported element name` };
    }
    const parsedTag = parseTag(text, j);
    if (!parsedTag.ok) return { ok: false, boundary: "malformed", reason: parsedTag.reason };

    nodeCount++;
    if (nodeCount > MAX_XML_NODES) {
      return { ok: false, boundary: "bomb-suspected", reason: `the document contains more than ${MAX_XML_NODES} elements` };
    }
    if (stack.length + 1 > MAX_STRUCTURED_DEPTH) {
      return { ok: false, boundary: "bomb-suspected", reason: `the document nests more than ${MAX_STRUCTURED_DEPTH} elements deep` };
    }
    if (root !== null && stack.length === 0) {
      return { ok: false, boundary: "malformed", reason: "a document may have only one root element" };
    }

    const element: XmlElement = { tag, attributes: parsedTag.attributes, children: [] };
    if (parsedTag.selfClosing) {
      if (stack.length === 0) root = element;
      else stack[stack.length - 1].children.push(element);
    } else {
      if (stack.length > 0) stack[stack.length - 1].children.push(element);
      stack.push(element);
    }
    i = parsedTag.end;
  }

  if (stack.length > 0) return { ok: false, boundary: "malformed", reason: `element "<${stack[stack.length - 1].tag}>" is never closed` };
  if (!root) return { ok: false, boundary: "malformed", reason: "the document has no root element" };
  return { ok: true, root };
}

/**
 * The read-side convention: a leaf with no attributes and no children
 * becomes a plain string. Anything with attributes, text and/or children
 * becomes an object; attributes live under `"@attributes"`, direct text
 * under `"@text"`, and each distinct child tag becomes a key — a single
 * occurrence stays a bare value, more than one becomes an array. Repeated
 * whitespace-only text between elements is discarded, and leaf text is
 * trimmed; neither insignificant whitespace nor XML's fixed element order
 * across differently-named siblings survives this mapping.
 */
function nodeToJsonValue(node: XmlElement): unknown {
  const childElements = node.children.filter((c): c is XmlElement => "tag" in c);
  const text = node.children.filter((c): c is { text: string } => "text" in c).map(c => c.text).join("").trim();
  const hasAttrs = Object.keys(node.attributes).length > 0;

  if (!hasAttrs && childElements.length === 0) return text;

  const grouped = new Map<string, unknown[]>();
  for (const child of childElements) {
    const value = nodeToJsonValue(child);
    const bucket = grouped.get(child.tag);
    if (bucket) bucket.push(value); else grouped.set(child.tag, [value]);
  }
  const obj: Record<string, unknown> = {};
  if (hasAttrs) obj["@attributes"] = { ...node.attributes };
  if (text.length > 0) obj["@text"] = text;
  for (const [tag, values] of grouped) obj[tag] = values.length === 1 ? values[0] : values;
  return obj;
}

export function xmlToJson(text: string): XmlToJsonResult {
  if (text.length > MAX_STRUCTURED_INPUT_BYTES) {
    return { ok: false, boundary: "too-large", reason: `the input is ${text.length} characters, over the ${MAX_STRUCTURED_INPUT_BYTES} character limit` };
  }
  const parsed = parseXmlDocument(text);
  if (!parsed.ok) return parsed;
  return { ok: true, value: { [parsed.root.tag]: nodeToJsonValue(parsed.root) } };
}

// --------------------------------------------------------------------- serializing

export type JsonToXmlResult =
  | { ok: true; text: string; lossy: true; notes: string[] }
  | { ok: false; reason: string };

/**
 * The write-side convention, deliberately simpler than what the read side
 * accepts: no attributes are ever emitted, and a JSON object never mixes
 * direct text with child elements. A JSON primitive becomes an element's
 * text content; `null`/`undefined` become an empty element; an object's
 * properties become child elements (a property whose value is an array
 * becomes that many same-named sibling elements); a top-level array is
 * wrapped in `rootTag` with each entry becoming an `<item>` child.
 */
function serializeValue(tag: string, value: unknown, depth: number): { ok: true; xml: string } | { ok: false; reason: string } {
  if (depth > MAX_STRUCTURED_DEPTH) {
    return { ok: false, reason: `the value nests more than ${MAX_STRUCTURED_DEPTH} levels deep` };
  }
  if (!TAG_NAME_PATTERN.test(tag)) {
    return { ok: false, reason: `"${tag}" is not a name that can become an XML element` };
  }
  if (value === null || value === undefined) return { ok: true, xml: `<${tag}/>` };
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { ok: true, xml: `<${tag}>${escapeXmlText(String(value))}</${tag}>` };
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const serialized = serializeValue(tag, item, depth + 1);
      if (!serialized.ok) return serialized;
      parts.push(serialized.xml);
    }
    return { ok: true, xml: parts.join("") };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const parts: string[] = [];
    for (const [key, entryValue] of entries) {
      const serialized = serializeValue(key, entryValue, depth + 1);
      if (!serialized.ok) return serialized;
      parts.push(serialized.xml);
    }
    return { ok: true, xml: `<${tag}>${parts.join("")}</${tag}>` };
  }
  return { ok: false, reason: `a ${typeof value} value cannot become XML content` };
}

export function jsonToXml(value: unknown, rootTag = "root"): JsonToXmlResult {
  const notes = [
    "attributes are never emitted, and every scalar becomes plain element text — reading this XML back never reproduces the original JSON types",
  ];
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const serialized = serializeValue("item", item, 1);
      if (!serialized.ok) return { ok: false, reason: serialized.reason };
      parts.push(serialized.xml);
    }
    if (!TAG_NAME_PATTERN.test(rootTag)) return { ok: false, reason: `"${rootTag}" is not a name that can become an XML element` };
    notes.push('the top-level array became a wrapper element with each entry as a same-named "<item>" child — the property name a caller might have used is not recoverable');
    return { ok: true, text: `<${rootTag}>${parts.join("")}</${rootTag}>`, lossy: true, notes };
  }
  const serialized = serializeValue(rootTag, value, 0);
  if (!serialized.ok) return { ok: false, reason: serialized.reason };
  return { ok: true, text: serialized.xml, lossy: true, notes };
}
