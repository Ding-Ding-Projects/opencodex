import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { browserSecurityHeaders } from "./auth-cors";
import {
  GUI_BUILD_MANIFEST_FILE,
  GUI_UI_GENERATION,
  guiGenerationMetaTag,
  parseGuiBuildManifest,
} from "../lib/gui-build";

/** Optional renderer bootstrap shape; management authentication is not part of the open API. */
export interface GuiSessionBootstrap {
  token: string;
  csrfToken: string;
  origin: string;
}

/** opencodex version, read from the packaged package.json (same source as the server bootstrap). */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
})();

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".webp": "image/webp", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".avif": "image/avif",
  ".woff2": "font/woff2", ".woff": "font/woff",
};

/** Fail closed when source/package drift would otherwise serve the retired dashboard. */
export function isCompatibleGuiDist(guiDist: string, packageVersion = VERSION): boolean {
  try {
    const indexHtml = readFileSync(join(guiDist, "index.html"), "utf8");
    if (!indexHtml.includes(guiGenerationMetaTag())) return false;
    const parsed = JSON.parse(readFileSync(join(guiDist, GUI_BUILD_MANIFEST_FILE), "utf8"));
    const manifest = parseGuiBuildManifest(parsed);
    return manifest?.uiGeneration === GUI_UI_GENERATION
      && manifest.packageVersion === packageVersion;
  } catch {
    return false;
  }
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve only the dashboard owned by this package/repository.
 *
 * The retired two-candidate lookup walked one directory above the package and
 * could serve a sibling `gui/dist`. Because HTML receives a short-lived GUI
 * session token, an adjacent checkout must never be allowed to become the page
 * that receives it.
 */
export function findPackagedGuiDist(
  serverDir: string = import.meta.dir,
  packageVersion: string = VERSION,
): string | null {
  const packageRoot = resolve(serverDir, "..", "..");
  const candidate = resolve(packageRoot, "gui", "dist");
  let realCandidate: string;
  try {
    const realRoot = realpathSync(packageRoot);
    realCandidate = realpathSync(candidate);
    if (!isContained(realRoot, realCandidate)) return null;
  } catch {
    return null;
  }
  return existsSync(join(realCandidate, "index.html")) && isCompatibleGuiDist(realCandidate, packageVersion)
    ? realCandidate
    : null;
}

export function resolveGuiFilePath(guiDist: string, pathname: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decodedPath.includes("\0")) return null;

  const relativePath = decodedPath === "/" || decodedPath === ""
    ? "index.html"
    : decodedPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const root = resolve(guiDist);
  const filePath = resolve(root, relativePath);
  const rel = relative(root, filePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return filePath;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve a served file through symlinks and keep the final target in gui/dist. */
function containedFile(guiDist: string, path: string): string | null {
  try {
    const realRoot = realpathSync(guiDist);
    const realPath = realpathSync(path);
    return isContained(realRoot, realPath) && statSync(realPath).isFile() ? realPath : null;
  } catch {
    return null;
  }
}

function htmlResponse(path: string, session?: GuiSessionBootstrap): Response {
  let html = readFileSync(path, "utf8");
  const scriptNonce = randomBytes(16).toString("base64");
  // The checked-in shell has one tiny inline first-paint script. Give every
  // trusted script tag this response's nonce instead of enabling unsafe-inline.
  html = html.replace(/<script(?=[\s>])/g, `<script nonce="${scriptNonce}"`);
  if (session) {
    const bootstrap = [
      `<meta name="opencodex-session-token" content="${session.token}">`,
      `<meta name="opencodex-session-csrf" content="${session.csrfToken}">`,
      `<meta name="opencodex-session-origin" content="${session.origin}">`,
    ].join("");
    html = html.includes("</head>") ? html.replace("</head>", `${bootstrap}</head>`) : `${bootstrap}${html}`;
  }
  return new Response(html, {
    headers: {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      ...browserSecurityHeaders(scriptNonce),
    },
  });
}

export function serveGuiFile(
  pathname: string,
  guiDist = findPackagedGuiDist(),
  session?: GuiSessionBootstrap,
): Response | null {
  if (!guiDist) return null;
  const filePath = resolveGuiFilePath(guiDist, pathname);
  if (!filePath) return null;

  const canonicalFilePath = isFile(filePath) ? containedFile(guiDist, filePath) : null;
  if (!canonicalFilePath) {
    if (!extname(pathname)) {
      const indexPath = join(guiDist, "index.html");
      const canonicalIndexPath = isFile(indexPath) ? containedFile(guiDist, indexPath) : null;
      if (canonicalIndexPath) {
        return htmlResponse(canonicalIndexPath, session);
      }
    }
    return null;
  }

  const ext = extname(canonicalFilePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  if (ext === ".html") return htmlResponse(canonicalFilePath, session);
  return new Response(Bun.file(canonicalFilePath), {
    headers: { "Content-Type": contentType, ...browserSecurityHeaders() },
  });
}

export function rootFallbackPayload() {
  return {
    status: "ok",
    service: "opencodex",
    version: VERSION,
    dashboard: {
      available: false,
      reason: "Compatible Material 3 GUI build not found. Run `bun run build:gui` from the opencodex repo, or reinstall a package that contains a verified dashboard build.",
    },
    endpoints: {
      health: "/healthz",
      models: "/v1/models",
      responses: "/v1/responses",
      chatCompletions: "/v1/chat/completions",
      management: "/api/*",
    },
  };
}
