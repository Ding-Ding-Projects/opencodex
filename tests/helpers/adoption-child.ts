import { writeFileSync } from "node:fs";
import { adoptPreSubstrateHome } from "../../src/codex/adoption";

const resultPath = process.env.OCX_ADOPTION_RESULT;
const databasePath = process.env.OCX_ADOPTION_DATABASE;
if (!resultPath || !databasePath) process.exit(2);

const result = adoptPreSubstrateHome({
  databasePath,
  residue: "routed",
  intent: { kind: "retained-apply", operation: "apply-opencodex" },
});
writeFileSync(resultPath, JSON.stringify({ kind: result.kind, reason: "reason" in result ? result.reason : undefined }));
