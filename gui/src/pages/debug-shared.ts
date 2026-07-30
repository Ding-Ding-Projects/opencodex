import type { CSSProperties } from "react";

/**
 * Pill tablist chrome shared by the Logs/Debug section tabs and the debug
 * stream switcher, mirroring the LOGS section of the M3 prototype (4px inset,
 * fully rounded track on `--m3-surface-container`).
 */
export const M3_TABLIST_STYLE: CSSProperties = {
  display: "flex",
  gap: 6,
  padding: 4,
  borderRadius: 999,
  background: "var(--m3-surface-container)",
  width: "fit-content",
  flexWrap: "wrap",
  rowGap: 4,
};

/** 44px-tall pill so every tab clears the minimum hit target. */
export function m3TabStyle(selected: boolean): CSSProperties {
  return {
    minHeight: 44,
    padding: "0 20px",
    border: "none",
    borderRadius: 999,
    background: selected ? "var(--m3-secondary-container)" : "transparent",
    color: selected ? "var(--m3-on-secondary-container)" : "var(--m3-on-surface-variant)",
    font: "inherit",
    fontWeight: selected ? 500 : 400,
    cursor: "pointer",
  };
}

export interface DebugSettings {
  enabled: boolean;
  usage: boolean;
  injection: boolean;
  claude: boolean;
  runtimeOverride: Partial<Record<"debug" | "usage" | "injection" | "claude", boolean>>;
  env: Record<"debug" | "usage" | "injection" | "claude", boolean>;
}

export interface DebugLogEntry {
  seq: number;
  at: number;
  line: string;
}

export interface ClaudeInboundEntry {
  id: number;
  at: number;
  endpoint: string;
  model: string;
  resolvedModel?: string;
  stream?: boolean;
  maxTokens?: number;
  thinkingType?: string;
  thinkingBudgetTokens?: number;
  outputConfigEffort?: string;
  metadataKeys?: string[];
  hasMetadataUserId: boolean;
  hasSystem: boolean;
  anthropicBeta?: string;
  userIdTag?: string;
  systemTag?: string;
}

export type LogStream = "provider" | "usage" | "injection";

export const DEBUG_STREAMS = ["provider", "usage", "injection"] as const;

export function formatLogTime(at: number): string {
  return at > 0 ? `[${new Date(at).toLocaleTimeString()}] ` : "";
}

export function formatClaudeInboundTime(at: number): string {
  return new Date(at).toLocaleTimeString();
}

export function isStreamEnabled(debug: DebugSettings | null, stream: LogStream): boolean {
  return stream === "provider" ? !!debug?.enabled : stream === "usage" ? !!debug?.usage : !!debug?.injection;
}

export function isDebugFlagEnabled(debug: DebugSettings, flag: keyof DebugSettings["env"]): boolean {
  return flag === "debug" ? debug.enabled : flag === "usage" ? debug.usage : flag === "injection" ? debug.injection : debug.claude;
}
