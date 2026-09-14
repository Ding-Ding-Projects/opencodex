/**
 * Confirming an IME composition with Enter must not double as "submit".
 *
 * `AuthenticatorGroupPicker`'s "create a new group" field
 * (`src/components/authenticator/AuthenticatorGroupPicker.tsx:113`) wires:
 *
 *   onKeyDown={e => { if (e.key === "Enter") void handleCreate(); }}
 *
 * directly onto a bare `<input>` (`TextInput` in `src/shell/m3-ui.tsx` is
 * nothing more than `<input {...props}>`, so nothing between the two filters
 * the event). When a user composes text with an IME, Cantonese or any other
 * CJK input method, pressing Enter to commit the current composition fires a
 * native `keydown` with `key: "Enter"` and `isComposing: true`. This handler
 * does not check `isComposing`, so that confirming keystroke is
 * indistinguishable from a real "submit" Enter: it creates the group from
 * whatever partial text sat in the field at that instant, mid-composition.
 *
 * The codebase already has the fix for this, proven working in exactly two
 * other places: `components/AccountPoolStrategyControls.tsx:88` and
 * `components/CodexAutoSwitchSetting.tsx:100` both guard with
 * `if (event.nativeEvent.isComposing || …) return;` before treating Enter as
 * a commit. Both of those are `type="number"` fields, the input kind least
 * likely to ever see real IME composition. The free-text name field here,
 * exactly the kind of field a Cantonese-speaking user would compose a group
 * name in, has no such guard, and neither do several sibling call sites
 * (`AuthenticatorAddDialog.tsx:358`, `SecretHistoryDialog.tsx:145,153`,
 * `VersionHistory.tsx:788`, `ProviderModels.tsx:207`, `UnlockPrompt.tsx:134,147`)
 * that share the same unguarded `if (e.key === "Enter") …` shape.
 *
 * This test drives the real component with a real native composing keydown;
 * nothing about `isComposing` handling is mocked.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { TestLanguageProvider } from "./helpers/providers";
import AuthenticatorGroupPicker from "../src/components/authenticator/AuthenticatorGroupPicker";
import type { AuthenticatorGroup } from "../src/pages/authenticator-api";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
    });
  }
}

function typeInto(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new testWindow.Event("input", { bubbles: true }) as never);
}

test("an Enter that only confirms IME composition must not submit the new-group name", async () => {
  const createCalls: string[] = [];
  const onCreateGroup = async (name: string): Promise<AuthenticatorGroup> => {
    createCalls.push(name);
    return { id: "g1", name, order: 0 };
  };
  const pickCalls: (string | null)[] = [];

  const { createRoot } = await import("react-dom/client");
  const container = testWindow.document.createElement("div");
  testWindow.document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <TestLanguageProvider>
        <AuthenticatorGroupPicker
          open
          onClose={() => {}}
          groups={[]}
          memberCount={() => 0}
          onPick={id => pickCalls.push(id)}
          onCreateGroup={onCreateGroup}
        />
      </TestLanguageProvider>,
    );
  });
  await settle();

  const input = container.querySelector<HTMLInputElement>("input[aria-label='Create a new group…']");
  if (!input) throw new Error("create-group input not found");

  // The IME has produced the first characters of a name still being
  // composed (e.g. picking a Cantonese candidate for 銀行, "bank") and the
  // user presses Enter only to confirm that composition, the same keystroke
  // a Chinese/Japanese/Korean input method uses every time it commits a
  // candidate. `isComposing: true` is exactly what the browser reports on
  // that keydown.
  await act(async () => { typeInto(input, "銀"); });
  await settle();
  await act(async () => {
    input.dispatchEvent(new testWindow.KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, cancelable: true, isComposing: true,
    }) as never);
  });
  await settle();

  // Expected/correct behaviour: a composition-confirming Enter must not
  // submit. This is the assertion that fails today: the unguarded handler
  // calls `handleCreate()` regardless of `isComposing`, so the group gets
  // created from the still-mid-composition text "銀".
  expect(createCalls).toEqual([]);

  // Control: a real, non-composing Enter on the finished name DOES submit,
  // proving the harness and the field genuinely work, and that the failure
  // above is specifically about the missing `isComposing` guard rather than
  // a broken test setup.
  await act(async () => { typeInto(input, "銀行"); });
  await settle();
  await act(async () => {
    input.dispatchEvent(new testWindow.KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, cancelable: true, isComposing: false,
    }) as never);
  });
  await settle();
  expect(createCalls).toEqual(["銀行"]);
  expect(pickCalls).toEqual(["g1"]);

  await act(async () => { root.unmount(); });
});
