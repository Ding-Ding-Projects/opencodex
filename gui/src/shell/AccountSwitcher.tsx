/**
 * App-bar account switcher: the avatar chip opens a menu of the Codex account
 * pool, and picking one switches the routed account from any page — previously
 * that meant navigating to Codex Auth first.
 *
 * Uses the same PUT /api/codex-auth/active the Codex Auth screen uses, so the
 * server-side rules (paused accounts refused, legacy __main__ conflicts,
 * unknown ids) apply identically; failures surface as a persistent error
 * snackbar carrying the server's own message.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { onOutsidePress } from "./outside-press";
import { useKeyedClientResource } from "../client-resource";
import { readJsonIfOk } from "../fetch-json";
import { useT } from "../i18n/shared";
import { useNotifications } from "./notifications-context";
import { fixedPanelStyle, useAnchoredPlacement } from "./use-anchored-placement";
import { useMenuFilter, focusMenuFilterField } from "./menu-filter";
import { MenuFilterField, MenuFilterStatus } from "./MenuFilterField";
import { MenuItem } from "./MenuItem";

interface PoolAccount {
  id: string;
  /** Pre-masked by the server. */
  email: string;
  plan?: string | null;
  isMain?: boolean;
  paused?: boolean;
  quota?: { weeklyPercent?: number; monthlyPercent?: number } | null;
}

interface PoolState {
  accounts: PoolAccount[];
  activeId: string | null;
}

/**
 * Which row is routing right now.
 *
 * `activeCodexAccountId` is null when the main Codex Desktop account is active —
 * that is how the server stores "no pool override", and it is what PUT
 * /api/codex-auth/active receives when main is chosen. Comparing ids alone
 * therefore matches nothing at all in the one case a user is most likely to be in.
 */
function isActiveAccount(account: PoolAccount, activeId: string | null): boolean {
  return activeId === null ? account.isMain === true : account.id === activeId;
}

function initials(email: string | null): string {
  if (!email) return "–";
  const name = email.split("@")[0] || email;
  const parts = name.split(/[._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return letters.toUpperCase();
}

export default function AccountSwitcher({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { notify } = useNotifications();
  const [menuOpen, setMenuOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuPlacement = useAnchoredPlacement(wrapRef, menuRef, menuOpen, 260);
  const filterId = useId();

  const poll = useKeyedClientResource(
    `app-codex-pool:${apiBase}`,
    [],
    async (signal): Promise<PoolState | null> => {
      const [activeRes, accountsRes] = await Promise.all([
        fetch(`${apiBase}/api/codex-auth/active`, { signal }),
        fetch(`${apiBase}/api/codex-auth/accounts`, { signal }),
      ]);
      const active = await readJsonIfOk<{ activeCodexAccountId?: unknown }>(activeRes);
      const list = await readJsonIfOk<{ accounts?: PoolAccount[] }>(accountsRes);
      if (!Array.isArray(list?.accounts)) return null;
      return {
        accounts: list.accounts.filter(a => typeof a?.id === "string"),
        activeId: typeof active?.activeCodexAccountId === "string" ? active.activeCodexAccountId : null,
      };
    },
    { pollMs: 60_000 },
  );

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The anchored regex builder is a nested dialog with its own Escape —
      // stage one (clear the filter) is handled inside `MenuFilterField`
      // itself, and a builder open inside it owns its own close entirely.
      // Only an Escape that did not originate inside either reaches here.
      if ((e.target as Element | null)?.closest?.('[role="dialog"]')) return;
      // Escape returns focus to the trigger; a menu that closes and drops focus to
      // the document leaves a keyboard user at the top of the page.
      setMenuOpen(false);
      triggerRef.current?.focus();
    };
    const stopOutsideonDown = onOutsidePress(onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      stopOutsideonDown();
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Opening a menu moves focus into it — that is the whole keyboard contract of
  // role="menu", and without it the rows below are unreachable without a mouse.
  // It lands on the filter field rather than the first account: typing is the
  // point of a filter that takes focus on open, and ArrowDown from the field
  // is what reaches the account list itself (see `onItemKeyDown` below).
  useEffect(() => {
    if (!menuOpen) return;
    focusMenuFilterField(filterId);
  }, [menuOpen, filterId]);

  const state = poll.data ?? null;
  // A null activeCodexAccountId does NOT mean "nothing is active" — it means the
  // MAIN (Codex Desktop) account is routing. Switching to main deliberately PUTs
  // accountId: null, so matching on id alone left the main account permanently
  // unmarked: no tick in the menu, and the avatar fell back to "no account".
  const active = state
    ? state.accounts.find(account => isActiveAccount(account, state.activeId)) ?? null
    : null;

  const accounts = state?.accounts ?? [];
  const labelOfAccount = useCallback((account: PoolAccount) => account.email, []);
  const filter = useMenuFilter(accounts, labelOfAccount);

  const switchTo = async (account: PoolAccount) => {
    if (switching || (state && isActiveAccount(account, state.activeId))) { setMenuOpen(false); return; }
    setSwitching(true);
    try {
      const res = await fetch(`${apiBase}/api/codex-auth/active`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.isMain ? null : account.id }),
      });
      if (res.ok) {
        notify({ tone: "success", title: t("switcher.switched"), body: account.email });
        poll.refresh();
      } else {
        // The server's message names the actual refusal (paused, legacy row…).
        const body = await res.json().catch(() => null) as { error?: string } | null;
        notify({ tone: "error", title: t("switcher.failed"), body: body?.error ?? undefined });
      }
    } catch {
      notify({ tone: "error", title: t("switcher.failed") });
    } finally {
      setSwitching(false);
      setMenuOpen(false);
    }
  };

  /**
   * Arrow / Home / End movement among the *visible* (filtered) rows, per row
   * rather than roving tabindex over the whole container — the same shape
   * `TabStrip`'s already-compliant new-tab search uses. ArrowUp off the first
   * row returns focus to the filter field instead of wrapping to the last row,
   * so a keyboard user can always get back to typing without reaching for Home.
   */
  const onItemKeyDown = (event: React.KeyboardEvent, index: number) => {
    const count = filter.visible.length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      itemRefs.current[(index + 1) % count]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (index === 0) focusMenuFilterField(filterId);
      else itemRefs.current[index - 1]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      itemRefs.current[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      itemRefs.current[count - 1]?.focus();
    }
  };

  // No pool (proxy down, or nothing configured): a plain, non-interactive chip.
  if (!state || state.accounts.length === 0) {
    return (
      <span className="m3-avatar" title={t("appbar.noAccount")} aria-label={t("appbar.noAccount")}>
        {initials(null)}
      </span>
    );
  }

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <button
        type="button"
        ref={triggerRef}
        className="m3-avatar m3-avatar--btn"
        onClick={() => {
          // A fresh filter every time the menu opens; a query left over from
          // the last visit would silently hide accounts the next one.
          filter.setQuery("");
          filter.setRegex(false);
          setMenuOpen(o => !o);
        }}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={t("switcher.aria", { email: active?.email ?? t("appbar.noAccount") })}
        title={active?.email ?? t("appbar.noAccount")}
        disabled={switching}
      >
        {initials(active?.email ?? null)}
      </button>
      {menuOpen && (
        <div
          ref={menuRef}
          className="m3-menu"
          role="menu"
          aria-label={t("switcher.title")}
          style={{ ...fixedPanelStyle(menuPlacement), zIndex: 70, minWidth: "min(260px, calc(100vw - 16px))" }}
        >
          <div className="m3-menu-heading">{t("switcher.title")}</div>
          <MenuFilterField
            id={filterId}
            query={filter.query}
            onQuery={filter.setQuery}
            regex={filter.regex}
            onRegexChange={filter.setRegex}
            flags={filter.flags}
            onFlags={filter.setFlags}
            sample={filter.sample}
            searchLabel={t("switcher.filterLabel")}
            builderLabel={t("switcher.filterBuilder")}
            onArrowDown={() => itemRefs.current[0]?.focus()}
            onEnterSingle={() => void switchTo(filter.visible[0])}
            resultCount={filter.visible.length}
          />
          <MenuFilterStatus matcher={filter.matcher} query={filter.query} resultCount={filter.visible.length} />
          {filter.visible.map((account, index) => {
            const isActive = isActiveAccount(account, state.activeId);
            const weekly = account.quota?.weeklyPercent;
            const unavailable = !!account.paused;
            return (
              /* A row here picks a value rather than running a command, so
                 there is no binding to print — an account cannot have a
                 keyboard shortcut of its own. It renders through `MenuItem`
                 all the same, so the day one of these grows a command the
                 column is already there. */
              <MenuItem
                key={account.id}
                role="menuitemradio"
                aria-checked={isActive}
                className={`m3-menu-item${unavailable ? " m3-menu-item--unavailable" : ""}`}
                ref={element => { itemRefs.current[index] = element; }}
                onKeyDown={event => onItemKeyDown(event, index)}
                // aria-disabled rather than only `disabled`, so a screen reader
                // announces a paused account instead of skipping past it silently.
                aria-disabled={unavailable || switching}
                disabled={switching || unavailable}
                onClick={() => void switchTo(account)}
              >
                <span className="m3-avatar" style={{ width: 28, height: 28, fontSize: "var(--t-label-s)", marginLeft: 0 }} aria-hidden="true">
                  {initials(account.email)}
                </span>
                <span style={{ minWidth: 0, flex: "1 1 auto" }}>
                  <span style={{ display: "block", fontWeight: isActive ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {account.email}
                  </span>
                  <span style={{ display: "block", fontSize: "var(--t-label-s)", color: "var(--m3-on-surface-variant)" }}>
                    {account.paused
                      ? t("switcher.paused")
                      : typeof weekly === "number"
                        ? t("switcher.weeklyUsed", { pct: String(Math.round(weekly)) })
                        : account.plan ?? ""}
                  </span>
                </span>
                {isActive && <span style={{ flex: "0 0 auto", color: "var(--m3-primary)", fontWeight: 600 }}>{t("switcher.active")}</span>}
              </MenuItem>
            );
          })}
        </div>
      )}
    </div>
  );
}
