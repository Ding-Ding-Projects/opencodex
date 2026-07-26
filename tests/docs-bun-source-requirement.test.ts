import { expect, test } from "bun:test";

/**
 * Every contributor entry point must say that building from source needs a local `bun`, and
 * must keep that separate from the packaged Go runtime used by supported npm installs. Users
 * who install `ocx` never need their own Bun; contributors always do. The dormant bundled Bun
 * dependency is described as a compatibility bridge, not as the normal installed runtime.
 *
 * Each file is checked as one whole normalized paragraph rather than as scattered fragments.
 * Matching fragments independently across a whole file passes even after the explanatory
 * sentence is deleted, as long as the words survive somewhere else — that is a test that
 * cannot fail for the reason it exists. Whitespace normalization keeps a maintainer's
 * paragraph rewrap from breaking the suite over nothing.
 */
const PARAGRAPH_START = "Source development requires the `bun` CLI on your `PATH`";

const CASES = [
  {
    path: "../CONTRIBUTING.md",
    paragraph:
      "Source development requires the `bun` CLI on your `PATH`. The published npm package runs its packaged"
      + " Go binary on supported targets; its bundled Bun dependency remains dormant for compatibility. Contributor"
      + " commands such as `bun install`, `bun run test`, and `bun run prepush` use your local Bun installation.",
  },
  {
    path: "../README.md",
    paragraph:
      "Source development requires the `bun` CLI on your `PATH`. The published npm package instead runs its"
      + " packaged Go binary on supported targets; its bundled Bun dependency is dormant except for the old-updater"
      + " and one-time legacy-shim bridge or explicit Bun package API use.",
  },
  {
    path: "../docs-site/src/content/docs/contributing.md",
    paragraph:
      "Source development requires the `bun` CLI on your `PATH`. The published npm package runs its packaged"
      + " Go binary on supported targets; its bundled Bun dependency remains dormant for compatibility. This"
      + " checkout's scripts run through your local Bun installation.",
  },
] as const;

const INSTALL_RUNTIME_CASES = [
  {
    path: "../docs-site/src/content/docs/getting-started/installation.md",
    snippets: ["six supported", "targets run Go", "install the `bun` CLI locally"],
  },
  {
    path: "../docs-site/src/content/docs/ko/getting-started/installation.md",
    snippets: ["지원되는 6개 대상", "Bun이 실행되지 않습니다", "로컬에 `bun` CLI를 설치"],
  },
  {
    path: "../docs-site/src/content/docs/ja/getting-started/installation.md",
    snippets: ["対応する 6 ターゲット", "Bun は起動しません", "ローカルに `bun` CLI をインストール"],
  },
  {
    path: "../docs-site/src/content/docs/ru/getting-started/installation.md",
    snippets: ["шести поддерживаемых целях", "запускают Go, а не Bun", "установите `bun` CLI локально"],
  },
  {
    path: "../docs-site/src/content/docs/zh-cn/getting-started/installation.md",
    snippets: ["六个受支持目标", "普通命令运行 Go", "在本机安装 `bun` CLI"],
  },
] as const;

/** The paragraph starting at `PARAGRAPH_START`, collapsed to single spaces. */
function normalizedRequirementParagraph(text: string): string | undefined {
  const start = text.indexOf(PARAGRAPH_START);
  if (start === -1) return undefined;
  const rest = text.slice(start);
  const end = rest.indexOf("\n\n");
  const paragraph = end === -1 ? rest : rest.slice(0, end);
  return paragraph.replace(/\s+/g, " ").trim();
}

test("source development docs require local Bun while installed runtime docs identify packaged Go", async () => {
  for (const entry of CASES) {
    const text = await Bun.file(new URL(entry.path, import.meta.url)).text();
    expect(normalizedRequirementParagraph(text)).toBe(entry.paragraph);
  }
});

test("installation locales keep the Go default, dormant Bun bridge, and source Bun requirement together", async () => {
  for (const entry of INSTALL_RUNTIME_CASES) {
    const text = await Bun.file(new URL(entry.path, import.meta.url)).text();
    for (const snippet of entry.snippets) expect(text).toContain(snippet);
  }
});
