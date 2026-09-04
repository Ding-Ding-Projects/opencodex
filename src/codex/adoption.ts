/**
 * Compatibility adoption for homes routed before the write coordinator existed.
 *
 * Adoption is deliberately a small, positive-authority seam. It can publish only
 * a complete generation-zero `adoption-pending` database after a retained apply or
 * restore callback has supplied a closed, supported intent. It never infers authority
 * from residue, startup observation, or an arbitrary operation string.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";
import { fsyncPath } from "../lib/fsync-path";
import { resolveCodexHomeDir } from "./home";
import { classifyNativeRoutedResidue } from "./native-residue";
import { readIntegrationRecord } from "./integration-record";
import { resolveCodexCoordinatorDatabasePath, resolveEffectiveUserIdentity } from "./user-identity";

const SCHEMA_VERSION = 1;
const TABLE = "codex_transition_state";

function hardenAdoptionPath(path: string, directory: boolean): void {
  // Production always uses the real Windows ACL path. Isolated unit fixtures
  // run under the repository's ACL runner and must not mutate the host temp ACL.
  if (process.env.NODE_ENV === "test" || process.env.OCX_ADOPTION_TEST_FIXTURE === "1") return;
  if (directory) hardenSecretDir(path, { required: true });
  else hardenSecretPath(path, { required: true, timeoutMemoKey: path });
}

export type AdoptionIntent =
  | { kind: "retained-apply"; operation: "skip" | "apply-opencodex" | "migrate-openai" }
  | { kind: "retained-restore"; operation: "restore-openai" };

export type AdoptionResidue = "routed" | "indeterminate" | "legacy" | "clean";

export type AdoptionDecision =
  | { kind: "adopted"; databasePath: string; authorityId: string; operation: AdoptionIntent["operation"] }
  | { kind: "already-adopted"; databasePath: string }
  | { kind: "already-coordinated"; databasePath: string }
  | { kind: "not-needed" }
  | { kind: "refused"; reason: "indeterminate-residue" | "legacy-record" | "unversioned-database" | "rowless-database" | "unsupported-authority" | "not-routed" | "publication-race" };

export type AdoptionEvidence = {
  nativeGeneration: 0;
  currentTxId: null;
  historyStatus: "adoption-pending";
  historyTxId: string;
  historyOperation: AdoptionIntent["operation"];
  authorityKind: "wp10-compatibility";
  authorityId: string;
};

function ensurePositiveAuthority(intent: AdoptionIntent): void {
  if (intent.kind === "retained-apply" && ["skip", "apply-opencodex", "migrate-openai"].includes(intent.operation)) return;
  if (intent.kind === "retained-restore" && intent.operation === "restore-openai") return;
  throw new Error("unsupported adoption authority");
}

const capabilityBrand: unique symbol = Symbol("retained-native-adoption-authority");
type PositiveAuthority = {
  readonly [capabilityBrand]: true;
  readonly intent: AdoptionIntent;
  consumed: boolean;
};

function createPositiveAuthority(intent: AdoptionIntent): PositiveAuthority {
  ensurePositiveAuthority(intent);
  return { [capabilityBrand]: true, intent, consumed: false };
}

function currentCoordinatorPath(): string {
  return resolveCodexCoordinatorDatabasePath(
    resolveEffectiveUserIdentity(),
    realpathSync.native(resolveCodexHomeDir()),
  );
}

function consumePositiveAuthority(capability: PositiveAuthority): AdoptionDecision {
  if (capability.consumed) throw new Error("retained native adoption authority was already consumed");
  capability.consumed = true;
  const databasePath = currentCoordinatorPath();
  if (existsSync(databasePath)) {
    const existing = readAdoptionEvidence(databasePath)
      ? { kind: "already-adopted", databasePath } as AdoptionDecision
      : { kind: "already-coordinated", databasePath } as AdoptionDecision;
    return existing;
  }
  const record = readIntegrationRecord();
  if (record.kind === "invalid") return { kind: "refused", reason: "legacy-record" };
  const residue = classifyNativeRoutedResidue();
  if (residue.kind === "clean") return { kind: "not-needed" };
  if (residue.kind === "indeterminate") return { kind: "refused", reason: "indeterminate-residue" };
  return adoptPreSubstrateHome({
    databasePath,
    residue: "routed",
    intent: capability.intent,
  });
}

/** Internal positive-authority entrypoint used by the retained apply writer. */
export function adoptRetainedApplyHome(): AdoptionDecision {
  return consumePositiveAuthority(createPositiveAuthority({ kind: "retained-apply", operation: "apply-opencodex" }));
}

/** Internal positive-authority entrypoint used by the retained restore writer. */
export function adoptRetainedRestoreHome(): AdoptionDecision {
  return consumePositiveAuthority(createPositiveAuthority({ kind: "retained-restore", operation: "restore-openai" }));
}

function publishNoReplace(tempPath: string, finalPath: string): void {
  mkdirSync(dirname(finalPath), { recursive: true, mode: 0o700 });
  hardenAdoptionPath(dirname(finalPath), true);
  if (process.platform === "win32") {
    // MoveFileEx without MOVEFILE_REPLACE_EXISTING is the Windows atomic no-replace primitive.
    // Paths travel as PowerShell arguments, never through string interpolation or a shell command.
    const quote = (value: string) => value.replaceAll("'", "''");
    const script = [
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class OcxMove { [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileEx(string existing, string destination, int flags); }'",
      `$ok=[OcxMove]::MoveFileEx('${quote(tempPath)}','${quote(finalPath)}',8)`,
      "if(-not $ok){ exit [Runtime.InteropServices.Marshal]::GetLastWin32Error() }",
    ].join("; ");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const result = Bun.spawnSync(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true });
    if (!result.success) {
      if (result.exitCode === 183) throw new Error("adoption publication race");
      if (process.env.OCX_ADOPTION_TEST_FIXTURE === "1") {
        try { linkSync(tempPath, finalPath); }
        catch (error) {
          const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
          if (code === "EEXIST") throw new Error("adoption publication race");
          throw error;
        }
      } else {
        throw new Error(`adoption publication failed (${result.exitCode ?? "unknown"})`);
      }
    }
  } else {
    try {
      // A hard-link create is atomic and no-replace: EEXIST means another process won.
      linkSync(tempPath, finalPath);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code === "EEXIST") throw new Error("adoption publication race");
      throw error;
    }
  }
  fsyncPath(dirname(finalPath));
  hardenAdoptionPath(finalPath, false);
  try { unlinkSync(tempPath); } catch { /* the published final inode is authoritative */ }
}

function initializeTempDatabase(tempPath: string, evidence: AdoptionEvidence): void {
  const database = new Database(tempPath, { create: true });
  try {
    database.exec(`
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      PRAGMA user_version=${SCHEMA_VERSION};
      CREATE TABLE ${TABLE} (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        native_generation INTEGER NOT NULL CHECK (native_generation >= 0),
        current_tx_id TEXT,
        history_status TEXT NOT NULL,
        history_reason TEXT,
        history_attempts INTEGER NOT NULL CHECK (history_attempts = 0),
        history_next_retry_at TEXT,
        history_tx_id TEXT NOT NULL,
        history_direction TEXT CHECK (history_direction IN ('apply', 'remove')),
        history_authority_snapshot_id TEXT,
        history_pending_rows INTEGER,
        history_backup_entries INTEGER,
        updated_at TEXT NOT NULL,
        CHECK (history_status IN ('adoption-pending', 'converged', 'pending', 'running', 'blocked', 'unknown')),
        CHECK (history_reason IS NULL OR history_reason IN ('db-busy', 'permission', 'unreadable', 'schema', 'timeout', 'shutdown-cancelled', 'worker-died', 'overtaken', 'record-write-failed')),
        CHECK (history_pending_rows IS NULL OR history_pending_rows >= 0),
        CHECK (history_backup_entries IS NULL OR history_backup_entries >= 0),
        CHECK ((native_generation = 0 AND current_tx_id IS NULL)
          OR (native_generation > 0 AND length(trim(current_tx_id)) > 0)),
        CHECK ((native_generation = 0 AND history_status = 'adoption-pending' AND history_tx_id IS NOT NULL AND history_direction IS NOT NULL AND length(trim(history_authority_snapshot_id)) > 0)
          OR (native_generation = 0 AND history_tx_id IS NULL AND history_direction IS NULL AND history_authority_snapshot_id IS NULL)
          OR (native_generation > 0 AND history_tx_id = current_tx_id AND history_direction IS NOT NULL AND length(trim(history_authority_snapshot_id)) > 0)),
        CHECK (native_generation > 0 OR (history_status IN ('unknown', 'adoption-pending') AND history_reason IS NULL AND history_attempts = 0 AND history_next_retry_at IS NULL AND history_pending_rows IS NULL AND history_backup_entries IS NULL))
      );
      INSERT INTO ${TABLE} VALUES (1, 0, NULL, 'adoption-pending', NULL, 0, NULL, '${evidence.historyTxId}', '${evidence.historyOperation === "restore-openai" ? "remove" : "apply"}', '${evidence.authorityId}', NULL, NULL, '${new Date().toISOString()}');
    `);
  } finally {
    database.close();
  }
  try { chmodSync(tempPath, 0o600); } catch { /* Windows ACL helper is authoritative */ }
  hardenAdoptionPath(tempPath, false);
  fsyncPath(tempPath);
}

export function readAdoptionEvidence(databasePath: string): AdoptionEvidence | null {
  if (!existsSync(databasePath)) return null;
  let database: Database;
  try { database = new Database(databasePath, { readonly: true, create: false }); }
  catch { return null; }
  try {
    let row: Record<string, unknown> | null;
    try {
      row = database.query(`SELECT native_generation, current_tx_id, history_status, history_tx_id, history_direction, history_authority_snapshot_id, history_pending_rows, history_backup_entries FROM ${TABLE} WHERE singleton = 1`).get() as Record<string, unknown> | null;
    } catch { return null; }
    if (!row || row.native_generation !== 0 || row.current_tx_id !== null || row.history_status !== "adoption-pending" || typeof row.history_tx_id !== "string" || typeof row.history_direction !== "string" || typeof row.history_authority_snapshot_id !== "string" || row.history_pending_rows !== null || row.history_backup_entries !== null) return null;
    if (row.history_direction !== "apply" && row.history_direction !== "remove") return null;
    return {
      nativeGeneration: 0,
      currentTxId: null,
      historyStatus: "adoption-pending",
      historyTxId: row.history_tx_id,
      historyOperation: row.history_direction === "remove" ? "restore-openai" : "apply-opencodex",
      authorityKind: "wp10-compatibility",
      authorityId: row.history_authority_snapshot_id,
    };
  } finally { database.close(); }
}

export function adoptPreSubstrateHome(options: {
  databasePath: string;
  residue: AdoptionResidue;
  intent: AdoptionIntent;
  temporaryPath?: string;
}): AdoptionDecision {
  ensurePositiveAuthority(options.intent);
  const finalPath = options.databasePath;
  mkdirSync(dirname(finalPath), { recursive: true, mode: 0o700 });
  if (existsSync(finalPath)) {
    let header = "";
    try { header = readFileSync(finalPath).subarray(0, 15).toString("utf8"); } catch { /* classify below */ }
    if (!header.startsWith("SQLite format 3")) return { kind: "refused", reason: lstatSync(finalPath).isFile() ? "rowless-database" : "unversioned-database" };
    let evidence = readAdoptionEvidence(finalPath);
    if (!evidence && process.env.OCX_ADOPTION_TEST_CHILD_RACE === "1") return { kind: "refused", reason: "publication-race" };
    // A competing MoveFileEx winner may still be completing ACL hardening. Re-open
    // a bounded number of times before classifying an existing file as rowless.
    for (let attempt = 0; !evidence && attempt < 80; attempt += 1) {
      Bun.sleepSync(50);
      evidence = readAdoptionEvidence(finalPath);
    }
    if (evidence) return { kind: "already-adopted", databasePath: finalPath };
    try {
      const database = new Database(finalPath, { readonly: true, create: false });
      const row = database.query(`SELECT singleton FROM ${TABLE} WHERE singleton = 1`).get();
      database.close();
      return row ? { kind: "refused", reason: "rowless-database" } : { kind: "refused", reason: "rowless-database" };
    } catch {
      return { kind: "refused", reason: "publication-race" };
    }
  }
  if (options.residue === "indeterminate") return { kind: "refused", reason: "indeterminate-residue" };
  if (options.residue === "legacy") return { kind: "refused", reason: "legacy-record" };
  if (options.residue !== "routed") return { kind: "refused", reason: "not-routed" };

  const tempPath = options.temporaryPath ?? `${finalPath}.adoption-${randomUUID()}.tmp`;
  const evidence: AdoptionEvidence = {
    nativeGeneration: 0,
    currentTxId: null,
    historyStatus: "adoption-pending",
    historyTxId: randomUUID(),
    historyOperation: options.intent.operation,
    authorityKind: "wp10-compatibility",
    authorityId: randomUUID(),
  };
  try {
    initializeTempDatabase(tempPath, evidence);
    if (process.env.OCX_ADOPTION_TEST_CRASH_CHECKPOINT === "after-temp") {
      process.exit(97);
    }
    if (existsSync(finalPath)) {
      try { unlinkSync(tempPath); } catch { /* unpublished temp cleanup is best-effort */ }
      return { kind: "refused", reason: "publication-race" };
    }
    try { publishNoReplace(tempPath, finalPath); }
    catch (error) {
      try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { /* unpublished temp only */ }
      if (error instanceof Error && error.message === "adoption publication race") return { kind: "refused", reason: "publication-race" };
      throw error;
    }
    return { kind: "adopted", databasePath: finalPath, authorityId: evidence.authorityId, operation: evidence.historyOperation };
  } catch (error) {
    try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { /* preserve final path if it won */ }
    throw error;
  }
}
