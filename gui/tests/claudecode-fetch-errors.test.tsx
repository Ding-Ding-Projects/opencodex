import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ClaudeCode from "../src/pages/ClaudeCode";

const originalFetch = globalThis.fetch;
let previousLanguageDescriptor: PropertyDescriptor | undefined;
let restoreGlobals: (() => void) | undefined;

beforeEach(() => {
  previousLanguageDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
  const previous = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
    actEnv: Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
  };
  restoreGlobals = () => {
    for (const [key, descriptor] of [
      ["document", previous.document],
      ["window", previous.window],
      ["localStorage", previous.localStorage],
      ["IS_REACT_ACT_ENVIRONMENT", previous.actEnv],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    if (previousLanguageDescriptor) {
      Object.defineProperty(globalThis.navigator, "language", previousLanguageDescriptor);
    } else {
      delete (globalThis.navigator as { language?: string }).language;
    }
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreGlobals?.();
});

const CLAUDE_OK = {
  enabled: true,
  authMode: "proxy",
  autoConnectSupported: false,
  systemEnv: false,
  fastMode: null,
  maxContextTokens: null,
  autoContext: true,
  autoCompactWindow: null,
  injectAgents: true,
  smallFastModel: "",
  effectiveModelEnv: {},
  available: ["mock/model"],
  aliases: [],
  port: 10100,
  modelMap: {},
};

async function mountClaudeCode(): Promise<{ container: HTMLElement; root: Root; testWindow: Window }> {
  const testWindow = new Window({ url: "http://localhost/" });
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });

  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ClaudeCode apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  });
  return { container, root, testWindow };
}

test("ClaudeCode load surfaces the server error message from a failed GET", async () => {
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/api/claude-code")) {
      return Response.json({ error: "claude config locked" }, { status: 503 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { container, root, testWindow } = await mountClaudeCode();
  try {
    expect(container.textContent).toContain("claude config locked");
    expect(container.textContent).not.toContain("Claude Code");
  } finally {
    await act(async () => root.unmount());
    testWindow.close();
  }
});

test("ClaudeCode save surfaces the server error message from a failed PUT", async () => {
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/api/claude-code") && method === "GET") {
      return Response.json(CLAUDE_OK);
    }
    if (url.endsWith("/api/claude-code") && method === "PUT") {
      return Response.json({ error: "model map rejected" }, { status: 400 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { container, root, testWindow } = await mountClaudeCode();
  try {
    expect(container.textContent).toContain("Claude Code");
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => /save/i.test(button.textContent ?? ""));
    expect(save).toBeTruthy();

    await act(async () => {
      save!.click();
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });

    expect(container.textContent).toContain("model map rejected");
  } finally {
    await act(async () => root.unmount());
    testWindow.close();
  }
});

test("ClaudeCode ignores a malformed legacy context value without blocking unrelated saves", async () => {
  const putBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/api/claude-code") && method === "GET") {
      return Response.json({ ...CLAUDE_OK, maxContextTokens: "1000000" });
    }
    if (url.endsWith("/api/claude-code") && method === "PUT") {
      putBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { container, root, testWindow } = await mountClaudeCode();
  try {
    const contextWindow = container.querySelector<HTMLButtonElement>(
      '[role="combobox"][aria-label="Context size override"]',
    );
    expect(contextWindow?.textContent).toContain("Automatic");
    expect(container.textContent).toContain("config file contains an invalid context-size override");
    await act(async () => { contextWindow!.click(); });
    const oneMillion = [...testWindow.document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(option => option.textContent?.trim() === "1M");
    await act(async () => { oneMillion!.click(); });
    expect(container.textContent).toContain("Unsaved selection");
    expect(container.textContent).toContain("still uses an invalid stored value");

    const save = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => /save/i.test(button.textContent ?? ""));
    await act(async () => {
      save!.click();
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
    });
    expect(putBodies[0]?.maxContextTokens).toBe(1_000_000);
  } finally {
    await act(async () => root.unmount());
    testWindow.close();
  }
});

test("ClaudeCode gives colliding off-preset context values an exact label", async () => {
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/api/claude-code")) {
      return Response.json({ ...CLAUDE_OK, maxContextTokens: 100_001 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { container, root, testWindow } = await mountClaudeCode();
  try {
    const contextWindow = container.querySelector<HTMLButtonElement>(
      '[role="combobox"][aria-label="Context size override"]',
    );
    expect(contextWindow?.textContent).toContain("100,001");
    await act(async () => { contextWindow!.click(); });
    const labels = [...testWindow.document.querySelectorAll<HTMLElement>('[role="option"]')]
      .map(option => option.textContent?.trim());
    expect(labels).toContain("100k");
    expect(labels).toContain("100,001");
  } finally {
    await act(async () => root.unmount());
    testWindow.close();
  }
});

test("ClaudeCode reports an unsaved context selection without claiming persistence", async () => {
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/api/claude-code")) return Response.json(CLAUDE_OK);
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { container, root, testWindow } = await mountClaudeCode();
  try {
    const contextWindow = container.querySelector<HTMLButtonElement>(
      '[role="combobox"][aria-label="Context size override"]',
    );
    await act(async () => { contextWindow!.click(); });
    const oneMillion = [...testWindow.document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(option => option.textContent?.trim() === "1M");
    await act(async () => { oneMillion!.click(); });
    expect(container.textContent).toContain("Unsaved selection");
    expect(container.textContent).toContain("still uses Automatic");
    expect(container.textContent).not.toContain("Saved in the opencodex config file");
  } finally {
    await act(async () => root.unmount());
    testWindow.close();
  }
});

test("ClaudeCode preserves a custom context value and PUTs preset and Automatic selections", async () => {
  const putBodies: Array<Record<string, unknown>> = [];
  let persistedContext: number | null = 1_040_000;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/api/claude-code") && method === "GET") {
      return Response.json({ ...CLAUDE_OK, maxContextTokens: persistedContext });
    }
    if (url.endsWith("/api/claude-code") && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      putBodies.push(body);
      persistedContext = body.maxContextTokens as number | null;
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { container, root, testWindow } = await mountClaudeCode();
  try {
    const contextWindow = container.querySelector<HTMLButtonElement>(
      '[role="combobox"][aria-label="Context size override"]',
    );
    expect(contextWindow).toBeTruthy();
    expect(contextWindow!.textContent).toContain("1,040,000");
    expect(contextWindow!.getAttribute("aria-describedby")).toBe(
      "claude-max-context-description claude-max-context-provenance claude-max-context-warning",
    );
    expect(container.textContent).toContain("Saved in the opencodex config file");

    await act(async () => {
      contextWindow!.click();
    });
    const optionLabels = [...testWindow.document.querySelectorAll<HTMLElement>('[role="option"]')]
      .map(option => option.textContent?.trim());
    expect(optionLabels).toContain("1,040,000");
    expect(optionLabels).toContain("1M");
    const oneMillion = [...testWindow.document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(option => option.textContent?.trim() === "1M");
    await act(async () => {
      oneMillion!.click();
    });

    const save = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => /save/i.test(button.textContent ?? ""));
    expect(save).toBeTruthy();
    await act(async () => {
      save!.click();
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
    });
    expect(putBodies[0]?.maxContextTokens).toBe(1_000_000);

    const reloadedContextWindow = container.querySelector<HTMLButtonElement>(
      '[role="combobox"][aria-label="Context size override"]',
    );
    await act(async () => {
      reloadedContextWindow!.click();
    });
    const automatic = [...testWindow.document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(option => option.textContent?.includes("Automatic"));
    expect(automatic).toBeTruthy();
    await act(async () => {
      automatic!.click();
    });
    await act(async () => {
      save!.click();
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
    });

    expect(putBodies).toHaveLength(2);
    expect(putBodies[1]?.maxContextTokens).toBeNull();
    expect(container.textContent).toContain("Using the compiled-in Automatic default");
  } finally {
    await act(async () => root.unmount());
    testWindow.close();
  }
});

test("ClaudeCode save treats an empty 200 body as success", async () => {
  let putCount = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/api/claude-code") && method === "GET") {
      return Response.json(CLAUDE_OK);
    }
    if (url.endsWith("/api/claude-code") && method === "PUT") {
      putCount += 1;
      return new Response("", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { container, root, testWindow } = await mountClaudeCode();
  try {
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => /save/i.test(button.textContent ?? ""));
    expect(save).toBeTruthy();

    await act(async () => {
      save!.click();
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });

    expect(putCount).toBeGreaterThanOrEqual(1);
    expect(container.textContent).toContain("Saved.");
  } finally {
    await act(async () => root.unmount());
    testWindow.close();
  }
});

test("ClaudeCode helper model options render icon-backed model names", async () => {
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/api/claude-code")) {
      return Response.json({ ...CLAUDE_OK, available: ["gpt-5.6-luna"] });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { container, root, testWindow } = await mountClaudeCode();
  try {
    const helperModel = container.querySelector<HTMLButtonElement>(
      '[role="combobox"][aria-label="Background helper model"]',
    );
    expect(helperModel).toBeTruthy();

    await act(async () => {
      helperModel!.click();
      await Promise.resolve();
    });

    const optionText = [...testWindow.document.querySelectorAll<HTMLElement>('[role="option"]')]
      .map(option => option.textContent)
      .join("\n");
    expect(optionText).toContain("gpt-5.6-luna");
    expect(optionText).not.toContain("[object Object]");
  } finally {
    await act(async () => root.unmount());
    testWindow.close();
  }
});
