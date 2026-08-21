import {
  isAllowedToolChoice,
  namespacedToolName,
  toolAllowedByChoice,
  toolChoiceAliases,
  type OcxRequestOptions,
  type OcxTool,
  type OcxProviderConfig,
  type OcxMessage,
} from "../types";

/** Collect developer/system text plus the latest user turn for provider-local guidance. */
export function effectiveInstructionText(messages: readonly OcxMessage[] | undefined, system?: readonly string[]): string[] {
  const out = [...(system ?? [])];
  let latestUserText: string[] = [];
  for (const message of messages ?? []) {
    if (message.role !== "developer" && message.role !== "user") continue;
    const text = typeof message.content === "string"
      ? [message.content]
      : message.content.filter(part => part.type === "text").map(part => part.text);
    if (message.role === "developer") out.push(...text);
    else latestUserText = text;
  }
  return [...out, ...latestUserText];
}

export function shouldSuppressCodeModePatchGuidance(instructions: string): boolean {
  return /<collaboration_mode>\s*#?\s*Collaboration Mode:\s*Plan\b|You are in \*\*Plan Mode\*\*|\b(?:do not|must not|never)\s+(?:make|perform)\s+(?:any\s+)?mutations?\b|\b(?:do not|must not|never)\s+(?:edit|modify|use\s+apply_patch)\b|\b(?:do not|must not|never)\s+write\s+(?:to\s+)?(?:any\s+)?(?:files?|code|the\s+workspace)\b|\buse\s+(?:the\s+)?shell\s+for\s+(?:file\s+)?edits\b/i.test(instructions);
}

/** Extract only the balanced tools object from a code-mode tool description. */
export function declaredToolsBlock(description: string): string | undefined {
  const declaration = /(?:declare\s+)?const\s+tools\s*:\s*\{/i.exec(description);
  if (!declaration) return undefined;
  const open = declaration.index + declaration[0].lastIndexOf("{");
  let depth = 0;
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  for (let index = open; index < description.length; index += 1) {
    const character = description[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") { quote = character; continue; }
    if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return description.slice(open + 1, index);
  }
  return undefined;
}

const NEIGHBOR_AGENT_TOOL_NAMES = ["Read", "Grep", "Glob", "Bash", "LS", "apply_patch"] as const;

function quoteNames(names: readonly string[]): string {
  return names.map(name => `\`${name}\``).join(", ");
}

function uniqueNames(names: readonly string[]): string[] {
  return [...new Set(names.filter(name => name.trim().length > 0))];
}

function toolChoiceAllows(tool: Pick<OcxTool, "namespace" | "name">, toolChoice: OcxRequestOptions["toolChoice"] | undefined): boolean {
  if (!toolChoice || toolChoice === "auto" || toolChoice === "required") return true;
  if (toolChoice === "none") return false;
  if (isAllowedToolChoice(toolChoice)) return toolAllowedByChoice(tool, new Set(toolChoice.allowedTools));
  return toolChoiceAliases(tool).includes(toolChoice.name);
}

function isOpenAIOrChatGPTHost(hostname: string): boolean {
  return hostname === "openai.com"
    || hostname.endsWith(".openai.com")
    || hostname === "chatgpt.com"
    || hostname.endsWith(".chatgpt.com");
}

export function shouldInjectNonOpenAIToolCatalogNudge(provider: Pick<OcxProviderConfig, "baseUrl">): boolean {
  try {
    return !isOpenAIOrChatGPTHost(new URL(provider.baseUrl).hostname);
  } catch {
    return true;
  }
}

export function buildNonOpenAIToolCatalogNudgeFromNames(wireNames: readonly string[] | undefined): string | undefined {
  const names = uniqueNames(wireNames ?? []);
  if (names.length === 0) return undefined;

  const advertised = new Set(names);
  const unavailableNeighborNames = NEIGHBOR_AGENT_TOOL_NAMES.filter(name => !advertised.has(name));

  return [
    "Tool contract: use the current tool catalog as ground truth.",
    `Valid tool names for this turn are exactly ${quoteNames(names)}.`,
    "Call only listed names with their listed argument keys; do not invent, translate, or rename tools.",
    unavailableNeighborNames.length > 0
      ? `Do not use neighboring-agent tool names ${quoteNames(unavailableNeighborNames)} unless this turn's catalog lists those exact names.`
      : undefined,
    "If you need shell, file search, file read, edit, or discovery behavior, choose the listed tool that provides that capability.",
    "Count a tool call only after its tool result returns; batch independent read-only calls when the runtime supports it.",
  ].filter((line): line is string => typeof line === "string").join(" ");
}

export function buildNonOpenAIToolCatalogNudgeForTools(
  tools: readonly Pick<OcxTool, "namespace" | "name">[] | undefined,
  toolChoice?: OcxRequestOptions["toolChoice"],
  toWireName: (tool: Pick<OcxTool, "namespace" | "name">) => string = tool => namespacedToolName(tool.namespace, tool.name),
): string | undefined {
  const visibleNames = tools
    ?.filter(tool => toolChoiceAllows(tool, toolChoice))
    .map(toWireName);
  return buildNonOpenAIToolCatalogNudgeFromNames(visibleNames);
}
