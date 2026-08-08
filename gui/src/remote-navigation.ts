import { pageUrlForOrigin } from "./app-routing";

type OpenWindow = (url?: string | URL, target?: string, features?: string) => Window | null;

export interface RemoteOpenResult {
  url: string;
  opened: boolean;
}

/** Open a validated remote endpoint at its dashboard without adding credentials. */
export function openRemoteDashboard(
  endpoint: string,
  openWindow: OpenWindow = window.open.bind(window),
): RemoteOpenResult {
  const url = pageUrlForOrigin(endpoint, "dashboard");
  const opened = openWindow(url, "_blank", "noopener,noreferrer");
  return { url, opened: opened !== null };
}
