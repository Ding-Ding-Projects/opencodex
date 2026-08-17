/**
 * Pure parsing for the always-on-top popup windows' route:
 * `#/downloads?popup=start&id=<uuid>` or `#/downloads?popup=complete&id=<uuid>`.
 *
 * Kept separate from `app-routing.ts`'s hash router on purpose: a popup window
 * never goes through the normal tab/page router (see `main.tsx`) — it renders
 * `pages/DownloadPopup.tsx` full-bleed, with no nav rail, app bar or tab strip,
 * because it IS the whole window (see `electron/main.mjs`'s `openDownloadPopup`).
 */

export interface DownloadPopupRoute {
  kind: "start" | "complete";
  id: string;
}

export function parseDownloadPopupHash(rawHash: string): DownloadPopupRoute | null {
  const hash = rawHash.replace(/^#\/?/, "");
  const [path, query] = hash.split("?");
  if (path !== "downloads") return null;
  const params = new URLSearchParams(query ?? "");
  const kind = params.get("popup");
  const id = params.get("id");
  if ((kind !== "start" && kind !== "complete") || !id) return null;
  return { kind, id };
}
