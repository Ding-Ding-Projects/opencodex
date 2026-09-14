"use strict";

const path = require("node:path");
const {
  clean,
  isPlaceholderOnlyValue,
  hasSubstantialStructuredContent,
} = require(path.join(__dirname, "issue-quality.cjs"));

const MIN_SECTION_LEN = 40;
const MIN_RICH_SECTIONS = 2;
const UNSTRUCTURED_MIN_LEN = 120;
const UNSTRUCTURED_MIN_BLOCKS = 2;

/**
 * Exact instruction / checklist lines from `.github/PULL_REQUEST_TEMPLATE.md`.
 * Untouched templates must not count as substance.
 */
const PR_TEMPLATE_BOILERPLATE_LINES = new Set([
  "explain the user-visible or maintainer-facing change.",
  "list the commands or checks you ran.",
  "scope stays focused and avoids unrelated cleanup.",
  "docs or release notes were updated when needed.",
  "security-sensitive changes were reviewed for secrets, auth, and unsafe defaults.",
]);

/**
 * True when the body uses literal backslash-n as the dominant line break
 * (agent bug seen on #644) rather than real newlines.
 */
function hasEscapedNewlines(text) {
  const escaped = (text.match(/\\n/g) || []).length;
  if (escaped < 2) return false;
  const real = (text.match(/\n/g) || []).length;
  return escaped > real;
}

function countContentBlocks(text) {
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length >= 2) return blocks.length;
  const bullets = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*+]\s+\S/.test(l));
  return Math.max(blocks.length, bullets.length);
}

function normalizeTemplateLine(line) {
  return line
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\[[ xX]\]\s+/, "")
    .replace(/^\s*#{1,6}\s+/, "")
    .trim()
    .toLowerCase();
}

/** Drop stock PR template headings, instructions, and checklist lines. */
function stripPrTemplateBoilerplate(text) {
  return text
    .split("\n")
    .filter((line) => {
      const normalized = normalizeTemplateLine(line);
      if (!normalized) return true;
      if (PR_TEMPLATE_BOILERPLATE_LINES.has(normalized)) return false;
      if (/^(summary|verification|checklist)$/.test(normalized)) return false;
      return true;
    })
    .join("\n");
}

function assessPrDescription(body) {
  if (typeof body !== "string" || !body.trim()) {
    return { ok: false, reason: "empty" };
  }
  if (hasEscapedNewlines(body)) {
    return { ok: false, reason: "escaped_newlines" };
  }
  const withoutTemplate = stripPrTemplateBoilerplate(body);
  const cleaned = clean(withoutTemplate);
  if (!cleaned) {
    const strippedComments = withoutTemplate.replace(/<!--[\s\S]*?-->/g, "").trim();
    if (!strippedComments) return { ok: false, reason: "empty" };
    if (isPlaceholderOnlyValue(strippedComments)) {
      return { ok: false, reason: "placeholder" };
    }
    return { ok: false, reason: "empty" };
  }
  if (isPlaceholderOnlyValue(cleaned)) {
    return { ok: false, reason: "placeholder" };
  }
  if (hasSubstantialStructuredContent(cleaned, MIN_SECTION_LEN, MIN_RICH_SECTIONS)) {
    return { ok: true };
  }
  if (
    cleaned.length >= UNSTRUCTURED_MIN_LEN &&
    countContentBlocks(cleaned) >= UNSTRUCTURED_MIN_BLOCKS
  ) {
    return { ok: true };
  }
  return { ok: false, reason: "thin" };
}

function collectPrQualityFailures({ baseRef, allowedBases, body }) {
  const failures = [];
  const wrongBase = !allowedBases.includes(baseRef);
  if (wrongBase) {
    failures.push({ code: "wrong_base" });
  }

  const desc = assessPrDescription(body);
  if (!desc.ok) {
    failures.push({ code: "bad_description", reason: desc.reason });
  }
  return failures;
}

module.exports = {
  assessPrDescription,
  collectPrQualityFailures,
  hasEscapedNewlines,
  stripPrTemplateBoilerplate,
};
