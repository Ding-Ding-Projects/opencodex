/**
 * "Move… into group…" — the picker the tab context menu opens, never a list of
 * groups inlined into that menu.
 *
 * A context menu that grows one entry per group grows without bound: ten groups
 * push "Remove from group" off the bottom of a menu whose other ten entries
 * never move, and the muscle memory the strip's menu deliberately protects
 * (`TabStrip.tsx`, "a menu whose items move between openings is a menu whose
 * muscle memory is wrong") is gone. So the menu carries exactly one entry with
 * an ellipsis, and this is what the ellipsis promises: a surface listing every
 * group with its name, its colour and how many tabs it holds, a real create-new
 * path, an honest empty state, and its own filter.
 *
 * It is the tab strip's sibling of `components/authenticator/AuthenticatorGroupPicker`,
 * which solved the same problem for authenticator entries — same shape, same
 * rules, different anchoring. That one is a modal `Dialog` because it is opened
 * from a bulk bar that has no single originating row; this one is opened from
 * one specific tab, so it is anchored beside that tab and non-modal, exactly
 * like every other surface the strip opens (`TabAppearanceEditor`, the bulk
 * close, the tab search). Nothing behind it is inert, and it carries no
 * `aria-modal` claiming otherwise.
 *
 * Placement is `useAnchoredPlacement`, the shared helper, rather than the
 * pointer clamp the context menu uses. That matters for one line of the
 * contract: the panel must never cover the control that opened it. The shared
 * placement anchors the panel's TOP to the tab's bottom edge, or — when there
 * is more room above — its BOTTOM to the tab's top edge, and caps the height to
 * whichever space it chose. A pointer clamp cannot promise that: given a tab
 * near the foot of a short viewport it slides the panel back up over the thing
 * it is anchored to.
 *
 * The filter is `MenuFilterField` + `useMenuFilter`, the same pair every
 * dropdown and right-click menu in the app now uses, so this surface cannot
 * disagree with them about what plain text means, which flags a pattern
 * compiles with, or what an empty query filters (nothing — the unfiltered list
 * is the answer). Escape clears a non-empty query and stops there; a second
 * Escape reaches the listener below and closes the picker.
 *
 * What it deliberately does NOT offer: "remove from group". That command
 * already exists as its own entry in the menu directly above this one, and a
 * second route to it here would be two controls for one action with two
 * different focus-return paths. The picker moves a tab INTO a group; taking it
 * out is a different question the menu already answers.
 *
 * The group a tab is already in is listed and marked, not hidden and not
 * disabled. Hiding it makes the list change shape depending on which tab was
 * right-clicked; disabling it would need a sentence explaining a control that
 * is obviously inert anyway. Choosing it simply closes the picker, which is
 * what a user who opened this and then changed their mind wanted.
 *
 * What it deliberately does NOT do: expand a collapsed group. `assignGroup` in
 * `shared/m3/tabs.ts` never touches `collapsed`, so a tab moved into a
 * collapsed group leaves that group collapsed — the user collapsed it, and a
 * move is not a request to undo that. Because the result is a tab the strip
 * will not draw, collapsed groups are marked as such in this list, so the move
 * is chosen knowingly rather than discovered afterwards.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { onOutsidePress } from "./outside-press";
import { fixedPanelStyle, useAnchoredPlacement } from "./use-anchored-placement";
import { useMenuFilter, focusMenuFilterField } from "./menu-filter";
import { MenuFilterField, MenuFilterStatus } from "./MenuFilterField";
import { Button, TextInput } from "./m3-ui";
import { IconPlus } from "../icons";
import { useT } from "../i18n/shared";
import type { TabGroup } from "./use-tabs";

/**
 * The panel's own surface.
 *
 * It paints a background, a radius and an elevation of its own rather than
 * inheriting whatever it happens to be drawn over: an anchored panel that
 * renders transparent lets the tab strip read straight through the group names
 * on top of it. `min()` on the width for the same reason `TabAppearanceEditor`
 * uses it — a fixed panel wider than the viewport hangs off the right edge and
 * takes the whole page's horizontal scrollbar with it, and the horizontal clamp
 * pins the left edge rather than shrinking the box.
 *
 * `maxHeight` is deliberately absent: `fixedPanelStyle` supplies the real one,
 * computed from the space the placement actually found.
 */
const PANEL: React.CSSProperties = {
  zIndex: 80,
  width: "min(320px, calc(100vw - 16px))",
  overflowY: "auto",
  padding: 12,
  borderRadius: "var(--r-l)",
  background: "var(--m3-surface-container-high)",
  color: "var(--m3-on-surface)",
  boxShadow: "var(--e3)",
};

/** The member count beside a group name — same tokens the strip's badge uses. */
const COUNT_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  padding: "0 6px",
  borderRadius: "var(--r-pill)",
  background: "var(--m3-secondary-container)",
  color: "var(--m3-on-secondary-container)",
  fontSize: "var(--t-label-s)",
  lineHeight: "18px",
  fontWeight: 500,
};

/** Decoration only: the row's accessible name is the group's name and count. */
const SWATCH_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  width: 12,
  height: 12,
  borderRadius: "var(--r-pill)",
  border: "1px solid var(--m3-outline-variant)",
};

const TAG_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  fontSize: "var(--t-label-s)",
  color: "var(--m3-on-surface-variant)",
};

export interface TabGroupPickerProps {
  /** Every group the strip has, in strip order. */
  groups: TabGroup[];
  /** How many tabs a group holds — the strip owns the tab list, not this panel. */
  memberCount: (groupId: string) => number;
  /** The tab being moved. Only its label and current group are needed here. */
  tabLabel: string;
  currentGroupId?: string;
  /** The tab button this panel sits beside; it is measured, never mutated. */
  anchor: HTMLElement | null;
  /** Move the tab into an existing group. */
  onPick: (groupId: string) => void;
  /** Create a group with this name and put the tab in it. */
  onCreate: (name: string) => void;
  /** Close without moving anything; the caller restores focus to the tab. */
  onClose: () => void;
}

export default function TabGroupPicker({
  groups, memberCount, tabLabel, currentGroupId, anchor, onPick, onCreate, onClose,
}: TabGroupPickerProps) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [newName, setNewName] = useState("");
  const filterId = useId();
  const titleId = useId();
  const newNameId = useId();

  /*
    A ref-shaped view of the anchor element, rebuilt when the element changes.

    `useAnchoredPlacement` wants a ref because its callers usually have one; this
    panel receives the anchor as a value, captured by the strip at the moment the
    menu entry was activated. Writing it into a `useRef` during render would be a
    render-time mutation, and reading `.current` during render is what the hooks
    lint rule forbids outright — a memo is the honest way to hand a value to an
    API that asks for a box.
  */
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);
  const placement = useAnchoredPlacement(anchorRef, panelRef, true, 320, "start");

  const labelOfGroup = useCallback((group: TabGroup) => group.name, []);
  const filter = useMenuFilter(groups, labelOfGroup);

  // Focus lands on the filter field, not on the first group: typing is what the
  // field is for, and a picker that opens focused on a row makes the field an
  // extra Tab stop nobody reaches by habit. ArrowDown is the route to the rows.
  useEffect(() => {
    focusMenuFilterField(filterId);
  }, [filterId]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Two nested surfaces own their own Escape: the anchored regex builder
      // inside the filter row is a `role="dialog"` of its own, and
      // `MenuFilterField` swallows the first Escape while the query is
      // non-empty. Only an Escape from neither reaches here and closes this.
      const dialog = (event.target as Element | null)?.closest?.('[role="dialog"]');
      if (dialog && dialog !== panelRef.current) return;
      onClose();
    };
    const stopOutsidePress = onOutsidePress(onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      stopOutsidePress();
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  /**
   * Arrow / Home / End across the visible rows, per row rather than a roving
   * tabindex over the container — the same shape `AccountSwitcher` and the
   * strip's own new-tab search use. ArrowUp off the first row returns to the
   * filter field instead of wrapping to the last, so typing is always one key
   * away from the top of the list.
   */
  const onRowKeyDown = (event: React.KeyboardEvent, index: number) => {
    const count = filter.visible.length;
    if (!count) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      rowRefs.current[(index + 1) % count]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index === 0) focusMenuFilterField(filterId);
      else rowRefs.current[index - 1]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      rowRefs.current[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      rowRefs.current[count - 1]?.focus();
    }
  };

  /** Picking the group the tab is already in is a no-op close, never a move. */
  const choose = (groupId: string) => {
    if (groupId === currentGroupId) onClose();
    else onPick(groupId);
  };

  const commitNew = () => {
    const name = newName.trim();
    if (!name) return;
    onCreate(name);
  };

  return (
    <div
      ref={panelRef}
      role="dialog"
      // No `aria-modal`: nothing behind this is inert, and claiming otherwise
      // tells a screen reader the rest of the page is unavailable.
      aria-labelledby={titleId}
      data-tab-group-picker={currentGroupId ?? "none"}
      style={{ ...PANEL, ...fixedPanelStyle(placement) }}
    >
      <h2 className="m3-card-title" id={titleId} style={{ fontSize: "var(--t-title-s)", marginBottom: 8 }}>
        {t("tabs.movePickerTitle", { name: tabLabel })}
      </h2>

      <MenuFilterField
        id={filterId}
        query={filter.query}
        onQuery={filter.setQuery}
        regex={filter.regex}
        onRegexChange={filter.setRegex}
        flags={filter.flags}
        onFlags={filter.setFlags}
        sample={filter.sample}
        searchLabel={t("tabs.movePickerSearch")}
        placeholder={t("tabs.movePickerSearchPlaceholder")}
        builderLabel={t("tabs.movePickerBuilder")}
        onArrowDown={() => rowRefs.current[0]?.focus()}
        onEnterSingle={() => choose(filter.visible[0].id)}
        resultCount={filter.visible.length}
      />

      {groups.length === 0 ? (
        /* Words, not a blank panel. "No groups yet" and "nothing matched your
           filter" are different facts, and a user who cannot tell them apart
           assumes the picker is broken — so the second is left to
           `MenuFilterStatus` and only the genuinely empty case is stated here,
           pointing at the field below that is the way out of it. */
        <p className="m3-field-hint" role="status" style={{ margin: "8px 0" }}>
          {t("tabs.movePickerNoGroups")}
        </p>
      ) : (
        <>
          <MenuFilterStatus matcher={filter.matcher} query={filter.query} resultCount={filter.visible.length} />
          <ul
            role="list"
            aria-label={t("tabs.movePickerListAria")}
            style={{ listStyle: "none", margin: "4px 0 0", padding: 0 }}
          >
            {filter.visible.map((group, index) => {
              const count = memberCount(group.id);
              const current = group.id === currentGroupId;
              return (
                <li key={group.id}>
                  <button
                    type="button"
                    className="m3-menu-item"
                    data-group-option={group.id}
                    aria-current={current ? "true" : undefined}
                    /* Named and counted, and it says what activating it does.
                       The swatch beside it is decoration, so a group is never
                       identified by its colour alone — the same rule the strip's
                       own group headers follow. The row for the group this tab
                       is already in gets its own wording, because "move into"
                       would be a small lie about a row that only closes. */
                    aria-label={current
                      ? t("tabs.movePickerCurrentAria", { name: group.name, count: String(count) })
                      : t("tabs.movePickerOptionAria", { name: group.name, count: String(count) })}
                    ref={element => { rowRefs.current[index] = element; }}
                    onKeyDown={event => onRowKeyDown(event, index)}
                    onClick={() => choose(group.id)}
                  >
                    <span aria-hidden="true" style={{ ...SWATCH_STYLE, background: group.color ?? "var(--m3-tertiary)" }} />
                    <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {group.name}
                    </span>
                    {/* Said out loud rather than implied by a chevron: moving a
                        tab into a collapsed group puts it somewhere the strip
                        will not draw, and finding that out afterwards reads as
                        the tab having been lost. */}
                    {group.collapsed && <span style={TAG_STYLE}>{t("tabs.movePickerCollapsed")}</span>}
                    {current && <span style={TAG_STYLE}>{t("tabs.movePickerCurrent")}</span>}
                    <span style={COUNT_STYLE} aria-hidden="true">{count}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {/* The create path is part of the picker rather than a second trip through
          the menu: a user who opens this and finds no group worth joining wanted
          a new one, and sending them back to "New group…" to start again is a
          round trip this row removes. */}
      <div style={{ marginTop: 12 }}>
        <label className="m3-field-label" htmlFor={newNameId}>{t("tabs.movePickerCreateLabel")}</label>
        <div className="m3-row" style={{ gap: 8, marginTop: 4 }}>
          <TextInput
            id={newNameId}
            value={newName}
            maxLength={64}
            placeholder={t("tabs.groupNamePlaceholder")}
            onChange={event => setNewName(event.target.value)}
            onKeyDown={event => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              commitNew();
            }}
            style={{ flex: "1 1 auto", minWidth: 0, width: "auto" }}
          />
          <Button variant="outlined" disabled={!newName.trim()} onClick={commitNew}>
            <IconPlus width={16} height={16} aria-hidden="true" />
            {t("tabs.movePickerCreate")}
          </Button>
        </div>
      </div>

      <div className="m3-row" style={{ justifyContent: "end", marginTop: 12 }}>
        <Button variant="text" onClick={onClose}>{t("tabs.cancel")}</Button>
      </div>
    </div>
  );
}
