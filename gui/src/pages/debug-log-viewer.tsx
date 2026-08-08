import type { Virtualizer } from "@tanstack/react-virtual";
import { useI18n } from "../i18n/shared";
import { Empty } from "../shell/m3-ui";
import type { DebugLogEntry, LogStream } from "./debug-shared";
import { formatLogTime } from "./debug-shared";

export function DebugLogViewer({
  debug,
  stream,
  streamEnabled,
  entries,
  scrollContainerRef,
  lineVirtualizer,
}: {
  debug: boolean;
  stream: LogStream;
  streamEnabled: boolean;
  entries: DebugLogEntry[];
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  lineVirtualizer: Virtualizer<HTMLDivElement, Element>;
}) {
  const { t } = useI18n();

  if (!debug) return null;

  if (!streamEnabled) {
    return (
      <Empty title={t("debug.emptyTitle")}>
        <span style={{ display: "inline-block", maxWidth: 560 }}>{t("debug.empty")}</span>
      </Empty>
    );
  }

  if (entries.length === 0) {
    return (
      <Empty title={t("debug.noLinesTitle")}>
        <span style={{ display: "inline-block", maxWidth: 560 }}>{t(`debug.noLines.${stream}`)}</span>
      </Empty>
    );
  }

  return (
    <div
      ref={scrollContainerRef}
      style={{
        maxHeight: "calc(100vh - 280px)",
        overflow: "auto",
        padding: "14px 16px",
        border: "1px solid var(--m3-outline-variant)",
        borderRadius: "var(--r-l)",
        background: "var(--m3-surface-container-lowest)",
        color: "var(--m3-on-surface)",
        fontFamily: "var(--mono)",
        fontSize: "var(--t-label-m)",
        lineHeight: 1.7,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      <div
        style={{
          position: "relative",
          height: lineVirtualizer.getTotalSize(),
          width: "100%",
        }}
      >
        {lineVirtualizer.getVirtualItems().map(virtualRow => (
          <div
            key={virtualRow.key}
            ref={lineVirtualizer.measureElement}
            data-index={virtualRow.index}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${virtualRow.start}px)`,
            }}
          >
            {`${formatLogTime(entries[virtualRow.index]!.at)}${entries[virtualRow.index]!.line}`}
          </div>
        ))}
      </div>
    </div>
  );
}
