import { expect, test } from "bun:test";
import { multiAgentGuidanceText } from "../src/server/responses/collaboration";

test("v2 guidance keeps full-history fork overrides rejected in this runtime", async () => {
  const parsed = {
    modelId: "gpt-5.6-sol",
    context: { messages: [], tools: [{ name: "spawn_agent" }, { name: "send_message" }] },
    stream: false,
    options: { reasoning: "high" },
  } as any;
  const text = await multiAgentGuidanceText(parsed, {
    injectionModel: "gpt-5.6-luna",
    injectionEffort: "high",
    multiAgentGuidanceEnabled: true,
  }, {
    resolveEffectiveSubagentRoster: async () => ({ candidates: [{ model: "gpt-5.6-luna", efforts: ["high"] }], advertised: [{ model: "gpt-5.6-luna", efforts: ["high"] }], excluded: [] }),
  });
  expect(text).toContain("fork_turns to \"none\"");
  expect(text).toContain("full-history forks reject overrides");
  expect(text).not.toContain("full-history forks accept overrides");
});
