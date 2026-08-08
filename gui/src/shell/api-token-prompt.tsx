/** Connect the fetch wrapper's 401 credential request to the M3 prompt surface. */

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
      body: message,
      label: t("auth.adminTokenLabel"),
      secret: true,
      confirmLabel: t("auth.adminTokenAction"),
    }));
    return () => setTokenRequester(null);
  }, [prompt, t]);

  return null;
}
