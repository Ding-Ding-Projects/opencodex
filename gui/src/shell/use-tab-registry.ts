/**
 * React glue for the cross-window tab registry.
 *
 * The master tab search has to cover "every open tab across all windows the app
 * owns", and a second window's strip is not something this one can read: they
 * share a `localStorage` key, but that is the last writer's copy, not a live
 * view. So the picture is gathered rather than read — every window announces its
 * own strip on a `BroadcastChannel`, and this hook keeps the announcements it
 * has heard.
 *
 * All of the protocol — the announcement cadence, the freshness deadline that
 * drops a window which closed without saying goodbye, the command envelope —
 * lives in `shared/m3/tab-registry.ts`, which the docs site uses too. This file
 * is `useState`, an effect, and the two refs that keep the effect from
 * re-subscribing every time the strip changes.
 *
 * With no `BroadcastChannel` (an older browser, a hardened profile) it degrades
 * to this window alone, and the master search then honestly shows every tab it
 * can see — which is this window's.
 */

import { useEffect, useRef, useState } from "react";
import {
  createTabRegistry, newWindowId,
  type RemoteTab, type SelfWindow, type TabCommand, type WindowSnapshot,
} from "../../../shared/m3/tab-registry";
import type { Tab, TabsApi } from "./use-tabs";

/** Its own channel, so the dashboard and the docs site never see each other. */
const CHANNEL = "ocx-gui:tabs";

export interface TabRegistryState {
  peers: WindowSnapshot[];
  self: SelfWindow;
  send: (command: TabCommand) => void;
}

export function useTabRegistry(tabs: TabsApi, labelOf: (tab: Tab) => string): TabRegistryState {
  const [peers, setPeers] = useState<WindowSnapshot[]>([]);
  // Created once per mount. A fresh id per render would make every render look
  // like a new window to every peer, and the peer lists would grow without bound.
  // `openedAt: 0` sorts this window first in `numberWindows`, so "Window 1" is
  // always the one the user is looking at. That is a more useful guarantee than
  // a true open time, which would make your own window's number change as other
  // windows come and go.
  const [self] = useState<SelfWindow>(() => ({ windowId: newWindowId(), openedAt: 0 }));
  const send = useRef<(command: TabCommand) => void>(() => {});
  const publish = useRef<() => void>(() => {});

  // Read through refs so the subscription is created once rather than being torn
  // down and rebuilt on every keystroke that changes a tab label.
  const tabsRef = useRef(tabs);
  const labelRef = useRef(labelOf);
  useEffect(() => { tabsRef.current = tabs; labelRef.current = labelOf; });

  useEffect(() => {
    const registry = createTabRegistry({
      windowId: self.windowId,
      channelName: CHANNEL,
      getSnapshot: () => {
        const current = tabsRef.current;
        const label = labelRef.current;
        return {
          // Labels only — never page contents. A peer learns what this window
          // has open, not what any of it says.
          tabs: current.tabs.map((tab): RemoteTab => ({
            id: tab.id,
            label: label(tab),
            page: tab.page,
            pinned: tab.pinned,
            groupId: tab.groupId,
            active: tab.id === current.activeTab,
          })),
          groups: current.groups.map(group => ({ id: group.id, name: group.name, collapsed: group.collapsed })),
        };
      },
      onCommand: command => {
        const current = tabsRef.current;
        if (!current.tabs.some(tab => tab.id === command.tabId)) return;
        if (command.type === "activate") current.selectTab(command.tabId);
        else current.closeTab(command.tabId);
      },
    });
    send.current = registry.send;
    publish.current = registry.publish;
    const stop = registry.subscribe(setPeers);
    return () => { stop(); registry.dispose(); };
  }, [self.windowId]);

  // Announce whenever this window's strip actually changes. The registry also
  // publishes on its own interval, which is what keeps a peer's freshness
  // deadline met; this is the low-latency path, so a tab the user just opened
  // shows up in another window's master search now rather than a ping later.
  useEffect(() => { publish.current(); }, [tabs.tabs, tabs.groups, tabs.activeTab]);

  return { peers, self, send: command => send.current(command) };
}
