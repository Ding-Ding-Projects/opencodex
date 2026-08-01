/**
 * The export formats, the archives, the VS Code hand-off, and bulk actions.
 *
 * What is pinned here is mostly the honesty, not the happy path: that a lossy
 * format says what it loses before it runs, that an "encrypted" archive really
 * does hide its filenames, that a missing editor is reported rather than
 * substituted, and that a bulk run which half-failed says so.
 *
 * The ZIP writer is checked by handing its output to the real 7-Zip when the
 * machine has one. A ZIP that only this repository can read would pass every
 * structural assertion and still be useless.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  EXPORT_FORMATS, FORMAT_META, columnsOf, describeFidelity, filenameFor, serialize,
  type ExportInput,
} from "../shared/export-formats";
import {
  assertSafePath, buildZip, describePlan, findSevenZip, resolveOnPath, runSevenZip, sevenZipArgs,
} from "../src/lib/export-archive";
import { VSCODE_DOWNLOAD, findVsCode, vsCodeCandidates } from "../src/lib/open-in-vscode";
import {
  describe as describeBulk, execute, invert, plan, selectAll, selectRange, toggle,
  type BulkItem,
} from "../src/lib/bulk-actions";
import { removeTempDir } from "./helpers/temp-dir";

const SAMPLE: ExportInput = {
  name: "usage",
  rows: [
    { id: 1, model: "gpt-5", ok: true, cost: 0.25, tags: ["a", "b"], note: null },
    { id: 2, model: 'he said "hi", then left', ok: false, cost: 1.5, tags: [], note: "x" },
  ],
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ocx-export-")); });
afterEach(() => { removeTempDir(dir); });

describe("every format writes something", () => {
  test("all of them produce a non-empty document and a sane filename", () => {
    for (const format of EXPORT_FORMATS) {
      const text = serialize(SAMPLE, format);
      expect(text.length, `${format} wrote nothing`).toBeGreaterThan(0);
      expect(filenameFor("usage", format)).toBe(`usage.${FORMAT_META[format].extension}`);
    }
  });

  test("a filename cannot escape its directory, or hide itself", () => {
    // No separator survives, so the name cannot steer the write anywhere.
    const escaped = filenameFor("../../etc/passwd", "json");
    expect(escaped).toBe("etc-passwd.json");
    expect(escaped).not.toContain("/");
    expect(escaped).not.toContain("\\");
    // And a leading dot is stripped: `.env` must not export as a dotfile the
    // user's file manager then hides from them.
    expect(filenameFor(".env", "json")).toBe("env.json");
    expect(filenameFor("", "json")).toBe("export.json");
  });

  test("ragged records still export every column", () => {
    const ragged: ExportInput = { name: "r", rows: [{ a: 1 }, { b: 2 }] };
    expect(columnsOf(ragged.rows)).toEqual(["a", "b"]);
    expect(serialize(ragged, "csv")).toContain("a,b");
  });
});

describe("the machine-readable formats round-trip", () => {
  test("JSON and JSONL come back identical", () => {
    expect(JSON.parse(serialize(SAMPLE, "json"))).toEqual(SAMPLE.rows);
    const lines = serialize(SAMPLE, "jsonl").trim().split("\n").map(line => JSON.parse(line));
    expect(lines).toEqual(SAMPLE.rows);
  });

  test("CSV quotes what RFC 4180 requires", () => {
    const csv = serialize(SAMPLE, "csv");
    // The value contains both a comma and a double quote.
    expect(csv).toContain(`"he said ""hi"", then left"`);
    expect(csv.split("\n")[0]).toBe("id,model,ok,cost,tags,note");
  });

  test("SQL infers a type per column and leaves NULL unquoted", () => {
    const sql = serialize(SAMPLE, "sql");
    expect(sql).toContain(`"id" INTEGER`);
    expect(sql).toContain(`"cost" REAL`);
    expect(sql).toContain(`"ok" BOOLEAN`);
    // A double quote inside a single-quoted SQL string needs no escaping, and
    // doubling it would corrupt the value. Only the single quote does.
    expect(sql).toContain(`'he said "hi", then left'`);
    expect(sql).toContain("NULL");
  });

  test("SQL doubles the single quote that would end the string", () => {
    const sql = serialize({ name: "t", rows: [{ v: "O'Brien" }] }, "sql");
    expect(sql).toContain(`'O''Brien'`);
  });

  test("XML escapes markup rather than emitting it", () => {
    const xml = serialize({ name: "x", rows: [{ v: "<script>&</script>" }] }, "xml");
    expect(xml).toContain("&lt;script&gt;&amp;&lt;/script&gt;");
    expect(xml).not.toContain("<script>");
  });

  test("Markdown cells cannot break the table", () => {
    const md = serialize({ name: "m", rows: [{ v: "a|b\nc" }] }, "markdown");
    expect(md).toContain("a\\|b c");
  });

  test("Python gets Python literals, not JSON ones", () => {
    const py = serialize({ name: "p", rows: [{ a: null, b: true }] }, "py");
    expect(py).toContain("None");
    expect(py).toContain("True");
    expect(py).not.toContain("null");
  });

  test("JSON Schema describes the shape and writes no rows", () => {
    const schema = JSON.parse(serialize(SAMPLE, "json-schema"));
    expect(schema.type).toBe("array");
    expect(schema.items.properties.id).toEqual({ type: "integer" });
    // `note` is null in one row, so it is nullable and not required.
    expect(schema.items.properties.note.type).toContain("null");
    expect(schema.items.required).not.toContain("note");
    expect(JSON.stringify(schema)).not.toContain("gpt-5");
  });
});

describe("fidelity is declared before the export runs", () => {
  test("the lossless formats claim nothing they cannot keep", () => {
    for (const format of ["json", "jsonl", "yaml"] as const) {
      expect(describeFidelity(SAMPLE, format)).toEqual({ level: "full", losses: [] });
    }
  });

  test("CSV names the nested column rather than flattening it quietly", () => {
    const fidelity = describeFidelity(SAMPLE, "csv");
    expect(fidelity.level).toBe("lossy");
    expect(fidelity.losses.join(" ")).toContain("tags");
  });

  test("TOML says which key it will drop, and drops it exactly where it is null", () => {
    const fidelity = describeFidelity(SAMPLE, "toml");
    expect(fidelity.level).toBe("lossy");
    expect(fidelity.losses.join(" ")).toContain("note");

    // The claim and the behaviour have to agree — and the claim is about null
    // specifically, not about the column. Row 1 has `note: null` and loses it;
    // row 2 has `note: "x"` and keeps it. Asserting the column never appears
    // would be asserting a bug.
    const tables = serialize(SAMPLE, "toml").split("[[usage]]").filter(Boolean);
    expect(tables).toHaveLength(2);
    expect(tables[0]).not.toContain("note =");
    expect(tables[1]).toContain(`note = "x"`);
  });

  test("a schema is honest that it carries no data at all", () => {
    expect(describeFidelity(SAMPLE, "json-schema").level).toBe("impossible");
  });

  test("flat data is not accused of losing anything it has not got", () => {
    const flat: ExportInput = { name: "f", rows: [{ a: 1, b: "x" }] };
    expect(describeFidelity(flat, "csv").losses.join(" ")).not.toContain("nested");
  });
});

describe("ZIP", () => {
  test("refuses a path that would escape extraction", () => {
    expect(() => assertSafePath("../evil")).toThrow();
    expect(() => assertSafePath("/etc/passwd")).toThrow();
    expect(() => assertSafePath("C:/win")).toThrow();
    expect(() => assertSafePath("a\\b")).toThrow();
    expect(() => assertSafePath("fine/here.json")).not.toThrow();
  });

  test("has the signatures and the entry count a ZIP reader looks for", () => {
    const zip = buildZip([
      { path: "a.json", data: new TextEncoder().encode('{"a":1}') },
      { path: "nested/b.csv", data: new TextEncoder().encode("a,b\n1,2\n") },
    ], 1_700_000_000_000);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);              // local header
    const eocd = zip.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);           // end of central directory
    expect(view.getUint16(eocd + 10, true)).toBe(2);               // two entries
  });

  test("is byte-identical for the same input, which is what makes it checkable", () => {
    const entries = [{ path: "a.txt", data: new TextEncoder().encode("hello") }];
    expect(buildZip(entries, 1_700_000_000_000)).toEqual(buildZip(entries, 1_700_000_000_000));
  });

  // The assertion that actually matters: a real archiver can read it back.
  // `findSevenZip` now returns a resolved absolute path or null, so this is a
  // genuine "is it installed" check rather than a bare name that always looked
  // present.
  const sevenZip = findSevenZip();
  const haveRealSevenZip = !!sevenZip && existsSync(sevenZip);

  test.skipIf(!haveRealSevenZip)("7-Zip can list and extract what we wrote", () => {
    const payload = '{"round":"trip"}';
    const zip = buildZip([{ path: "deep/inside.json", data: new TextEncoder().encode(payload) }]);
    const file = join(dir, "out.zip");
    writeFileSync(file, zip);

    const listed = spawnSync(sevenZip!, ["l", file], { encoding: "utf-8" });
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain("inside.json");

    const out = join(dir, "x");
    mkdirSync(out, { recursive: true });
    const extracted = spawnSync(sevenZip!, ["x", file, `-o${out}`, "-y"], { encoding: "utf-8" });
    expect(extracted.status).toBe(0);
    expect(readFileSync(join(out, "deep", "inside.json"), "utf-8")).toBe(payload);
  });
});

describe("7z options", () => {
  test("a password encrypts the FILE NAMES too, by default", () => {
    // 7-Zip's own default is off. This inverts it, and that inversion is the
    // difference between "encrypted" being true and being nearly true.
    const args = sevenZipArgs("out.7z", { password: "hunter2" });
    expect(args).toContain("-mhe=on");
  });

  test("headers can be left in the clear, but only by asking", () => {
    const args = sevenZipArgs("out.7z", { password: "hunter2", encryptHeaders: false });
    expect(args).not.toContain("-mhe=on");
  });

  test("no password means no encryption flags at all", () => {
    const args = sevenZipArgs("out.7z", {});
    expect(args.some(arg => arg.startsWith("-p"))).toBe(false);
    expect(args).not.toContain("-mhe=on");
  });

  test("every documented knob reaches the command line", () => {
    const args = sevenZipArgs("out.7z", {
      method: "PPMd", level: 9, dictionarySize: "64m", wordSize: 273,
      solid: "4g", multithread: 8, volumeSize: "100m",
    });
    expect(args).toContain("-m0=PPMd");
    expect(args).toContain("-mx=9");
    expect(args).toContain("-md=64m");
    expect(args).toContain("-mfb=273");
    expect(args).toContain("-ms=4g");
    expect(args).toContain("-mmt=8");
    expect(args).toContain("-v100m");
  });

  test("solid off is a real setting, not an omission", () => {
    expect(sevenZipArgs("o.7z", { solid: false })).toContain("-ms=off");
    expect(sevenZipArgs("o.7z", { solid: true })).toContain("-ms=on");
  });
});

describe("the plan is stated before the archive is built", () => {
  test("an unencrypted-header 7z says the names are readable", () => {
    const notes = describePlan("7z", { password: "x", encryptHeaders: false }, "/usr/bin/7z").notes.join(" ");
    expect(notes).toContain("file names stay readable");
  });

  test("a fully encrypted 7z says both are covered", () => {
    const notes = describePlan("7z", { password: "x" }, "/usr/bin/7z").notes.join(" ");
    expect(notes).toContain("contents and the file names");
  });

  test("a ZIP asked for a password is told plainly that it will not be encrypted", () => {
    const notes = describePlan("zip", { password: "x" }).notes.join(" ");
    expect(notes).toContain("NOT encrypted");
  });

  test("no 7-Zip is a blocked plan, not a silent fall back to ZIP", () => {
    const blocked = describePlan("7z", {}, null);
    expect(blocked.blocked).toBeTruthy();
    expect(blocked.blocked).toContain("ZIP is not encrypted");
  });

  test("a bare command is only accepted when it really is on PATH", () => {
    // The bug this pins: returning the bare name unchecked made `findSevenZip`
    // claim success on a machine with no 7-Zip, and the failure then surfaced as
    // a spawn error at the moment somebody pressed Export.
    expect(findSevenZip(["definitely-not-a-real-binary-xyz"], { PATH: dir })).toBeNull();
    expect(resolveOnPath("definitely-not-a-real-binary-xyz", { PATH: dir })).toBeNull();

    // And it does resolve one that is there. Compared case-insensitively: the
    // extension comes from PATHEXT, which is conventionally upper case, while
    // the file on disk is lower — Windows resolves either, and the spawn only
    // needs a path that exists.
    const name = process.platform === "win32" ? "probe.cmd" : "probe";
    writeFileSync(join(dir, name), "");
    const resolved = resolveOnPath("probe", { PATH: dir, PATHEXT: ".CMD" });
    expect(resolved).toBeTruthy();
    expect(resolved!.toLowerCase()).toBe(join(dir, name).toLowerCase());
    expect(existsSync(resolved!)).toBe(true);
  });

  test("running 7z without 7-Zip fails honestly", async () => {
    const result = await runSevenZip(dir, join(dir, "a.7z"), {}, null);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not installed");
  });
});

describe("VS Code", () => {
  test("looks on PATH first, then the platform's usual homes", () => {
    const win = vsCodeCandidates("win32");
    expect(win[0].command).toBe("code");
    expect(win.some(c => c.command.includes("Insiders"))).toBe(true);
    expect(vsCodeCandidates("darwin").some(c => c.command.includes("Visual Studio Code.app"))).toBe(true);
  });

  test("a machine without it gets the download, not another editor", () => {
    const lookup = findVsCode([{ command: "definitely-not-installed-xyz", label: "VS Code" }], () => false);
    expect(lookup.found).toBe(false);
    expect(lookup.downloadUrl).toBe(VSCODE_DOWNLOAD);
    expect(lookup.message).toContain("not found");
  });

  test("a command on PATH is accepted when the probe confirms it", () => {
    const lookup = findVsCode([{ command: "code", label: "Visual Studio Code" }], command => command === "code");
    expect(lookup.found).toBe(true);
    expect(lookup.command).toBe("code");
  });
});

describe("bulk actions", () => {
  const items: BulkItem<{ pinned?: boolean }>[] = [
    { id: "a", label: "Alpha", value: {} },
    { id: "b", label: "Beta", value: { pinned: true } },
    { id: "c", label: "Gamma", value: {} },
  ];
  const closeTabs = {
    id: "close",
    label: "Close",
    destructive: true,
    skip: (item: BulkItem<{ pinned?: boolean }>) => (item.value.pinned ? "pinned" : null),
  };

  test("skips are separated from affected, with a reason", () => {
    const result = plan(closeTabs, items);
    expect(result.affected.map(i => i.id)).toEqual(["a", "c"]);
    expect(result.skipped).toEqual([{ id: "b", label: "Beta", reason: "pinned" }]);
  });

  test("the sentence names the count, the scope and the exclusions", () => {
    const text = describeBulk(plan(closeTabs, items, "matching"));
    expect(text).toContain("2 item(s) matching the current search");
    expect(text).toContain("1 excluded (pinned)");
  });

  test("an empty selection is said, not run", () => {
    const empty = plan(closeTabs, []);
    expect(empty.requiresConfirmation).toBe(false);
    expect(describeBulk(empty)).toContain("nothing selected");
  });

  test("a selection that is entirely skipped does not ask for confirmation", () => {
    const allSkipped = plan(closeTabs, [items[1]]);
    expect(allSkipped.requiresConfirmation).toBe(false);
    expect(describeBulk(allSkipped)).toContain("all 1 selected item(s) are excluded");
  });

  test("a half-failed run reports both halves rather than claiming success", async () => {
    const result = await execute(plan(closeTabs, items), async item => {
      if (item.id === "c") throw new Error("in use");
    });
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.summary).toBe("Close: 1 succeeded, 1 failed, 1 skipped.");
    expect(result.outcomes.find(o => o.id === "c")?.error).toBe("in use");
  });

  test("cancelling reports what was not attempted", async () => {
    let done = 0;
    const result = await execute(
      plan({ id: "x", label: "Export" }, items),
      async () => { done += 1; },
      { isCancelled: () => done >= 1 },
    );
    expect(result.cancelled).toBe(true);
    expect(result.summary).toContain("not attempted (cancelled)");
  });

  test("selection: toggle, shift-range and invert", () => {
    const order = ["a", "b", "c", "d"];
    expect([...toggle(new Set<string>(), "b")]).toEqual(["b"]);
    expect([...toggle(new Set(["b"]), "b")]).toEqual([]);
    // A range adds to what is already selected rather than replacing it.
    expect([...selectRange(new Set(["d"]), order, "a", "c")].sort()).toEqual(["a", "b", "c", "d"]);
    expect([...selectRange(new Set<string>(), order, "c", "a")].sort()).toEqual(["a", "b", "c"]);
    expect([...selectAll(order)]).toEqual(order);
    expect([...invert(new Set(["a", "c"]), order)]).toEqual(["b", "d"]);
  });
});
