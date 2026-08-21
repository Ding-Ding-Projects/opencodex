/**
 * Compatibility adoption for homes routed before the write coordinator existed.
 *
 * Adoption is deliberately a small, positive-authority seam. It can publish only
 * a complete generation-zero `adoption-pending` database after a retained apply or
 * restore callback has supplied a closed, supported intent. It never infers authority
 * from residue, startup observation, or an arbitrary operation string.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

const SCHEMA_VERSION = 1;
const TABLE = "codex_transition_state";

export type AdoptionIntent =
  | { kind: "retained-apply"; operation: "skip" | "apply-opencodex" | "migrate-openai" }
  | { kind: "retained-restore"; operation: "restore-openai" };

export type AdoptionResidue = "routed" | "indeterminate" | "legacy" | "clean";

export type AdoptionDecision =
  | { kind: "adopted"; databasePath: string; authorityId: string; operation: AdoptionIntent["operation"] }
  | { kind: "already-adopted"; databasePath: string }
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

function fsyncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    try { fsyncSync(fd); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code !== "EPERM" && code !== "ENOTSUP") throw error;
    }
  } finally { closeSync(fd); }
}

function publishNoReplace(tempPath: string, finalPath: string): void {
  mkdirSync(dirname(finalPath), { recursive: true, mode: 0o700 });
  try {
    // A hard-link create is atomic and no-replace: EEXIST means another process won.
    linkSync(tempPath, finalPath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "EEXIST") throw new Error("adoption publication race");
    throw error;
  }
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
        native_generation INTEGER NOT NULL CHECK (native_generation = 0),
        current_tx_id TEXT,
        history_status TEXT NOT NULL CHECK (history_status = 'adoption-pending'),
        history_reason TEXT,
        history_attempts INTEGER NOT NULL CHECK (history_attempts = 0),
        history_next_retry_at TEXT,
        history_tx_id TEXT NOT NULL,
        history_operation TEXT NOT NULL,
        history_authority_kind TEXT NOT NULL CHECK (history_authority_kind = 'wp10-compatibility'),
        history_authority_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (current_tx_id IS NULL)
      );
      INSERT INTO ${TABLE} VALUES (1, 0, NULL, 'adoption-pending', NULL, 0, NULL, '${evidence.historyTxId}', '${evidence.historyOperation}', 'wp10-compatibility', '${evidence.authorityId}', '${new Date().toISOString()}');
    `);
  } finally {
    database.close();
  }
  try { chmodSync(tempPath, 0o600); } catch { /* Windows ACLs are handled by the host runner */ }
  fsyncFile(tempPath);
}

export function readAdoptionEvidence(databasePath: string): AdoptionEvidence | null {
  if (!existsSync(databasePath)) return null;
  let database: Database;
  try { database = new Database(databasePath, { readonly: true, create: false }); }
  catch { return null; }
  try {
    let row: Record<string, unknown> | null;
    try {
      row = database.query(`SELECT native_generation, current_tx_id, history_status, history_tx_id, history_operation, history_authority_kind, history_authority_id FROM ${TABLE} WHERE singleton = 1`).get() as Record<string, unknown> | null;
    } catch { return null; }
    if (!row || row.native_generation !== 0 || row.current_tx_id !== null || row.history_status !== "adoption-pending" || typeof row.history_tx_id !== "string" || typeof row.history_operation !== "string" || row.history_authority_kind !== "wp10-compatibility" || typeof row.history_authority_id !== "string") return null;
    if (!(row.history_operation === "skip" || row.history_operation === "apply-opencodex" || row.history_operation === "migrate-openai" || row.history_operation === "restore-openai")) return null;
    return {
      nativeGeneration: 0,
      currentTxId: null,
      historyStatus: "adoption-pending",
      historyTxId: row.history_tx_id,
      historyOperation: row.history_operation,
      authorityKind: "wp10-compatibility",
      authorityId: row.history_authority_id,
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
    const evidence = readAdoptionEvidence(finalPath);
    return evidence ? { kind: "already-adopted", databasePath: finalPath } : { kind: "refused", reason: lstatSync(finalPath).isFile() ? "rowless-database" : "unversioned-database" };
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
    if (existsSync(finalPath)) return { kind: "refused", reason: "publication-race" };
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
