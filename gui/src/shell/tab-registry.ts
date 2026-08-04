/**
 * Which windows this app has open, and what is in their tab strips.
 *
 * The master tab search is required to cover "every open tab across all windows,
 * workspaces, strips, and groups the app owns". The shell persists one strip
 * under `ocx-m3:tabs`, but that is the *last writer's* copy rather than a live
 * view: a window that has been open for ten minutes holds a strip storage has
 * not heard about. So the picture is gathered rather than read — every window
 * announces its own snapshot and the master search unions the announcements.
 *
 * The desktop app runs one `BrowserWindow` today (`electron/main.mjs`), so in
 * practice this usually resolves to exactly one strip — this window's. That is
 * the honest answer to "every window", not a placeholder for one: the search
 * says "This window" on every row and means it. The machinery is here because
 * the alternative is a master search that is a copy of the strip search with a
 * different heading, and because a second window is a `new BrowserWindow` away.
 *
 * `BroadcastChannel` and not the `storage` event, for two reasons. The storage
 * event does not fire in the window that wrote it, so a registry built on it
 * would need a second path for self; and writing a heartbeat into storage means
 * every window racing every other over one key, which is the exact clobbering
 * this exists to see past.
 *
 * Presence is by announcement with a deadline, not by a farewell. A window that
 * is closed, crashed, or discarded sends no goodbye, so a registry that removed
 * peers only on `pagehide` would accumulate ghosts and offer tabs in windows
 * that no longer exist. Peers unheard from for `PEER_TTL_MS` are dropped.
 *
 * What this module deliberately does NOT do: own tab state, persist anything, or
 * reach the network. It carries snapshots and two commands between windows of
 * one app, and holds nothing a reload would need.
 */

/** Re-announce this often, so a peer's freshness deadline keeps being met. */
export const PING_MS = 4_000;
/** A peer unheard from for this long is treated as gone. Two missed pings plus slack. */
export const PEER_TTL_MS = 10_000;

const CHANNEL = "ocx-m3:tabs:registry";

/** One tab as another window's search sees it. Labels only — never page contents. */
export interface RemoteTab {
  id: string;
  label: string;
  pinned: boolean;
  groupId?: string;
  groupName?: string;
  groupCollapsed: boolean;
  active: boolean;
}

export interface WindowSnapshot {
  windowId: string;
  /** When that window first announced itself, so numbering is stable and ordered. */
  openedAt: number;
  /** When this snapshot arrived here, for the freshness deadline. */
  seenAt: number;
  /** Which strip inside that window; one per window today, named so results stay readable. */
  strip: string;
  tabs: RemoteTab[];
}

/** The two things the master search may ask another window to do to one of its tabs. */
export type TabCommand =
  | { type: "activate"; windowId: string; tabId: string }
  | { type: "close"; windowId: string; tabId: string };

type Message =
  | { kind: "snapshot"; snapshot: Omit<WindowSnapshot, "seenAt"> }
  | { kind: "hello"; windowId: string }
  | { kind: "bye"; windowId: string }
  | { kind: "command"; command: TabCommand };

/** This window's own identity, for numbering and for addressing commands. */
export interface SelfWindow {
  windowId: string;
  openedAt: number;
}

export interface TabRegistry {
  self: SelfWindow;
  /** Announce this window's strip. Call whenever the strip changes. */
  publish: () => void;
  /** Peers only — this window is never listed, since the caller already has it. */
  subscribe: (listener: (peers: WindowSnapshot[]) => void) => () => void;
  send: (command: TabCommand) => void;
  dispose: () => void;
}

export interface TabRegistryOptions {
  windowId: string;
  /** Read the current strip. Called on every publish and on every peer's hello. */
  getSnapshot: () => { strip: string; tabs: RemoteTab[] };
  /** A command another window addressed to this one. */
  onCommand: (command: TabCommand) => void;
  channelName?: string;
}

/** Unique per window even when two open in the same millisecond. */
export function newWindowId(): string {
  return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Stable display numbers for windows.
 *
 * Ordered by when each window first announced itself rather than by id, so
 * "Window 2" keeps meaning the same window for as long as it is open. Closing
 * window 2 does renumber the ones after it — the alternative is remembering
 * numbers for windows that will never come back, which is a leak in exchange
 * for a label.
 */
export function numberWindows(peers: WindowSnapshot[], selfOpenedAt: number, selfId: string): Map<string, number> {
  const ordered = peers
    .map(peer => ({ id: peer.windowId, at: peer.openedAt }))
    .concat([{ id: selfId, at: selfOpenedAt }])
    .sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at - b.at));
  return new Map(ordered.map((entry, index) => [entry.id, index + 1]));
}

/** Drop peers whose last snapshot is older than the deadline. */
export function livePeers(peers: WindowSnapshot[], now: number, ttl = PEER_TTL_MS): WindowSnapshot[] {
  return peers.filter(peer => now - peer.seenAt <= ttl);
}

export function createTabRegistry(options: TabRegistryOptions): TabRegistry {
  const { windowId, getSnapshot, onCommand, channelName = CHANNEL } = options;
  const openedAt = Date.now();
  const peers = new Map<string, WindowSnapshot>();
  const listeners = new Set<(peers: WindowSnapshot[]) => void>();

  // No BroadcastChannel (a hardened profile, or a test DOM that has none)
  // degrades to this window alone. The master search then says "every open tab"
  // and shows one window's worth, which is true — this window is every window
  // it can see.
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
    const { strip, tabs } = getSnapshot();
    post({ kind: "snapshot", snapshot: { windowId, openedAt, strip, tabs } });
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
      // so a farewell after the flag is a farewell nobody hears and the peers
      // would carry this window as a ghost until the TTL expired.
      farewell();
      disposed = true;
      listeners.clear();
      channel?.close();
    },
  };
}
