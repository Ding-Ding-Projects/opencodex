/**
 * hunt-int-03 (documentation contract): the management API's own docs must
 * describe what the code actually does, not the admin-token gate that was
 * removed from it.
 *
 * The finder's original version of this test pinned a behavioural claim from
 * `README.md`'s "Remote access" section against the real server and expected
 * it to be true: that a credential-free `/api/*` request from a LAN client
 * gets refused with 401/403, the way README's old text promised ("A hardened
 * ADMIN token is created on the proxy host ... and a remote dashboard prompts
 * for it"). It got 200 instead, because `handleManagementAPI`
 * (`src/server/management-api.ts`, ~line 139-149) admits any request that
 * clears `isAllowedManagementOrigin` (an Origin/Host check only;
 * `src/server/auth-cors.ts` ~line 99-118) and never calls the one function
 * that reads `OPENCODEX_ADMIN_AUTH_TOKEN`, `isManagementAdmissionSecret`
 * (`src/server/auth-cors.ts` ~line 357) -- that function's only caller strips
 * the value before an outbound forward, never admits an inbound one.
 *
 * That behaviour is intentional, not a hole: `src/server/index.ts` (~line 556)
 * says outright "The management plane is intentionally open. Admin-token
 * authentication was removed", `gui/src/api.ts` (lines 1-17) confirms the
 * client side was removed to match, and both `ROADMAP.md` (~line 384-385) and
 * `docs-site/src/content/docs/reference/configuration.md` (~line 368-396)
 * already document it correctly. The bug was never the code; it was that
 * `README.md` (in two places -- the "Remote access" section AND the earlier
 * "Add a provider" walkthrough) and all five copies of the web-dashboard guide
 * (English plus ja/ko/ru/zh-cn) still asserted the pre-removal behaviour, word
 * for word in English and faithfully translated in each locale.
 *
 * This test replaces the behavioural pin with a documentation contract: none
 * of those six files may claim an admin-token prompt or a hardened ADMIN
 * token gates remote access, and each must still say the true thing (the
 * management API is intentionally open). It reads the files fresh every run,
 * so it is red against the original prose and green against the correction --
 * verified by running it once with the correction stashed out (401/403 kind of
 * red becomes "the forbidden phrase is present" kind of red) and once with it
 * restored.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

interface DocTarget {
  readonly path: string;
  readonly label: string;
  /** Substrings that would, if present, claim an admin-token prompt/gate the code does not have. */
  readonly forbidden: readonly string[];
  /** Substrings that must remain: the corrected, code-accurate claim. */
  readonly required: readonly string[];
}

const TARGETS: readonly DocTarget[] = [
  {
    path: "README.md",
    label: "README.md",
    forbidden: [
      // "Remote access" section (~line 609-611 before the fix).
      "distinct ADMIN credential",
      "hardened ADMIN token",
      "Data-plane keys are never accepted as ADMIN credentials",
      // "Add a provider" section (~line 230-232 before the fix): the same
      // false claim, restated, that the finder's evidence did not name but
      // which makes the file self-contradictory if left in place.
      "prompts for that proxy's separate ADMIN token",
    ],
    required: ["have no credential gate of their own", "intentionally open"],
  },
  {
    path: "docs-site/src/content/docs/guides/web-dashboard.md",
    label: "web-dashboard.md (en)",
    forbidden: [
      // The "What it can do" table row (~line 99 before the fix).
      "destination dashboard performs ADMIN authentication",
      // The "Connect to another OpenCodex" paragraph (~line 174 before the
      // fix), contradicting the file's own correct "Remote access and
      // admission keys" section a hundred-odd lines above it.
      "destination dashboard prompts for that proxy's ADMIN token",
    ],
    required: ["intentionally open"],
  },
  {
    path: "docs-site/src/content/docs/ja/guides/web-dashboard.md",
    label: "web-dashboard.md (ja)",
    forbidden: ["移動先ダッシュボードが ADMIN 認証を行います", "プロキシの ADMIN token を要求します"],
    required: ["意図的に認証なしで開放"],
  },
  {
    path: "docs-site/src/content/docs/ko/guides/web-dashboard.md",
    label: "web-dashboard.md (ko)",
    forbidden: ["대상 대시보드가 ADMIN 인증을 수행합니다", "프록시의 ADMIN token을 요구합니다"],
    required: ["의도적으로 인증 없이 열려"],
  },
  {
    path: "docs-site/src/content/docs/ru/guides/web-dashboard.md",
    label: "web-dashboard.md (ru)",
    forbidden: ["ADMIN-аутентификацию выполняет целевой дашборд", "запрашивает ADMIN token этого прокси"],
    required: ["намеренно открыт"],
  },
  {
    path: "docs-site/src/content/docs/zh-cn/guides/web-dashboard.md",
    label: "web-dashboard.md (zh-cn)",
    forbidden: ["ADMIN 认证由目标仪表盘完成", "仪表盘会提示输入该代理的 ADMIN token"],
    required: ["刻意不设认证"],
  },
];

/** Collapse hard line wraps so a forbidden or required phrase split across a wrapped line still matches. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("management-API documentation matches the code's actual admission rule", () => {
  test("covers README.md and every localized web-dashboard.md guide", () => {
    // A vacuous pass (an empty or truncated list) would make every test below
    // pass by checking nothing. Pin the exact file set so that cannot happen
    // quietly, and confirm each one still exists on disk.
    expect(TARGETS.map(target => target.path)).toEqual([
      "README.md",
      "docs-site/src/content/docs/guides/web-dashboard.md",
      "docs-site/src/content/docs/ja/guides/web-dashboard.md",
      "docs-site/src/content/docs/ko/guides/web-dashboard.md",
      "docs-site/src/content/docs/ru/guides/web-dashboard.md",
      "docs-site/src/content/docs/zh-cn/guides/web-dashboard.md",
    ]);
    for (const target of TARGETS) {
      expect(`${target.path} exists: ${existsSync(target.path)}`).toBe(`${target.path} exists: true`);
    }
  });

  for (const target of TARGETS) {
    test(`${target.label} never claims an admin-token prompt or hardened ADMIN token for remote access`, async () => {
      const normalized = normalize(await Bun.file(target.path).text());
      for (const phrase of target.forbidden) {
        expect(`${target.label} still contains "${phrase}": ${normalized.includes(phrase)}`)
          .toBe(`${target.label} still contains "${phrase}": false`);
      }
    });

    test(`${target.label} documents that the management API is intentionally open`, async () => {
      const normalized = normalize(await Bun.file(target.path).text());
      for (const phrase of target.required) {
        expect(`${target.label} contains "${phrase}": ${normalized.includes(phrase)}`)
          .toBe(`${target.label} contains "${phrase}": true`);
      }
    });
  }
});
