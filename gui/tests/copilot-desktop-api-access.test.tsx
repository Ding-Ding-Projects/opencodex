import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ApiKeys from "../src/pages/ApiKeys";

const originalFetch = globalThis.fetch;
let restoreGlobals: (() => void) | undefined;
let previousLanguageDescriptor: PropertyDescriptor | undefined;

const KEYS = {
  keys: [],
  baseUrl: "http://127.0.0.1:10100/v1",
  endpoint: "http://127.0.0.1:10100/v1/responses",
  responsesEndpoint: "http://127.0.0.1:10100/v1/responses",
  chatCompletionsEndpoint: "http://127.0.0.1:10100/v1/chat/completions",
  messagesEndpoint: "http://127.0.0.1:10100/v1/messages",
  modelsEndpoint: "http://127.0.0.1:10100/v1/models",
  claudeCodeEnabled: true,
};

const PROFILE = {
  purpose: "github-copilot-desktop",
  loopbackOnly: true,
  baseUrl: "http://127.0.0.1:10100/v1",
  modelsEndpoint: "http://127.0.0.1:10100/v1/models",
  chatCompletionsEndpoint: "http://127.0.0.1:10100/v1/chat/completions",
  wireApi: "completions",
  directModeExcluded: true,
  sidecarDisclosure: ["Vision and web-search sidecars may run when configured and requested."],
  lastRequest: null,
  providers: [{ provider: "mock", configured: true, ready: true, reason: "ready" }],
  models: [
    {
      id: "mock/ready-model",
      provider: "mock",
      model: "ready-model",
      adapter: "openai-chat",
      ready: true,
      reason: "ready",
      capabilities: { chat: "supported", tools: "supported", images: "unsupported", reasoning: "supported", structuredOutput: "unsupported" },
      sidecars: ["web-search-when-requested"],
      directModeExcluded: false,
      cursorNativeExecution: "unavailable",
    },
    {
      id: "cursor/local-exec-model",
      provider: "cursor",
      model: "local-exec-model",
      adapter: "cursor",
      ready: false,
      reason: "cursor-native-execution-unavailable",
      capabilities: { chat: "supported", tools: "supported", images: "unsupported", reasoning: "unsupported", structuredOutput: "supported" },
      sidecars: [],
      directModeExcluded: false,
      cursorNativeExecution: "unavailable",
    },
  ],
};

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
    if (previousLanguageDescriptor) Object.defineProperty(globalThis.navigator, "language", previousLanguageDescriptor);
    else delete (globalThis.navigator as { language?: string }).language;
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreGlobals?.();
});

async function mountApiKeys(fetchImpl: typeof fetch) {
  const testWindow = new Window({ url: "http://localhost/" });
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  globalThis.fetch = fetchImpl;
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><ApiKeys apiBase="http://localhost" /></LanguageProvider>);
  });
  await act(async () => {
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
    await Promise.resolve();
  });
  return { testWindow, container, root };
}

function standardFetch(overrides?: (url: string, method: string, init?: RequestInit) => Response | undefined): typeof fetch {
  return (async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const overridden = overrides?.(url, method, init);
    if (overridden) return overridden;
    if (url.endsWith("/api/keys") && method === "GET") return Response.json(KEYS);
    if (url.endsWith("/api/copilot-desktop") && method === "GET") return Response.json(PROFILE);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

test("Copilot setup card is first, uses the management DTO, and renders conservative model readiness", async () => {
  const requests: string[] = [];
  const mounted = await mountApiKeys(standardFetch((url) => {
    requests.push(url);
    return undefined;
  }));
  try {
    const panels = [...mounted.container.querySelectorAll(".api-panel")];
    expect(panels[0]?.textContent).toContain("GitHub Copilot Desktop");
    expect(panels[0]?.textContent).toContain("completions");
    expect(panels[0]?.textContent).toContain("API key field to be blank");
    expect(panels[0]?.textContent).toContain("OpenAI Direct is excluded");
    expect(requests).toContain("http://localhost/api/copilot-desktop");
    expect(requests.some(url => url.endsWith("/v1/models"))).toBe(false);
    expect(mounted.container.textContent).toContain("mock/ready-model");
    expect(mounted.container.textContent).toContain("cursor/local-exec-model");
    expect(mounted.container.textContent).toContain("Cursor native local execution must be disabled");
    const disabledTest = [...mounted.container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.closest("tr")?.textContent?.includes("cursor/local-exec-model") && button.textContent?.includes("Test"));
    expect(disabledTest?.disabled).toBe(true);
  } finally {
    await act(async () => mounted.root.unmount());
    mounted.testWindow.close();
  }
});

test("Generate integration key sends the bounded purpose and reuses reveal-once handling", async () => {
  let createBody: Record<string, unknown> | null = null;
  const mounted = await mountApiKeys(standardFetch((url, method, init) => {
    if (url.endsWith("/api/keys") && method === "POST") {
      createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        id: "new-copilot",
        name: "GitHub Copilot Desktop",
        key: "ocx_data_reveal_once_copilot_secret",
        createdAt: "2026-08-07T00:00:00.000Z",
        purpose: "github-copilot-desktop",
      }, { status: 201 });
    }
    return undefined;
  }));
  try {
    const generate = [...mounted.container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.includes("Generate integration key"));
    expect(generate).toBeTruthy();
    await act(async () => {
      generate!.click();
      await new Promise<void>(resolve => mounted.testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });
    expect(createBody).toEqual({ name: "GitHub Copilot Desktop", purpose: "github-copilot-desktop" });
    expect(mounted.container.textContent).toContain("ocx_data_reveal_once_copilot_secret");
    expect(mounted.container.textContent).toContain("Copy this key now");
    const dismiss = [...mounted.container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Dismiss");
    await act(async () => dismiss!.click());
    expect(mounted.container.textContent).not.toContain("ocx_data_reveal_once_copilot_secret");
  } finally {
    await act(async () => mounted.root.unmount());
    mounted.testWindow.close();
  }
});

test("model search keeps plain text default and exposes an adjacent anchored regex builder", async () => {
  const mounted = await mountApiKeys(standardFetch());
  try {
    const search = mounted.container.querySelector<HTMLInputElement>('input[aria-label="Search models"]');
    const regexButton = [...mounted.container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.includes("Regex"));
    expect(search).toBeTruthy();
    expect(regexButton).toBeTruthy();
    expect(search?.parentElement?.contains(regexButton!)).toBe(true);

    await act(async () => {
      Object.getOwnPropertyDescriptor(mounted.testWindow.HTMLInputElement.prototype, "value")!
        .set!.call(search, "ready-model");
      search!.dispatchEvent(new mounted.testWindow.Event("input", { bubbles: true }));
    });
    expect(mounted.container.textContent).toContain("mock/ready-model");
    expect(mounted.container.textContent).not.toContain("cursor/local-exec-model");

    await act(async () => regexButton!.click());
    const dialog = mounted.container.querySelector('[role="dialog"][aria-label="Model-search regex builder"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain("JavaScript RegExp");
    const enable = dialog!.querySelector<HTMLInputElement>('input[type="checkbox"]');
    const pattern = dialog!.querySelector<HTMLInputElement>('input.mono');
    await act(async () => {
      enable!.click();
      Object.getOwnPropertyDescriptor(mounted.testWindow.HTMLInputElement.prototype, "value")!
        .set!.call(pattern, "^cursor/");
      pattern!.dispatchEvent(new mounted.testWindow.Event("input", { bubbles: true }));
    });
    expect(mounted.container.textContent).not.toContain("mock/ready-model");
    expect(mounted.container.textContent).toContain("cursor/local-exec-model");
  } finally {
    await act(async () => mounted.root.unmount());
    mounted.testWindow.close();
  }
});

test("profile refresh failure retains last-good setup and model rows", async () => {
  let profileGets = 0;
  const mounted = await mountApiKeys(standardFetch((url, method) => {
    if (url.endsWith("/api/copilot-desktop") && method === "GET") {
      profileGets += 1;
      return profileGets === 1 ? Response.json(PROFILE) : new Response("offline", { status: 503 });
    }
    if (url.endsWith("/api/keys") && method === "POST") {
      return Response.json({ key: "ocx_data_one_time_refresh_probe" }, { status: 201 });
    }
    return undefined;
  }));
  try {
    expect(mounted.container.textContent).toContain("mock/ready-model");
    const integrationGenerate = [...mounted.container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.includes("Generate integration key"));
    expect(integrationGenerate).toBeTruthy();
    await act(async () => {
      integrationGenerate!.click();
      await new Promise<void>(resolve => mounted.testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });
    expect(profileGets).toBeGreaterThanOrEqual(2);
    expect(mounted.container.textContent).toContain("mock/ready-model");
    expect(mounted.container.textContent).toContain("Readiness unavailable");
  } finally {
    await act(async () => mounted.root.unmount());
    mounted.testWindow.close();
  }
});
