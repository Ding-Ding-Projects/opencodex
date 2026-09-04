/**
 * The feature inventory has to be able to do arithmetic about itself.
 *
 * Three times in one session a lane moved a contract's status cell from
 * `absent` to `partial` and left the per-slice summary table, the grand total,
 * and the header line saying the old thing. It is an easy mistake to make and a
 * hard one to see: the row you edited is correct, the summary is forty lines
 * away, and every number in the file still *looks* like a number. Two of the
 * three were caught by counting the cells by script and one only after a merge
 * had already carried the disagreement forward.
 *
 * That matters more here than in most files, because this one exists purely to
 * be trusted about counts. `docs/FEATURE-INVENTORY.md` is the authority on what
 * is built and what is not; a reader who finds its own totals contradicting its
 * own rows has no reason to believe any other figure in it. A summary that is
 * merely *merged* rather than *recomputed* is a summary that is quietly wrong.
 *
 * So this derives every number from the status cells and compares. It never
 * rewrites the file: a mismatch is a real editing mistake and the human should
 * see which direction it went.
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INVENTORY = join(import.meta.dir, "..", "docs", "FEATURE-INVENTORY.md");

type Status = "present" | "partial" | "absent" | "n/a";
type Tally = Record<Status, number>;

const zero = (): Tally => ({ present: 0, partial: 0, absent: 0, "n/a": 0 });

/**
 * A contract row, not any row. The status cell is the second column and is
 * always a backticked keyword, which the summary rows (plain integers) and the
 * vocabulary legend (its keyword sits in the *first* column) cannot match.
 */
const CONTRACT_ROW = /^\| ([^|]+?) \| `(present|partial|absent|n\/a)` \|/;
const SLICE_HEADING = /^## Slice (\d+)/;
const SLICE_SUMMARY = /^\| (\d)\. .*?\| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \|$/;
const TOTAL_ROW = /^\| \*\*Total\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \|$/;
const HEADER = /^\*\*(\d+) contracts\. (\d+) complete, (\d+) partial, (\d+) absent, (\d+) not applicable\.\*\*$/;

/**
 * The canonical list is deliberately hand-written. Deriving it from rows that
 * remain in the document would let a deleted row disappear from both the input
 * and the expectation. Exact names also make a rename fail: a descendant name,
 * comment, or old name embedded inside a longer label cannot satisfy the list.
 */
const EXPECTED_CONTRACTS = [
  "Three language modes: English, playful Hong Kong Cantonese, bilingual",
  "Two funny-level sliders, 1–5, independent per language, wired to rendered copy",
  'Persisted "Show emojis in dialogs and message boxes" toggle',
  "School mode: universal, renamable, one shared cross-app record, live propagation, PIN/passkey unlock",
  "TTS narrator: off by default, serialized supersede-not-stack queue, English / Cantonese / Both",
  "Narrator voice selection per narrated language, with rate and pitch",
  "Local personal-vocabulary JSON upload, always visible before a file exists",
  "A usable regex builder in the primary interface, naming its engine and dialect",
  "Every search bar carries the full builder anchored beside it, plain text default, flags round-tripping",
  "Every settings, preferences and properties surface carries its own search wired to that builder",
  "Every dropdown — select, combobox, picker, autocomplete, menu button, overflow list — carries a filter with its own builder",
  "Every right-click / context menu carries a filter with its own builder",
  "Command palette on `Ctrl+Shift+F`, indexing commands, pages, settings and appearance controls, with live rich rows and teleport",
  "Rich controls preferred app-wide wherever a value is shown",
  "Settings explain themselves behind progressive disclosure, with a truthful default-provenance line, guarded by a hand-written list",
  "Browser-style tabbed navigation, strip dockable to any edge, left the default",
  "Overflow surface, reordering, pinning, persistence of order / pins / groups / collapsed state",
  "Tab groups: create, name, colour, reorder, collapse, move between, per-group appearance",
  "All four tab-discovery searches: current strip, inside each group, groups by name, master across every open tab",
  "Move-into-group as an anchored picker, never a dynamic list inlined into a context menu",
  "Bulk close: containing text and not containing text, with preview, count, pinned excluded by default",
  "Settings surfaces are themselves tabbed, carrying the whole tab feature set",
  "Right-click menus display the keyboard shortcut for every item that has one",
  "Full Material Design 3 conformance with no legacy chrome",
  "Persisted runtime appearance: theme, density, accent/seed, full font customization with live preview and CJK-safe fallback",
  "Per-element appearance editor for every rendered element, from its context menu and a keyboard equivalent, anchored beside it",
  "Word-depth typography: variable axes, underline styles with colour and thickness, small caps, spacing, baseline, shadow/outline",
  "Infinite colour picker with a translator across 14 spaces, alpha preserved, gamut and contrast reported",
  "The pickers and editors are themselves customizable",
  "Named presets and user themes, exportable and importable as a file",
  "The app is user-renamable, display-only, never moving data directories or package identity",
  "App-logo customization: shipped presets plus a local custom image, converted locally, never touching installed identity",
  "Local git-backed version history for every user-managed record, restore recorded as a new revision",
  "History panel filterable by an advanced date picker and by real action, composing with regex search",
  "Secret and display-name mutation history in a password-protected manager, encrypted or redacted, no plaintext secrets",
  "Export everything, in every format that can faithfully represent it",
  "Archive export as ZIP or 7z with every 7z option, AES-256 and encrypted headers",
  "Bulk actions on every list, table, grid and collection, including the notification centre and history",
  "Changelog viewer over every version, with date filter, regex search, copy and export, and a commit link on every entry",
  "External editor handoff: everything exportable opens in VS Code from the app",
  "Destructive-action super confirmation: two independent keys, full-range slider, progress and completion animation, emergency exit",
  "Non-blocking notifications: corner-anchored, stacking, auto-dismissing except errors **and warnings**, with a reviewable centre",
  "No nagging: no unsolicited payment, donation, sponsorship, review or upgrade prompts",
  "Password or TOTP toy locks on every rendered element, each with its own credential and anchored wizard",
  "Support Tickets: the joke recovery desk that opens the application-data folder and says nothing is sent anywhere",
  "TOTP registration: locally rendered QR encoding an `otpauth://` URI, manual secret beside it, confirmation before the factor arms",
  "Built-in authenticator: arbitrary TOTP entries, live codes with countdown and next-code peek, searchable list, RFC 6238 vectors, clock skew",
  "Guided forms: populated pickers, a native browse control beside every path field, inline plain-words validation, disabled controls naming their condition",
  "Material 3 landing page carrying every rule that applies to a user-facing surface",
  "Documentation site where every feature has its own article ending in suggested further articles",
  "The documentation site independently implements the **entire** universal contract, guarded by a list that fails the build",
  "Mobile friendly from ~320px, no horizontal body scroll, wide content scrolling inside its own container",
  "In-app offline documentation browser: articles bundled at build time, shared renderer, in-app links, its own search, build-failing completeness check",
  "Overlays paint their own surface and stay viewport-bounded; panels resizable, floating panels draggable, geometry persisted",
  "Provider-authored text rendered through one shared isolated renderer, never printed as raw markup",
  "Long operations report real progress where they were started, disable the submitting control, and refuse re-entry in the handler",
  "Universal file converter with a categorized adapter catalogue and an unlimited resumable queue",
  "PDF tools: inspect, split, merge, extract, reorder, rotate, metadata, with post-write reopen validation",
  "Local Ollama suite manager: exhaustive catalogue, evidence-backed fit verdicts, batch pull cart, chat, allowlisted harness launch",
  "Browser-extension download capture: Start dialog, separate Downloading surface, always-on-top completion",
  "Scheduled settings: rules over date, time and weekday driving language, theme, density and every other appearance value",
  "External settings sources: a validated versioned HTTPS API and a Home Assistant boolean entity per rule",
  "Publishing to a forge with real multi-account sign-in and an account/owner picker",
  "`build.bat` and `build-installer.bat` at the repository root: touchless, silent mode, honest reporting, idempotent",
  "Every release states the project's line count, broken down, counted by CI, with agent-versus-human attribution",
] as const;

function readCounts() {
  const lines = readFileSync(INVENTORY, "utf8").split(/\r?\n/);
  const perSlice = new Map<number, Tally>();
  const overall = zero();
  const contracts: Array<{ name: string; status: Status; slice: number }> = [];
  let slice = 0;

  for (const line of lines) {
    const heading = SLICE_HEADING.exec(line);
    if (heading) {
      slice = Number(heading[1]);
      if (!perSlice.has(slice)) perSlice.set(slice, zero());
      continue;
    }
    const row = CONTRACT_ROW.exec(line);
    if (row && slice) {
      const status = row[2] as Status;
      contracts.push({ name: row[1], status, slice });
      perSlice.get(slice)![status] += 1;
      overall[status] += 1;
    }
  }
  return { lines, perSlice, overall, contracts };
}

test("the exact hand-written canonical contract list is present once and in order", () => {
  const { contracts } = readCounts();
  const names = contracts.map(contract => contract.name);

  expect(EXPECTED_CONTRACTS).toHaveLength(65);
  expect(new Set(EXPECTED_CONTRACTS).size, "the expected contract list contains a duplicate").toBe(65);
  expect(new Set(names).size, "the inventory contains a duplicate canonical contract row").toBe(65);
  expect(names, "a canonical contract is missing, renamed, duplicated, or out of order").toEqual(
    EXPECTED_CONTRACTS,
  );
});

test("every per-slice summary row matches the status cells in that slice", () => {
  const { lines, perSlice } = readCounts();
  const seen: number[] = [];

  for (const line of lines) {
    const m = SLICE_SUMMARY.exec(line);
    if (!m) continue;
    const slice = Number(m[1]);
    seen.push(slice);
    const counted = perSlice.get(slice);
    expect(counted, `slice ${slice} has a summary row but no contract rows`).toBeDefined();

    const claimed = { present: +m[2], partial: +m[3], absent: +m[4], "n/a": +m[5] } as Tally;
    expect(claimed, `slice ${slice} summary disagrees with its own rows`).toEqual(counted!);
    // The row's own total column has to add up too, which is a different
    // mistake from the one above and has to be checked separately.
    expect(+m[6], `slice ${slice} total column`).toBe(
      counted!.present + counted!.partial + counted!.absent + counted!["n/a"],
    );
  }

  // Guard the guard: a summary table that lost a row entirely would otherwise
  // pass, because every row it still has would agree.
  expect(seen.sort((a, b) => a - b), "a slice has contract rows but no summary row").toEqual(
    [...perSlice.keys()].sort((a, b) => a - b),
  );
});

test("the grand total and the header line both match the real counts", () => {
  const { lines, overall } = readCounts();
  const sum = overall.present + overall.partial + overall.absent + overall["n/a"];

  const totalLine = lines.find(l => TOTAL_ROW.test(l));
  expect(totalLine, "no **Total** row found").toBeDefined();
  const t = TOTAL_ROW.exec(totalLine!)!;
  expect(
    { present: +t[1], partial: +t[2], absent: +t[3], "n/a": +t[4] },
    "the Total row disagrees with the status cells",
  ).toEqual(overall);
  expect(+t[5], "the Total row's own sum").toBe(sum);

  const headerLine = lines.find(l => HEADER.test(l));
  expect(headerLine, "no '**N contracts. ...**' header line found").toBeDefined();
  const h = HEADER.exec(headerLine!)!;
  expect(
    { total: +h[1], present: +h[2], partial: +h[3], absent: +h[4], "n/a": +h[5] },
    "the header line disagrees with the status cells",
  ).toEqual({ total: sum, present: overall.present, partial: overall.partial, absent: overall.absent, "n/a": overall["n/a"] });
});

test("the prose sentence naming the absent count agrees with the absent rows", () => {
  const { lines, overall } = readCounts();
  const WORDS = [
    "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen",
    "Nineteen", "Twenty",
  ];
  // The one sentence in the preamble that states the absent count in words. It
  // drifted twice while the tables were being kept correct, which is its own
  // lesson: a number spelled out reads as prose and stops being audited.
  //
  // Anchored to the STABLE PREFIX rather than to the clause after the count.
  // That clause has legitimately changed shape twice as the number fell —
  // "Four rows … have no code behind them", then "One row … has no code behind
  // it", then "Zero rows are `absent`" — because English number agreement and
  // the natural phrasing for none are not the test's business. Matching on the
  // trailing wording made this guard fail on prose that was correct, which is
  // the worst failure mode a guard has: it cries wolf and gets edited away.
  const sentence = lines.find(l => /^That is \d+% done\. /.test(l));
  expect(sentence, "the 'have no code behind them' sentence is missing").toBeDefined();

  const completePercent = Math.round(
    (overall.present / (overall.present + overall.partial + overall.absent)) * 100,
  );
  const prefix = `That is ${completePercent}% done. `;
  expect(sentence!.startsWith(prefix), "the prose completion percentage disagrees with the rows").toBe(true);

  const stated = WORDS.findIndex(w => sentence!.startsWith(`${prefix}${w} row`));
  expect(
    stated,
    `the sentence does not open with a recognised count word: ${sentence!.slice(0, 80)}`,
  ).toBeGreaterThanOrEqual(0);
  expect(stated, "the prose absent count disagrees with the absent rows").toBe(overall.absent);
});
