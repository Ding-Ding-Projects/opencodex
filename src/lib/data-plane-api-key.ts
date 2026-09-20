import type { DataPlaneApiKey, OcxConfig } from "../types";

/**
 * The account's generic (unscoped) data-plane API key, if one is configured.
 *
 * `config.apiKeys` is append-only creation order (src/server/management/oauth-account-routes.ts
 * `POST /api/keys` handler), so `apiKeys[0]` is whichever key happened to be created first,
 * generic or purpose-scoped. A key created with a purpose (currently only
 * "github-copilot-desktop", see DATA_PLANE_API_KEY_PURPOSES in ../types) is an
 * integration-scoped credential for that one caller (issue #10: "Integration-scoped,
 * reveal-once API key with loopback-only admission and no upstream forwarding") and must
 * never be handed to an unrelated local integration as its own generic bearer credential.
 *
 * Fail-closed the same way src/server/auth-cors.ts already treats purpose entries
 * (assertServerAuthConfig, isDataPlaneAdmissionSecret): ANY set purpose, known or
 * unknown, disqualifies the entry from being "generic". This deliberately does not
 * compare against the literal "github-copilot-desktop" string, so a hand-edited or
 * future purpose value stays scoped too. A config holding only purpose-scoped keys
 * therefore behaves exactly like an empty `apiKeys` list to every caller of this helper.
 */
export function selectGenericApiKey(config: OcxConfig): DataPlaneApiKey | undefined {
  return config.apiKeys?.find(entry => entry.purpose === undefined);
}
