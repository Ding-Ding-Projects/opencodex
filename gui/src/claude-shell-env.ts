import { fixedContextEnv } from "../../src/claude/context-env";

const MANAGED_PREFIX = "OPENCODEX_MANAGED_";

export function fixedContextShellLines(maxContextTokens: number | null): string[] {
  return Object.entries(fixedContextEnv(maxContextTokens)).map(([name, value]) => {
    const marker = `${MANAGED_PREFIX}${name}`;
    return `{ [ -z "\${${name}+x}" ] || [ "\${${marker}:-}" = "\${${name}}" ]; } && { export ${name}=${value}; export ${marker}=${value}; }`;
  });
}

export function automaticContextResetShellLines(maxContextTokens: number | null): string[] {
  if (maxContextTokens !== null) return [];
  return ["CLAUDE_CODE_MAX_CONTEXT_TOKENS", "DISABLE_COMPACT"].map(name => {
    const marker = `${MANAGED_PREFIX}${name}`;
    return `[ -n "\${${marker}:-}" ] && [ "\${${name}:-}" = "\${${marker}}" ] && unset ${name}; unset ${marker}`;
  });
}
