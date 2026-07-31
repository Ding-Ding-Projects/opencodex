/**
 * Closes the loop between `api.ts`'s token requester registry and the React tree.
 *
 * `installApiAuthFetch()` runs before React mounts, so `api.ts` cannot render a
 * dialog itself. It calls whatever has registered by the time a 401 actually
 * arrives, and falls back to `window.prompt` for anything that has not — which
 * inside Electron means *nothing*, because Electron does not implement `prompt`
 * and throws. That threw straight out of the fetch wrapper, so one 401 broke
 * every caller that touched it: Exit reported "Could not exit cleanly: prompt()
 * is not supported" and then did not exit. `api.ts` now swallows that into a
 * `null` rather than an exception, but a `null` still means the desktop app had
 * no way to ask, and every authenticated call after the first 401 failed.
 *
 * Mounting this inside `ConfirmProvider` gives it one: the M3 prompt, themed,
 * localized, keyboard-operable, and masked because an admin token is a
 * credential.
 *
 * It renders nothing. It is a component only because registering has to happen
 * from inside the provider — a module-level call could not reach `usePrompt()`.
 */

import { useEffect } from "react";
import { setTokenRequester } from "../api";
import { useT } from "../i18n/shared";
import { usePrompt } from "./confirm-context";

export default function ApiTokenPrompt() {
  const prompt = usePrompt();
  const t = useT();

  useEffect(() => {
    setTokenRequester(message => prompt({
      title: t("auth.adminTokenTitle"),
      // The long-standing explanation — which token this is and which one will
      // not work — is `api.ts`'s own message, passed through rather than
      // duplicated here. Two copies of it would drift.
      body: message,
      label: t("auth.adminTokenLabel"),
      secret: true,
      confirmLabel: t("auth.adminTokenAction"),
    }));
    // Unregistering on unmount matters: `api.ts` holds this in a module
    // variable that outlives the React root, and a requester pointing at a torn
    // down tree would return a promise nothing can ever settle.
    return () => setTokenRequester(null);
  }, [prompt, t]);

  return null;
}
