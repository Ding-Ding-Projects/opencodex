import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ExportDialog from "../src/components/ExportDialog";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let exportPayload: Record<string, unknown> | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const dialog = testWindow.HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  dialog.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  dialog.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };

  exportPayload = null;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        exportPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ error: "stop after observing payload" }, 409);
      }
      return jsonResponse({
        datasets: [{
          id: "requests",
          label: "Requests",
          rowCount: 1,
          formats: [{ format: "json", label: "JSON", extension: "json", mime: "application/json", level: "full", losses: [] }],
        }],
        archives: {
          zip: { available: true, notes: [] },
          sevenZip: {
            available: true,
            encryptionAvailable: false,
            encryptionUnavailableReason: "protected password-input channel required",
            notes: ["No password: this archive is not encrypted."],
          },
        },
        vsCode: { available: false, label: null, downloadUrl: null },
      });
    },
  });

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

test("unencrypted 7z stays available while password controls stay hidden", async () => {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ExportDialog apiBase="" dataset="requests" onClose={() => {}} />
      </LanguageProvider>,
    );
  });
  await settle();

  const archive = container.querySelector("select") as HTMLSelectElement;
  archive.value = "7z";
  await act(async () => { archive.dispatchEvent(new testWindow.Event("change", { bubbles: true }) as never); });

  expect(container.textContent).toContain("Encrypted 7z exports are unavailable");
  expect(container.textContent).toContain("protected password-input channel");
  expect(container.textContent).toContain("Unencrypted 7z export is still available");
  expect(container.querySelector('input[type="password"]')).toBeNull();

  const exportButton = [...container.querySelectorAll("button")]
    .find(button => button.textContent?.trim() === "Export") as HTMLButtonElement;
  await act(async () => { exportButton.click(); });
  await settle();

  expect(exportPayload).not.toBeNull();
  expect(exportPayload?.archive).toBe("7z");
  const sevenZip = exportPayload?.sevenZip as Record<string, unknown>;
  expect(sevenZip.method).toBe("LZMA2");
  expect(sevenZip).not.toHaveProperty("password");
  expect(sevenZip).not.toHaveProperty("encryptHeaders");
});
