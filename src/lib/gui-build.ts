/** Identity contract shared by the GUI build, package gate, and static server. */
export const GUI_UI_GENERATION = "material-3";
export const GUI_BUILD_MANIFEST_FILE = "ocx-gui-build.json";

export interface GuiBuildManifest {
  schema: 1;
  uiGeneration: typeof GUI_UI_GENERATION;
  packageVersion: string;
  sourceHash: string;
}

export function parseGuiBuildManifest(value: unknown): GuiBuildManifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const manifest = value as Record<string, unknown>;
  if (manifest.schema !== 1) return null;
  if (manifest.uiGeneration !== GUI_UI_GENERATION) return null;
  if (typeof manifest.packageVersion !== "string" || manifest.packageVersion.length === 0) return null;
  if (typeof manifest.sourceHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(manifest.sourceHash)) return null;
  return manifest as unknown as GuiBuildManifest;
}

export function guiGenerationMetaTag(): string {
  return `<meta name="opencodex-ui-generation" content="${GUI_UI_GENERATION}"`;
}
