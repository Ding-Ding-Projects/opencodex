export interface RegexSearchState {
  enabled: boolean;
  pattern: string;
  flags: string;
}

const MAX_PATTERN_LENGTH = 512;
const ALLOWED_FLAGS = "gimsuy";
export const REGEX_GLOBAL_FLAG = ALLOWED_FLAGS[0] ?? "";

export function compileBoundedRegex(state: RegexSearchState): RegExp | null {
  if (!state.enabled || !state.pattern || state.pattern.length > MAX_PATTERN_LENGTH) return null;
  if ([...state.flags].some(flag => !ALLOWED_FLAGS.includes(flag))) return null;
  try {
    return new RegExp(state.pattern, state.flags.replace(/g/g, ""));
  } catch {
    return null;
  }
}
