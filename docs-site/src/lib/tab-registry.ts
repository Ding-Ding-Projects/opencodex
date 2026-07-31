/**
 * Who else has this site open, and what is in their tab strips.
 *
 * The master tab search is required to cover "every open tab across all windows,
 * workspaces, strips, and groups the app owns". On a website, a *window* is a
 * browser tab or window with this site loaded, each running its own strip island.
 * They already share one persisted strip in `localStorage`, but that is the last
 * writer's copy, not a live view — a window that has been open for ten minutes
 * holds a strip that storage has not heard about. So the live picture is
 * gathered rather than read: every window announces its own snapshot, and the
 * master search unions the announcements.
 *
 * `BroadcastChannel` and not the `storage` event, for two reasons. The storage
 * event does not fire in the window that wrote it, so a registry built on it
 * would need a second path for self; and writing a heartbeat into storage means
 * every window's registry racing every other window's over the same key, which
 * is the exact clobbering this exists to see past.
 *
 * Presence is by announcement with a deadline, not by a farewell message. A
 * window that is closed, crashed, discarded by the browser to save memory, or
 * frozen in the back/forward cache sends no goodbye, so a registry that removed
 * peers only on `pagehide` would accumulate ghosts and offer the reader tabs in
 * windows that no longer exist. Peers older than `PEER_TTL_MS` are dropped, and
 * every window re-announces on `PING_MS` — so the worst case is a stale row for
 * a few seconds, and the row's action reports honestly that nothing answered.
 *
 * What this module deliberately does NOT do: own tab state, persist anything, or
 * reach the network. It carries snapshots and two commands between documents on
 * one origin, and it holds nothing a reload would need.
 */

/** Re-announce this often, so a peer's freshness deadline keeps being met. */
export const PING_MS = 4_000;
/** A peer unheard from for this long is treated as gone. Two missed pings plus slack. */
export const PEER_TTL_MS = 10_000;

/** One tab, as another window's search sees it. Labels only — never page contents. */
export interface RemoteTab {
  id: string;
  label: string;
  page: string;
  pinned: boolean;
  groupId?: string;
  active: boolean;
}

export interface RemoteGroup {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface WindowSnapshot {
  windowId: string;
  /** When that window first announced itself, so the numbering is stable and ordered. */
  openedAt: number;
  /** When this snapshot arrived here, for the freshness deadline. */
  seenAt: number;
  tabs: RemoteTab[];
  groups: RemoteGroup[];
}

/** The two things the master search can ask another window to do to one of its tabs. */
export type TabCommand =
  | { type: "activate"; windowId: string; tabId: string }
  | { type: "close"; windowId: string; tabId: string };

type Message =
  | { kind: "snapshot"; snapshot: Omit<WindowSnapshot, "seenAt"> }
  | { kind: "hello"; windowId: string }
  | { kind: "bye"; windowId: string }
  | { kind: "command"; command: TabCommand };

export interface TabRegistry {
  /** This window's own id and first-announcement time, for `numberWindows`. */
  self: SelfWindow;
  /** Announce this window's strip. Call whenever the strip changes. */
  publish: () => void;
  /** Peers only — this window is never in the list, since the caller already has it. */
  subscribe: (listener: (peers: WindowSnapshot[]) => void) => () => void;
  /** Ask another window to act on one of its tabs. */
  send: (command: TabCommand) => void;
  dispose: () => void;
}

export interface TabRegistryOptions {
  windowId: string;
  /** Read the current strip. Called on every publish and on every peer's hello. */
  getSnapshot: () => { tabs: RemoteTab[]; groups: RemoteGroup[] };
  /** A command another window addressed to this one. */
  onCommand: (command: TabCommand) => void;
  channelName?: string;
}

/** Unique per document even when two windows open in the same millisecond. */
export function newWindowId(): string {
  return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Stable display numbers for peers.
 *
 * Ordered by when each window first announced itself rather than by id, so
 * "Window 2" keeps meaning the same window for as long as it is open. Closing
 * window 2 does renumber the ones after it — the alternative is remembering
 * numbers for windows that will never come back, which is a leak in exchange for
 * a label.
 */
export function numberWindows(peers: WindowSnapshot[], selfOpenedAt: number, selfId: string): Map<string, number> {
  const ordered = peers
    .map(p => ({ id: p.windowId, at: p.openedAt }))
    .concat([{ id: selfId, at: selfOpenedAt }])
    .sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at - b.at));
  return new Map(ordered.map((entry, index) => [entry.id, index + 1]));
}

/** Drop peers whose last snapshot is older than the deadline. */
export function livePeers(peers: WindowSnapshot[], now: number, ttl = PEER_TTL_MS): WindowSnapshot[] {
  return peers.filter(peer => now - peer.seenAt <= ttl);
}

export function createTabRegistry(options: TabRegistryOptions): TabRegistry {
  const { windowId, getSnapshot, onCommand, channelName = "ocx-docs:tabs" } = options;
  const openedAt = Date.now();
  const peers = new Map<string, WindowSnapshot>();
  const listeners = new Set<(peers: WindowSnapshot[]) => void>();

  // No BroadcastChannel (older Safari, a hardened profile) degrades to this
  // window alone. The master search then says "every open tab" and shows one
  // window's worth, which is true — this window is every window it can see.
  const channel: BroadcastChannel | null =
    typeof BroadcastChannel === "function" ? new BroadcastChannel(channelName) : null;

  let disposed = false;

  const emit = () => {
    const live = livePeers([...peers.values()], Date.now());
    if (live.length !== peers.size) {
      peers.clear();
      for (const peer of live) peers.set(peer.windowId, peer);
    }
    for (const listener of listeners) listener(live);
  };

  const post = (message: Message) => {
    if (!channel || disposed) return;
    try { channel.postMessage(message); } catch { /* a closed channel or an unclonable payload */ }
  };

  const publish = () => {
    const { tabs, groups } = getSnapshot();
    post({ kind: "snapshot", snapshot: { windowId, openedAt, tabs, groups } });
  };

  if (channel) {
    channel.onmessage = (event: MessageEvent<Message>) => {
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (message.kind === "snapshot") {
        if (message.snapshot.windowId === windowId) return;
        peers.set(message.snapshot.windowId, { ...message.snapshot, seenAt: Date.now() });
        emit();
        return;
      }
      if (message.kind === "hello") {
        // A window that just opened has no idea who is out there, and waiting a
        // whole ping interval to find out makes the master search look empty at
        // exactly the moment somebody opened it.
        if (message.windowId !== windowId) publish();
        return;
      }
      if (message.kind === "bye") {
        if (peers.delete(message.windowId)) emit();
        return;
      }
      if (message.kind === "command" && message.command.windowId === windowId) {
        onCommand(message.command);
      }
    };
  }

  const timer = channel ? setInterval(() => { publish(); emit(); }, PING_MS) : null;

  /** A polite goodbye when there is one to give; the TTL covers when there is not. */
  const farewell = () => post({ kind: "bye", windowId });
  if (typeof window !== "undefined") window.addEventListener("pagehide", farewell);

  post({ kind: "hello", windowId });
  publish();

  return {
    self: { windowId, openedAt },
    publish,
    subscribe: listener => {
      listeners.add(listener);
      listener(livePeers([...peers.values()], Date.now()));
      return () => { listeners.delete(listener); };
    },
    send: command => post({ kind: "command", command }),
    dispose: () => {
      if (timer) clearInterval(timer);
      if (typeof window !== "undefined") window.removeEventListener("pagehide", farewell);
      // Said before the guard goes up: `post` refuses to send once `disposed`,
      // so a farewell after the flag is a farewell nobody hears, and the peers
      // would carry this window as a ghost until the TTL expired.
      farewell();
      disposed = true;
      listeners.clear();
      channel?.close();
    },
  };
}

/** This window's own identity in the registry, for the master search's grouping. */
export interface SelfWindow {
  windowId: string;
  openedAt: number;
}
