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
const CONTRACT_ROW = /^\| .*? \| `(present|partial|absent|n\/a)` \|/;
const SLICE_HEADING = /^## Slice (\d+)/;
const SLICE_SUMMARY = /^\| (\d)\. .*?\| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \|$/;
const TOTAL_ROW = /^\| \*\*Total\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \|$/;
const HEADER = /^\*\*(\d+) contracts\. (\d+) complete, (\d+) partial, (\d+) absent, (\d+) not applicable\.\*\*$/;

function readCounts() {
  const lines = readFileSync(INVENTORY, "utf8").split(/\r?\n/);
  const perSlice = new Map<number, Tally>();
  const overall = zero();
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
      const status = row[1] as Status;
      perSlice.get(slice)![status] += 1;
      overall[status] += 1;
    }
  }
  return { lines, perSlice, overall };
}

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

  const stated = WORDS.findIndex(w => sentence!.startsWith(`That is 17% done. ${w} row`));
  expect(
    stated,
    `the sentence does not open with a recognised count word: ${sentence!.slice(0, 80)}`,
  ).toBeGreaterThanOrEqual(0);
  expect(stated, "the prose absent count disagrees with the absent rows").toBe(overall.absent);
});
