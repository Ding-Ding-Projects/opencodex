/**
 * B3 security port #4 (upstream 1e816ee8, #1296): local NTFS/ACL hardening failures must
 * classify as 503 server_error, not 401 authentication_error.
 *
 * This fork's active delivery scope is Windows-only. When the local `icacls`-based ACL
 * hardening step on a secret/credential path fails or times out, its error text ordinarily
 * contains words like "access denied" or "authentication" (because it is hardening a
 * credential file's permissions) — which is exactly the vocabulary
 * `isAuthenticationMessage` and `isPermissionMessage` key off of. Before this port, such a
 * message was misclassified as a provider auth failure, and the user was told to
 * re-authenticate for a local filesystem/ACL problem that no credential can fix.
 */
import { describe, expect, test } from "bun:test";
import { adapterFailureFromMessage, inferHttpStatusFromAdapterMessage } from "../src/lib/errors";

describe("Windows ACL hardening error classification", () => {
  test("maps local ACL hardening failures to 503 server errors, not 401", () => {
    const messages = [
      "icacls /grant:r timed out while applying authentication permissions",
      "ACL hardening failed: access denied",
      "NTFS permission setup failed during authentication",
      "Secret path hardening failed: access denied",
      "Windows secret ACL update failed: authentication error",
      "/inheritance:r failed: access denied",
      "/grant:r failed while applying authentication permissions",
    ];

    for (const message of messages) {
      expect(inferHttpStatusFromAdapterMessage(message)).toBe(503);
      expect(adapterFailureFromMessage(message)).toMatchObject({
        httpStatus: 503,
        error: { type: "server_error" },
      });
    }
  });

  test("keeps genuine credential failures classified as authentication errors", () => {
    expect(adapterFailureFromMessage(
      "Provider authentication failed: invalid API key",
    )).toMatchObject({
      httpStatus: 401,
      error: { type: "authentication_error", code: "invalid_api_key" },
    });
  });

  test("does not swallow ordinary permission_denied failures unrelated to local ACL setup", () => {
    // Only local ACL/icacls/NTFS-hardening wording is exempted — an upstream provider's own
    // "permission denied" (no icacls/ACL/NTFS vocabulary) must still classify normally.
    expect(adapterFailureFromMessage(
      "permission denied: model access requires an upgraded plan",
    )).toMatchObject({
      httpStatus: 403,
    });
  });
});
