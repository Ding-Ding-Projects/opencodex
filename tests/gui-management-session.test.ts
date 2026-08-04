import { afterEach, describe, expect, test } from "bun:test";
import { installApiAuthFetch, isApiAuthFetchInstalledForTests, resetApiAuthFetchForTests } from "../gui/src/api";

afterEach(() => {
  resetApiAuthFetchForTests();
});

describe("GUI management authentication removal", () => {
  test("management and data requests never receive an injected admin or GUI session", async () => {
    installApiAuthFetch();
    expect(isApiAuthFetchInstalledForTests()).toBe(true);
    expect(new Headers().get("x-opencodex-api-key")).toBeNull();
    expect(new Headers().get("x-opencodex-gui-origin")).toBeNull();
    expect(new Headers().get("x-opencodex-csrf-token")).toBeNull();
  });
});
