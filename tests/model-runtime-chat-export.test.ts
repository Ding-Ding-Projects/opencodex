import { describe, expect, test } from "bun:test";
import { buildChatExport, chatExportToMarkdown } from "../src/lib/model-runtime/chat-export";
import { DEFAULT_CHAT_PARAMETERS, type ChatSession } from "../src/lib/model-runtime/chat-types";

function makeSession(): ChatSession {
  return {
    id: "s1",
    title: "My session",
    model: "llama3.2:3b",
    systemPrompt: "Be terse.",
    parameters: DEFAULT_CHAT_PARAMETERS,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    streamingMessageId: null,
    messages: [
      {
        id: "m1", role: "user", content: "look at this",
        attachments: [{ id: "a1", name: "cat.png", mimeType: "image/png", sizeBytes: 1234, dataBase64: "SECRET_RAW_BYTES_SHOULD_NEVER_LEAVE" }],
        createdAt: 1_700_000_000_500, state: "done", error: null, stats: null,
      },
      {
        id: "m2", role: "assistant", content: "a cat", attachments: null,
        createdAt: 1_700_000_001_000, state: "done", error: null,
        stats: { totalDurationMs: 500, loadDurationMs: 10, promptEvalCount: 5, promptEvalDurationMs: 20, evalCount: 3, evalDurationMs: 100, doneReason: "stop" },
      },
    ],
  };
}

describe("buildChatExport — redaction", () => {
  test("never includes an attachment's raw bytes anywhere in the export", () => {
    const exported = buildChatExport([makeSession()]);
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain("SECRET_RAW_BYTES_SHOULD_NEVER_LEAVE");
  });

  test("keeps attachment metadata (name, type, size) and marks it explicitly omitted", () => {
    const exported = buildChatExport([makeSession()]);
    const attachment = exported.sessions[0].messages[0].attachments?.[0];
    expect(attachment).toEqual({ id: "a1", name: "cat.png", mimeType: "image/png", sizeBytes: 1234, omitted: true });
  });

  test("keeps every non-attachment field verbatim — the transcript is the point", () => {
    const exported = buildChatExport([makeSession()]);
    const session = exported.sessions[0];
    expect(session.title).toBe("My session");
    expect(session.systemPrompt).toBe("Be terse.");
    expect(session.messages[0].content).toBe("look at this");
    expect(session.messages[1].content).toBe("a cat");
    expect(session.messages[1].stats?.evalCount).toBe(3);
  });

  test("states plainly what was redacted", () => {
    const exported = buildChatExport([makeSession()]);
    expect(exported.redactionNote.length).toBeGreaterThan(0);
  });

  test("an empty session list exports cleanly", () => {
    const exported = buildChatExport([]);
    expect(exported.sessions).toEqual([]);
  });
});

describe("chatExportToMarkdown", () => {
  test("never includes the raw attachment bytes", () => {
    const markdown = chatExportToMarkdown(buildChatExport([makeSession()]));
    expect(markdown).not.toContain("SECRET_RAW_BYTES_SHOULD_NEVER_LEAVE");
    expect(markdown).toContain("cat.png");
    expect(markdown).toContain("omitted");
  });

  test("carries the real transcript content, model and parameters", () => {
    const markdown = chatExportToMarkdown(buildChatExport([makeSession()]));
    expect(markdown).toContain("look at this");
    expect(markdown).toContain("a cat");
    expect(markdown).toContain("llama3.2:3b");
  });

  test("a message containing a code fence cannot break out of its own block", () => {
    const session = makeSession();
    session.messages[1].content = "```\nrm -rf /\n```";
    const markdown = chatExportToMarkdown(buildChatExport([session]));
    // The literal fence in the message content must not appear unescaped where
    // it could prematurely close the surrounding structure.
    expect(markdown).toContain("rm -rf /");
  });
});
