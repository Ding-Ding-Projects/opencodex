/**
 * Release line-count attribution arithmetic.
 *
 * The exact numbers deliberately are not pinned: every surviving source edit
 * changes them. These tests pin the release contract instead. The attribution
 * columns must reconcile with the existing non-blank line counter, generated
 * and excluded material must remain visible, and the rendered Markdown must be
 * ready to paste into release notes without another hand-maintained total.
 */

import { describe, expect, test } from "bun:test";
import { countLines } from "../scripts/count-lines";
import {
  EXCLUDED_AGENT_LOOKALIKES,
  KNOWN_AGENT_IDENTITIES,
  countLinesWithAttribution,
  formatLineAttributionTable,
  isAgentAttribution,
} from "../scripts/line-attribution";

const counted = countLines();
const attributed = countLinesWithAttribution();

describe("release line attribution", () => {
  test("keeps the release-ready row and table shape", () => {
    expect(attributed.rows.length).toBeGreaterThan(0);
    for (const row of attributed.rows) {
      expect(Object.keys(row).sort()).toEqual([
        "agent",
        "files",
        "name",
        "nonBlank",
        "people",
        "total",
      ]);
    }

    const table = formatLineAttributionTable(attributed);
    expect(table).toStartWith("| Area | Files | Lines | Non-blank | Agent | People |");
    expect(table).toContain("| **Project total (counted text)** |");
    expect(table).toContain("| **Grand total (tracked files)** |");
    expect(table).toContain("Surviving physical lines attributed with `git blame`");
    expect(table).toContain(attributed.revision);
  });

  test("keeps generated and excluded material explicit", () => {
    expect(attributed.rows.some(row => row.name.startsWith("Generated"))).toBe(true);
    expect(attributed.excluded.assets).toBe(counted.assets);
    expect(attributed.excluded.unreadable).toBe(counted.unreadable);

    const table = formatLineAttributionTable(attributed);
    expect(table).toContain("Excluded from line attribution");
    expect(table).toContain(`${attributed.excluded.assets.toLocaleString("en-US")} tracked assets`);
    expect(table).toContain("| Excluded — binary assets |");
    expect(table).toContain("| Excluded — unreadable text |");
  });

  test("agent and people attribution equals every surviving physical line", () => {
    for (const row of attributed.rows) {
      expect({
        area: row.name,
        attributed: row.agent + row.people,
        survivingLines: row.total,
      }).toEqual({
        area: row.name,
        attributed: row.total,
        survivingLines: row.total,
      });
    }

    expect(attributed.totals.agent + attributed.totals.people).toBe(attributed.totals.total);
  });

  test("attribution cannot drift from the committed line counter", () => {
    const summed = attributed.rows.reduce(
      (sum, row) => ({
        files: sum.files + row.files,
        total: sum.total + row.total,
        nonBlank: sum.nonBlank + row.nonBlank,
        agent: sum.agent + row.agent,
        people: sum.people + row.people,
      }),
      { files: 0, total: 0, nonBlank: 0, agent: 0, people: 0 },
    );

    expect(summed).toEqual(attributed.totals);
    expect(attributed.totals.files).toBe(counted.totals.files);
    expect(attributed.totals.total).toBe(counted.totals.total);
    expect(attributed.totals.nonBlank).toBe(counted.totals.code);
    expect(attributed.rows.map(row => row.name)).toEqual(counted.rows.map(row => row.name));
  });

  test("uses exact author and co-author identities without fuzzy look-alikes", () => {
    const claude = KNOWN_AGENT_IDENTITIES.find(identity => identity.name === "Claude Fable 5")!;
    const codex = KNOWN_AGENT_IDENTITIES.find(identity => identity.name === "OpenAI Codex")!;
    expect(isAgentAttribution(
      { name: `  ${claude.name.replace(" ", "   ")} `, email: claude.email.toUpperCase() },
      [],
    )).toBe(true);
    expect(isAgentAttribution(
      { name: "A Person", email: "person@example.test" },
      [codex],
    )).toBe(true);
    for (const lookalike of EXCLUDED_AGENT_LOOKALIKES) {
      expect(isAgentAttribution(lookalike, [])).toBe(false);
    }
  });
});
