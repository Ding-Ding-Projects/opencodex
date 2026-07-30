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

import { useEffect, useRef, useState } from "react";
import { useKeyedClientResource } from "../client-resource";
import { readJsonIfOk } from "../fetch-json";
import { useT } from "../i18n/shared";
import { useNotifications } from "./notifications-context";

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
  const [focusIndex, setFocusIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

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
      // Escape returns focus to the trigger; a menu that closes and drops focus to
      // the document leaves a keyboard user at the top of the page.
      if (e.key === "Escape") { setMenuOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Opening a menu moves focus into it — that is the whole keyboard contract of
  // role="menu", and without it the rows below are unreachable without a mouse.
  useEffect(() => {
    if (!menuOpen) return;
    itemRefs.current[focusIndex]?.focus();
  }, [menuOpen, focusIndex]);

  const state = poll.data ?? null;
  // A null activeCodexAccountId does NOT mean "nothing is active" — it means the
  // MAIN (Codex Desktop) account is routing. Switching to main deliberately PUTs
  // accountId: null, so matching on id alone left the main account permanently
  // unmarked: no tick in the menu, and the avatar fell back to "no account".
  const active = state
    ? state.accounts.find(account => isActiveAccount(account, state.activeId)) ?? null
    : null;

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

  /** Arrow / Home / End movement inside the menu, wrapping at both ends. */
  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const count = state?.accounts.length ?? 0;
    if (count === 0) return;
    const move = (next: number) => {
      event.preventDefault();
      setFocusIndex((next + count) % count);
    };
    if (event.key === "ArrowDown") move(focusIndex + 1);
    else if (event.key === "ArrowUp") move(focusIndex - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(count - 1);
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
          // Open focused on the account that is actually routing, not always the first.
          const activeIndex = state ? state.accounts.findIndex(a => isActiveAccount(a, state.activeId)) : -1;
          setFocusIndex(activeIndex >= 0 ? activeIndex : 0);
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
          className="m3-menu"
          role="menu"
          aria-label={t("switcher.title")}
          style={{ top: "100%", right: 0, minWidth: 260 }}
          onKeyDown={onMenuKeyDown}
        >
          <div className="m3-menu-heading">{t("switcher.title")}</div>
          {state.accounts.map((account, index) => {
            const isActive = isActiveAccount(account, state.activeId);
            const weekly = account.quota?.weeklyPercent;
            const unavailable = !!account.paused;
            return (
              <button
                key={account.id}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                className={`m3-menu-item${unavailable ? " m3-menu-item--unavailable" : ""}`}
                ref={element => { itemRefs.current[index] = element; }}
                // Roving tabindex: the menu takes one Tab stop, arrows move within it.
                tabIndex={index === focusIndex ? 0 : -1}
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
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
