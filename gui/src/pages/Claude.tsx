import { useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import ClaudeCode from "./ClaudeCode";
import ClaudeDesktop from "./ClaudeDesktop";
import { useT } from "../i18n/shared";

type ClaudeTab = "code" | "desktop";

/**
 * M3 pill tablist (prototype: CLAUDE section). The group is the container, each tab
 * a pill; the selected pill takes the secondary container role pair. Styles are
 * inline because the shared stylesheets are off-limits to a per-screen rewrite.
 */
const TABLIST_STYLE: CSSProperties = {
  display: "flex",
  gap: "6px",
  marginBottom: "20px",
  padding: "4px",
  borderRadius: "999px",
  background: "var(--m3-surface-container)",
  width: "fit-content",
  maxWidth: "100%",
  flexWrap: "wrap",
  rowGap: "4px",
};

function tabStyle(selected: boolean): CSSProperties {
  return {
    minHeight: "44px",
    padding: "0 20px",
    border: "none",
    borderRadius: "999px",
    background: selected ? "var(--m3-secondary-container)" : "transparent",
    color: selected ? "var(--m3-on-secondary-container)" : "var(--m3-on-surface-variant)",
    font: "inherit",
    fontSize: "var(--t-label-l)",
    fontWeight: selected ? 500 : 400,
    cursor: "pointer",
  };
}

export default function Claude({ apiBase }: { apiBase: string }) {
  const [tab, setTab] = useState<ClaudeTab>("code");
  const t = useT();
  const codeTabRef = useRef<HTMLButtonElement>(null);
  const desktopTabRef = useRef<HTMLButtonElement>(null);

  const selectTab = (next: ClaudeTab) => {
    setTab(next);
    window.requestAnimationFrame(() => (next === "code" ? codeTabRef : desktopTabRef).current?.focus());
  };

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      selectTab(tab === "code" ? "desktop" : "code");
    } else if (event.key === "Home") {
      event.preventDefault();
      selectTab("code");
    } else if (event.key === "End") {
      event.preventDefault();
      selectTab("desktop");
    }
  };

  return (
    <section className="claude-page">
      <div className="claude-tabs" role="tablist" aria-label={t("claude.tabsLabel")} style={TABLIST_STYLE}>
        <button
          type="button"
          role="tab"
          ref={codeTabRef}
          aria-selected={tab === "code"}
          aria-controls="claude-code-panel"
          id="claude-code-tab"
          className={tab === "code" ? "active" : ""}
          style={tabStyle(tab === "code")}
          tabIndex={tab === "code" ? 0 : -1}
          onKeyDown={handleTabKey}
          onClick={() => selectTab("code")}
        >
          {t("claude.tabCode")}
        </button>
        <button
          type="button"
          role="tab"
          ref={desktopTabRef}
          aria-selected={tab === "desktop"}
          aria-controls="claude-desktop-panel"
          id="claude-desktop-tab"
          className={tab === "desktop" ? "active" : ""}
          style={tabStyle(tab === "desktop")}
          tabIndex={tab === "desktop" ? 0 : -1}
          onKeyDown={handleTabKey}
          onClick={() => selectTab("desktop")}
        >
          {t("claude.tabDesktop")}
        </button>
      </div>

      <div
        id="claude-code-panel"
        role="tabpanel"
        aria-labelledby="claude-code-tab"
        hidden={tab !== "code"}
      >
        {tab === "code" && <ClaudeCode apiBase={apiBase} />}
      </div>
      <div
        id="claude-desktop-panel"
        role="tabpanel"
        aria-labelledby="claude-desktop-tab"
        hidden={tab !== "desktop"}
      >
        {tab === "desktop" && <ClaudeDesktop apiBase={apiBase} />}
      </div>
    </section>
  );
}
