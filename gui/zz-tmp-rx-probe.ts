import { evaluate, capPattern, PATTERN_CAP, SAMPLE_CAP } from "./src/regex/engine";

// The kind of sample the Logs screen really hands the popover: 40 real rows.
const sample = Array.from(
  { length: 40 },
  (_, i) => `2026-07-30 POST /v1/messages 200 ${"a".repeat(24)} row${i}`,
).join("\n");
console.log("sample length:", sample.length, "(SAMPLE_CAP is", SAMPLE_CAP + ")");

for (const pattern of ["(a+)+$", "(\\w+\\s?)+$"]) {
  console.log(`pattern ${JSON.stringify(pattern)} length ${pattern.length}; survives capPattern (cap ${PATTERN_CAP}):`,
    capPattern(pattern) === pattern);
  const t0 = Date.now();
  const r = evaluate(pattern, "i", sample);
  console.log("  evaluate() returned after", Date.now() - t0, "ms; rows:", r.rows.length, "error:", r.error);
}
