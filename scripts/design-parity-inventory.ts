import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const INVENTORY_RELATIVE_PATH = "docs/design-system/design-parity-inventory.json";
export const EXACT_SCREEN_IDS = [
  "dashboard", "codex-auth", "providers", "models", "combos", "subagents", "logs", "usage", "storage",
  "api", "claude", "grok", "startup", "appearance", "language", "regex", "changelog", "history", "notifications",
] as const;
export const REQUIRED_TUPLE_FIELDS = ["screen", "state", "theme", "viewport", "scale", "locale"] as const;
export const REQUIRED_PRIMITIVES = [
  "buttons", "fields", "menus", "tabs", "dialogs", "navigation", "selection", "typography", "color", "shape",
  "elevation", "state", "focus", "motion", "accessibility",
] as const;

type AnyRecord = Record<string, any>;
export type Inventory = AnyRecord;

export function readInventory(repoRoot = resolve(import.meta.dir, "..")): Inventory {
  return JSON.parse(readFileSync(join(repoRoot, INVENTORY_RELATIVE_PATH), "utf8")) as Inventory;
}

function fail(message: string): never {
  throw new Error(`design-parity inventory: ${message}`);
}

function requiredObject(value: unknown, label: string): AnyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as AnyRecord;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pngDimensions(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.toString("ascii", 1, 4) !== "PNG") {
    fail(`${path} is not a PNG`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function assertTuple(tuple: AnyRecord, expectedId: string, label: string): void {
  for (const field of REQUIRED_TUPLE_FIELDS) if (!(field in tuple)) fail(`${label} is missing tuple field ${field}`);
  if (tuple.screen !== expectedId) fail(`${label}.screen must be ${expectedId}`);
  if (!Number.isInteger(tuple.viewport?.width) || !Number.isInteger(tuple.viewport?.height)) fail(`${label}.viewport must have integer width and height`);
  if (!Number.isFinite(tuple.scale) || tuple.scale <= 0) fail(`${label}.scale must be positive`);
  for (const field of ["state", "theme", "locale"]) requiredString(tuple[field], `${label}.${field}`);
}

function evidenceFile(
  entry: AnyRecord,
  label: string,
  repoRoot: string,
  dimensions: { width: number; height: number } | null = null,
  checkFiles = true,
): void {
  const path = requiredString(entry.path, `${label}.path`);
  const hash = requiredString(entry.sha256, `${label}.sha256`);
  if (!/^[a-f0-9]{64}$/.test(hash)) fail(`${label}.sha256 must be a lowercase SHA-256`);
  if (!checkFiles) return;
  const absolute = resolve(repoRoot, path);
  const actual = sha256(absolute);
  if (actual !== hash) fail(`${label}.sha256 does not match ${path}`);
  if (dimensions) {
    const actualDimensions = pngDimensions(absolute);
    if (actualDimensions.width !== dimensions.width || actualDimensions.height !== dimensions.height) fail(`${label} dimensions do not match the inventory`);
  }
}

export function validateInventory(inventory: Inventory, options: { repoRoot?: string; checkFiles?: boolean } = {}): void {
  const repoRoot = options.repoRoot ?? resolve(import.meta.dir, "..");
  requiredString(inventory.schemaVersion, "schemaVersion");
  if (inventory.schemaVersion !== "design-parity-inventory/v1") fail(`unsupported schema ${inventory.schemaVersion}`);
  requiredString(inventory.inventoryId, "inventoryId");
  const ids = inventory.screenIds;
  if (!Array.isArray(ids) || ids.length !== EXACT_SCREEN_IDS.length || ids.some((id, index) => id !== EXACT_SCREEN_IDS[index])) fail("screenIds must be the exact hand-written 19-screen list");
  if (!Number.isInteger(inventory.rowCount) || inventory.rowCount !== EXACT_SCREEN_IDS.length) fail("rowCount must equal 19");
  if (!Array.isArray(inventory.rows) || inventory.rows.length !== EXACT_SCREEN_IDS.length) fail("rows must contain exactly 19 rows");
  if (inventory.status === "verified") fail("inventory cannot claim parity verified");

  for (const [index, row] of inventory.rows.entries()) {
    const id = EXACT_SCREEN_IDS[index];
    requiredObject(row, `rows[${index}]`);
    if (row.id !== id) fail(`rows[${index}].id must be ${id}`);
    requiredString(row.name, `${id}.name`);
    const reference = requiredObject(row.reference, `${id}.reference`);
    requiredString(reference.file, `${id}.reference.file`);
    requiredString(reference.fileSha256, `${id}.reference.fileSha256`);
    requiredString(reference.route, `${id}.reference.route`);
    requiredString(reference.selector, `${id}.reference.selector`);
    const real = requiredObject(row.realApp, `${id}.realApp`);
    requiredString(real.route, `${id}.realApp.route`);
    requiredString(real.sourceCommit, `${id}.realApp.sourceCommit`);
    requiredString(real.sourceHash, `${id}.realApp.sourceHash`);
    assertTuple(requiredObject(row.tuple, `${id}.tuple`), id, `${id}.tuple`);
    const tuples = requiredObject(row.captureTuples, `${id}.captureTuples`);
    assertTuple(requiredObject(tuples.reference, `${id}.captureTuples.reference`), id, `${id}.captureTuples.reference`);
    assertTuple(requiredObject(tuples.built, `${id}.captureTuples.built`), id, `${id}.captureTuples.built`);
    for (const field of ["fixture", "time", "motion", "random", "fonts", "network", "localePolicy"]) requiredString(row.deterministicInputs?.[field], `${id}.deterministicInputs.${field}`);

    const audit = requiredObject(row.md3Audit, `${id}.md3Audit`);
    requiredString(audit.status, `${id}.md3Audit.status`);
    const primitives = requiredObject(audit.primitives, `${id}.md3Audit.primitives`);
    const primitiveKeys = Object.keys(primitives);
    if (primitiveKeys.length !== REQUIRED_PRIMITIVES.length || REQUIRED_PRIMITIVES.some(key => !Object.prototype.hasOwnProperty.call(primitives, key))) fail(`${id}.md3Audit.primitives must cover every required primitive`);
    for (const primitive of REQUIRED_PRIMITIVES) {
      const entry = requiredObject(primitives[primitive], `${id}.md3Audit.primitives.${primitive}`);
      requiredString(entry.verdict, `${id}.md3Audit.primitives.${primitive}.verdict`);
      requiredString(entry.reason, `${id}.md3Audit.primitives.${primitive}.reason`);
    }
    if (!Array.isArray(row.deviations) || row.deviations.length === 0) fail(`${id}.deviations must be an explicit list`);
    for (const [deviationIndex, deviation] of row.deviations.entries()) {
      requiredString(deviation.id, `${id}.deviations[${deviationIndex}].id`);
      requiredString(deviation.reason, `${id}.deviations[${deviationIndex}].reason`);
      requiredString(deviation.approval, `${id}.deviations[${deviationIndex}].approval`);
    }
    for (const field of ["inventorySourceCommit", "referenceSourceHash", "realSourceCommit"]) requiredString(row.provenance?.[field], `${id}.provenance.${field}`);
    for (const field of ["referenceCapture", "builtCapture", "comparison", "diff"]) {
      const provenance = requiredObject(row.provenance?.[field], `${id}.provenance.${field}`);
      requiredString(provenance.status, `${id}.provenance.${field}.status`);
    }
    requiredString(row.verdict, `${id}.verdict`);
    if (row.verdict === "verified") fail(`${id} cannot claim parity verified`);
    if (!Array.isArray(row.verdictReasons) || row.verdictReasons.length === 0) fail(`${id}.verdictReasons must explain the honest non-verified verdict`);

    const evidence = requiredObject(row.evidence, `${id}.evidence`);
    const referenceRaw = requiredObject(evidence.referenceRaw, `${id}.evidence.referenceRaw`);
    const builtRaw = requiredObject(evidence.builtRaw, `${id}.evidence.builtRaw`);
    const sideBySide = requiredObject(evidence.sideBySide, `${id}.evidence.sideBySide`);
    const diff = requiredObject(evidence.diff, `${id}.evidence.diff`);
    const checkFiles = options.checkFiles !== false;
    evidenceFile(referenceRaw, `${id}.evidence.referenceRaw`, repoRoot, { width: 2880, height: 1800 }, checkFiles);
    evidenceFile(builtRaw, `${id}.evidence.builtRaw`, repoRoot, { width: 2880, height: 1800 }, checkFiles);
    evidenceFile(sideBySide, `${id}.evidence.sideBySide`, repoRoot, { width: 1956, height: 685 }, checkFiles);
    evidenceFile(diff, `${id}.evidence.diff`, repoRoot, null, checkFiles);
    if (checkFiles) {
      const diffPayload = JSON.parse(readFileSync(resolve(repoRoot, diff.path), "utf8")) as AnyRecord;
      if (diffPayload.id !== id) fail(`${id}.evidence.diff record id mismatch`);
      if (diffPayload.inputs?.reference?.sha256 !== referenceRaw.sha256 || diffPayload.inputs?.built?.sha256 !== builtRaw.sha256) fail(`${id}.evidence.diff does not bind both raw input hashes`);
      if (!Number.isInteger(diffPayload.comparison?.changedPixels) || !Number.isFinite(diffPayload.comparison?.changedPixelRatio)) fail(`${id}.evidence.diff lacks changed-pixel metrics`);
    }
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function runNegativeRegression(base: Inventory, repoRoot = resolve(import.meta.dir, "..")): string[] {
  validateInventory(base, { repoRoot });
  const checks: Array<[string, (copy: Inventory) => void]> = [
    ["row", copy => copy.rows.pop()],
    ["reference route", copy => delete copy.rows[0].reference.route],
    ["tuple field", copy => delete copy.rows[0].tuple.locale],
    ["audit", copy => delete copy.rows[0].md3Audit.primitives.buttons],
    ["raw hash", copy => delete copy.rows[0].evidence.referenceRaw.sha256],
    ["comparison hash", copy => delete copy.rows[0].evidence.sideBySide.sha256],
    ["diff hash", copy => delete copy.rows[0].evidence.diff.sha256],
    ["deviation reason", copy => delete copy.rows[0].deviations[0].reason],
    ["deviation approval", copy => delete copy.rows[0].deviations[0].approval],
  ];
  const receipts: string[] = [];
  const empty = clone(base);
  empty.screenIds = [];
  empty.rows = [];
  empty.rowCount = 0;
  let rejected = false;
  try { validateInventory(empty, { repoRoot, checkFiles: false }); } catch { rejected = true; }
  if (!rejected) fail("empty inventory unexpectedly passed");
  receipts.push("RED empty inventory");
  validateInventory(base, { repoRoot });
  receipts.push("GREEN restore empty inventory");
  for (const [label, mutate] of checks) {
    const broken = clone(base);
    mutate(broken);
    rejected = false;
    try { validateInventory(broken, { repoRoot, checkFiles: false }); } catch { rejected = true; }
    if (!rejected) fail(`${label} mutation unexpectedly passed`);
    receipts.push(`RED ${label}`);
    validateInventory(base, { repoRoot });
    receipts.push(`GREEN restore ${label}`);
  }
  return receipts;
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, "..");
  const inventory = readInventory(repoRoot);
  validateInventory(inventory, { repoRoot });
  console.log(`PASS: ${inventory.rows.length} exact design-parity rows; all evidence hashes and diff bindings match`);
  if (process.argv.includes("--negative")) {
    for (const receipt of runNegativeRegression(inventory, repoRoot)) console.log(receipt);
    console.log("PASS: negative regression observed red then green for every required boundary");
  }
}
