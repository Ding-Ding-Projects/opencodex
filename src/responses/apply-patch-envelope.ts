// Repair only the outer delimiters of a complete apply_patch payload.
// Executable custom-tool inputs are left byte-identical: this module is not a
// general source rewriter and must never turn arbitrary text into a patch.

const PATCH_BEGIN = "*** Begin Patch";
const PATCH_END = "*** End Patch";
const TOP_LEVEL_PATCH_ENVELOPE = /^(\*\*\* Begin Patch(?: \*\*\*)?)(\r?\n)([\s\S]*)(\r?\n)(\*\*\* End Patch(?: \*\*\*)?)(\r?\n)?$/;
const PATCH_OPERATION_LINE = /^\*\*\* (?:Add|Update|Delete) File: .+$/m;

/** Unwrap the {input:string} function-call wrapper used for freeform tools. */
export function unwrapFreeformToolInput(argumentsText: unknown): string {
  if (typeof argumentsText !== "string") return "";
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const input = (parsed as { input?: unknown }).input;
      if (typeof input === "string") return input;
    }
  } catch {
    // The string is the freeform body, not nested JSON.
  }
  return argumentsText;
}

/** Strip trailing `***` only from the outer lines of one complete patch. */
export function normalizeApplyPatchDelimiters(text: string): string {
  const match = TOP_LEVEL_PATCH_ENVELOPE.exec(text);
  if (!match) return text;
  const [, begin, beginBreak, body, endBreak, end, trailingBreak = ""] = match;
  if (!PATCH_OPERATION_LINE.test(body)) return text;
  if (begin === PATCH_BEGIN && end === PATCH_END) return text;
  return `${PATCH_BEGIN}${beginBreak}${body}${endBreak}${PATCH_END}${trailingBreak}`;
}

/** Apply delimiter repair only to the named freeform apply_patch tool. */
export function repairFreeformToolInput(argumentsText: unknown, toolName = ""): string {
  const unwrapped = unwrapFreeformToolInput(argumentsText);
  return toolName === "apply_patch" ? normalizeApplyPatchDelimiters(unwrapped) : unwrapped;
}
