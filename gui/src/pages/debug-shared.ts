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

/**
 * The Capture card's four switches, in the order the card renders them.
 *
 * One list rather than the two that used to exist — a literal tuple inside the
 * panel's `.map` and the same union written out again in the page's mutation
 * signature. The settings search is now a third reader of it, and a flag that
 * the grid renders but the search never indexes is precisely the defect the
 * search exists to remove: the user types the switch's name and is told this
 * screen has no such setting. Adding a fifth capture flag should be one edit.
 */
export const DEBUG_FLAGS = ["debug", "usage", "injection", "claude"] as const;

export type DebugFlag = (typeof DEBUG_FLAGS)[number];

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
