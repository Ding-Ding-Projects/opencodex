import { describe, expect, test } from "bun:test";
import {
  runServiceAcceptance,
  SERVICE_CLASS_PROFILES,
} from "../scripts/disposable-host/codex-service-composed-acceptance";

describe("disposable-host service acceptance contract", () => {
  test("enumerates exactly the deferred WP13 service classes", () => {
    expect(SERVICE_CLASS_PROFILES).toEqual(["P09", "P10", "P18", "P34", "P35", "P36"]);
  });

  test("refuses to run on an ordinary workstation and emits no artifacts", () => {
    const result = runServiceAcceptance({
      profile: "P09",
      hostRoot: undefined,
      disposableHost: undefined,
    });
    expect(result.status).toBe("refused");
    expect(result.checks).toEqual([]);
    expect(result.artifacts).toEqual({});
  });
});
