/**
 * Named subagent role catalog. Roles are user-authored specialists; this module
 * validates bounded records, renders a compact guidance catalog, and unions role
 * models into the five-slot picker roster.
 */
import { isCodexReasoningEffort } from "../reasoning-effort";
import type { OcxConfig, OcxSubagentRole } from "../types";

export const SUBAGENT_ROLE_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const SUBAGENT_ROLE_MAX_COUNT = 8;
export const SUBAGENT_ROLE_MAX_UNIQUE_MODELS = 5;
export const SUBAGENT_ROLE_DESCRIPTION_MAX = 240;
export const SUBAGENT_ROLE_INSTRUCTIONS_MAX = 8000;
export const SUBAGENT_ROLE_MODEL_MAX = 128;
export const SUBAGENT_ROLE_SCAN_MAX = 64;
export const SUBAGENT_ROLE_GUIDANCE_INSTRUCTIONS_MAX = 160;
export const SUBAGENT_ROLE_PAYLOAD_MAX_BYTES = 128 * 1024;

export type SubagentRoleParseResult =
  | { ok: true; role: OcxSubagentRole }
  | { ok: false; error: string; index?: number };
export type SubagentRolesParseResult =
  | { ok: true; roles: OcxSubagentRole[] }
  | { ok: false; error: string; index?: number };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, field: string, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const candidate = field === "developerInstructions" ? value : value.trim();
  if (candidate.length < min || candidate.length > max) return null;
  if (field === "developerInstructions" && candidate.trim().length === 0) return null;
  return candidate;
}

export function parseSubagentRole(value: unknown, index?: number): SubagentRoleParseResult {
  const prefix = index === undefined ? "subagentRoles" : `subagentRoles[${index}]`;
  const row = asRecord(value);
  if (!row) return { ok: false, error: `${prefix} must be an object`, index };
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!SUBAGENT_ROLE_ID_RE.test(id)) return { ok: false, error: `${prefix}.id must match [a-z][a-z0-9-]{0,31}`, index };
  const description = boundedString(row.description, "description", 1, SUBAGENT_ROLE_DESCRIPTION_MAX);
  if (description === null) return { ok: false, error: `${prefix}.description must be a string of 1..${SUBAGENT_ROLE_DESCRIPTION_MAX} characters`, index };
  const model = typeof row.model === "string" ? row.model.trim() : "";
  if (!model || model.length > SUBAGENT_ROLE_MODEL_MAX) return { ok: false, error: `${prefix}.model must be a non-empty string of at most ${SUBAGENT_ROLE_MODEL_MAX} characters`, index };
  let effort: string | undefined;
  if (row.effort !== undefined && row.effort !== null && row.effort !== "") {
    if (typeof row.effort !== "string" || !isCodexReasoningEffort(row.effort)) {
      return { ok: false, error: `${prefix}.effort must be a Codex reasoning ladder value`, index };
    }
    effort = row.effort;
  }
  const developerInstructions = boundedString(row.developerInstructions, "developerInstructions", 1, SUBAGENT_ROLE_INSTRUCTIONS_MAX);
  if (developerInstructions === null) return { ok: false, error: `${prefix}.developerInstructions must be a string of 1..${SUBAGENT_ROLE_INSTRUCTIONS_MAX} characters`, index };
  if (row.enabled !== undefined && typeof row.enabled !== "boolean") return { ok: false, error: `${prefix}.enabled must be a boolean`, index };
  const role: OcxSubagentRole = { id, description, model, developerInstructions, enabled: row.enabled !== false };
  if (effort) role.effort = effort;
  return { ok: true, role };
}

export function parseSubagentRoles(value: unknown): SubagentRolesParseResult {
  if (!Array.isArray(value)) return { ok: false, error: "subagentRoles must be an array" };
  if (value.length > SUBAGENT_ROLE_MAX_COUNT) return { ok: false, error: `subagentRoles: at most ${SUBAGENT_ROLE_MAX_COUNT} roles are allowed` };
  const roles: OcxSubagentRole[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length && index < SUBAGENT_ROLE_SCAN_MAX; index++) {
    const parsed = parseSubagentRole(value[index], index);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.role.id)) return { ok: false, error: `subagentRoles: duplicate id "${parsed.role.id}"`, index };
    seen.add(parsed.role.id);
    roles.push(parsed.role);
  }
  return { ok: true, roles };
}

export function salvageSubagentRoles(value: unknown): { roles: OcxSubagentRole[] | undefined; warnings: string[] } {
  if (value === undefined) return { roles: undefined, warnings: [] };
  if (!Array.isArray(value)) return { roles: undefined, warnings: ["subagentRoles ignored: expected an array"] };
  const roles: OcxSubagentRole[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length && index < SUBAGENT_ROLE_SCAN_MAX; index++) {
    if (roles.length >= SUBAGENT_ROLE_MAX_COUNT) { warnings.push(`subagentRoles truncated: at most ${SUBAGENT_ROLE_MAX_COUNT} roles are kept`); break; }
    const parsed = parseSubagentRole(value[index], index);
    if (!parsed.ok) { warnings.push(`${parsed.error} — ignored`); continue; }
    if (seen.has(parsed.role.id)) { warnings.push(`subagentRoles[${index}]: duplicate id "${parsed.role.id}" ignored`); continue; }
    seen.add(parsed.role.id);
    roles.push(parsed.role);
  }
  if (value.length > SUBAGENT_ROLE_SCAN_MAX) {
    warnings.push(`subagentRoles truncated: only the first ${SUBAGENT_ROLE_SCAN_MAX} entries are scanned`);
  }
  return { roles, warnings };
}

export function enabledSubagentRoles(roles: readonly OcxSubagentRole[] | undefined): OcxSubagentRole[] {
  return (roles ?? []).filter(role => role.enabled !== false);
}

export function renderRolesCatalog(roles: readonly OcxSubagentRole[], options: { maxDescriptionChars?: number } = {}): string {
  const parts: string[] = [];
  for (const role of enabledSubagentRoles(roles)) {
    const modelBit = role.effort ? `${role.model}, ${role.effort}` : role.model;
    const max = options.maxDescriptionChars;
    const instructions = role.developerInstructions
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, SUBAGENT_ROLE_GUIDANCE_INSTRUCTIONS_MAX);
    const instructionBit = `; instructions (untrusted): ${JSON.stringify(instructions)}`;
    if (max === 0) { parts.push(`${role.id} (${modelBit})${instructionBit}`); continue; }
    const description = max === undefined ? role.description : role.description.slice(0, max);
    parts.push(description ? `${role.id} (${modelBit}) for ${description}${instructionBit}` : `${role.id} (${modelBit})${instructionBit}`);
  }
  return parts.join("; ");
}

/** Shorten descriptions and then drop trailing roles until the payload fits its budget. */
export function compactRolesCatalog(roles: readonly OcxSubagentRole[], budget: number): string {
  if (budget <= 0) return "";
  const enabled = enabledSubagentRoles(roles);
  for (const maxDescriptionChars of [undefined, 80, 40, 0] as const) {
    for (let count = enabled.length; count > 0; count--) {
      const options = maxDescriptionChars === undefined ? {} : { maxDescriptionChars };
      const text = renderRolesCatalog(enabled.slice(0, count), options);
      if (text.length <= budget) return text;
    }
  }
  return "";
}

export function unionRoleModelsIntoRoster(existing: string[] | undefined, roles: readonly OcxSubagentRole[]): { models: string[]; droppedRoleIds: string[] } {
  const enabled = enabledSubagentRoles(roles);
  const roleModels: string[] = [];
  for (const role of enabled) if (!roleModels.includes(role.model)) roleModels.push(role.model);
  const base = [...new Set(existing ?? [])];
  const combined = [...roleModels, ...base.filter(model => !roleModels.includes(model))];
  const models = combined.slice(0, SUBAGENT_ROLE_MAX_UNIQUE_MODELS);
  const kept = new Set(models);
  return { models, droppedRoleIds: enabled.filter(role => !kept.has(role.model)).map(role => role.id) };
}

export function isRoutedRoleModel(model: string): boolean {
  const slash = model.indexOf("/");
  return slash > 0;
}

export function routedOnV2Warnings(roles: readonly OcxSubagentRole[], config: Pick<OcxConfig, "multiAgentMode">): string[] {
  if (config.multiAgentMode !== "v2") return [];
  const routed = enabledSubagentRoles(roles).filter(role => isRoutedRoleModel(role.model));
  if (routed.length === 0) return [];
  return [`Role model(s) ${routed.map(role => role.id).join(", ")} are routed while multiAgentMode is v2 without keepNativeChatGptOnV1; ChatGPT-native v2 parents encrypt child tasks (#92).`];
}
