/**
 * The dashboard's former admin-token/session fetch wrapper.
 *
 * Management authentication is intentionally gone. Keeping this tiny lifecycle API avoids
 * breaking callers and tests that reset the old wrapper, while deliberately leaving the browser's
 * native `fetch` untouched: no admin token, GUI session, CSRF token, or prompt is ever collected.
 */

let installed = false;

type TokenRequester = (message: string) => Promise<string | null>;

/** Legacy compatibility no-op. Admin-token prompts are permanently disabled. */
export function setTokenRequester(_requester: TokenRequester | null): void { /* intentionally disabled */ }

/** Legacy compatibility no-op. The mobile surface no longer needs prompt suppression. */
export function setAdminTokenPromptSuppressed(_suppressed: boolean): void { /* intentionally disabled */ }

/** No wrapper is installed; this remains for the existing application bootstrap call. */
export function installApiAuthFetch(): void {
  installed = true;
}

/** Test-only lifecycle reset retained for callers that used the former wrapper. */
export function resetApiAuthFetchForTests(): void {
  installed = false;
}

/** Test-only diagnostic so the compatibility lifecycle remains observable without credentials. */
export function isApiAuthFetchInstalledForTests(): boolean {
  return installed;
}
