/**
 * Disposable-host service-class acceptance entry point for WP13.
 *
 * This file intentionally lives below scripts/, not tests/, because service-manager
 * acceptance must run only on a disposable host. It is an observe-and-report
 * coordinator: it never starts or stops a service from an ordinary workstation.
 * A host runner supplies the fixture root and a profile-specific evidence manifest.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const SERVICE_CLASS_PROFILES = ["P09", "P10", "P18", "P34", "P35", "P36"] as const;
export type ServiceClassProfile = (typeof SERVICE_CLASS_PROFILES)[number];

type CheckStatus = "passed" | "failed" | "not-run";
export type ServiceAcceptanceEvidence = {
  profile: ServiceClassProfile;
  hostRoot: string;
  startedAt: string;
  finishedAt: string;
  status: "verified" | "failed" | "refused";
  checks: readonly {
    id: string;
    status: CheckStatus;
    detail: string;
  }[];
  artifacts: Readonly<Record<string, string>>;
  reason?: string;
};

function parseProfile(value: string | undefined): ServiceClassProfile {
  if (!value || !(SERVICE_CLASS_PROFILES as readonly string[]).includes(value)) {
    throw new Error(`profile must be one of ${SERVICE_CLASS_PROFILES.join(", ")}`);
  }
  return value as ServiceClassProfile;
}

function evidenceFor(profile: ServiceClassProfile, hostRoot: string): ServiceAcceptanceEvidence {
  const startedAt = new Date().toISOString();
  const manifestPath = join(hostRoot, "service-acceptance-evidence.json");
  const checks = [
    {
      id: "disposable-host-marker",
      status: existsSync(join(hostRoot, ".disposable-host")) ? "passed" : "failed",
      detail: "The host declares itself disposable with a local marker.",
    },
    {
      id: "profile-manifest",
      status: existsSync(manifestPath) ? "passed" : "failed",
      detail: "The service-manager runner supplied the profile evidence manifest.",
    },
    {
      id: `service-class-${profile}`,
      status: existsSync(join(hostRoot, profile, "service-ready.json")) ? "passed" : "failed",
      detail: `The ${profile} service-class fixture reports its ready state.`,
    },
  ] satisfies ServiceAcceptanceEvidence["checks"];

  const artifacts: Record<string, string> = {};
  if (existsSync(manifestPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string" && key.length <= 120 && value.length <= 500) artifacts[key] = value;
        }
      }
    } catch {
      artifacts.manifest = "unreadable or malformed; no payload retained";
    }
  }

  const status = checks.every(check => check.status === "passed") ? "verified" : "failed";
  return { profile, hostRoot, startedAt, finishedAt: new Date().toISOString(), status, checks, artifacts };
}

export function runServiceAcceptance(options: {
  profile: string | undefined;
  hostRoot: string | undefined;
  disposableHost: string | undefined;
}): ServiceAcceptanceEvidence {
  const profile = parseProfile(options.profile);
  if (options.disposableHost !== "1") {
    return {
      profile,
      hostRoot: "",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "refused",
      checks: [],
      artifacts: {},
      reason: "service-class acceptance requires OCX_DISPOSABLE_HOST_ACCEPTANCE=1",
    };
  }
  if (!options.hostRoot || !isAbsolute(options.hostRoot)) {
    throw new Error("OCX_DISPOSABLE_HOST_ROOT must be an absolute disposable-host path");
  }
  const hostRoot = resolve(options.hostRoot);
  if (!existsSync(hostRoot) || !lstatSync(hostRoot).isDirectory()) {
    throw new Error("OCX_DISPOSABLE_HOST_ROOT must name an existing directory");
  }
  return evidenceFor(profile, hostRoot);
}

if (import.meta.main) {
  try {
    const evidence = runServiceAcceptance({
      profile: process.env.OCX_SERVICE_ACCEPTANCE_PROFILE,
      hostRoot: process.env.OCX_DISPOSABLE_HOST_ROOT,
      disposableHost: process.env.OCX_DISPOSABLE_HOST_ACCEPTANCE,
    });
    console.log(JSON.stringify(evidence));
    process.exitCode = evidence.status === "verified" ? 0 : evidence.status === "refused" ? 2 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "service acceptance failed");
    process.exitCode = 1;
  }
}
