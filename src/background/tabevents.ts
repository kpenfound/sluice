import type { Store, UpdateTrackedTabInput } from "../lib/store";
import { SESSION_KEY, buildTrackedTab, parseSessionValue } from "../lib/lifecycle";

/** The injected dependencies tab-event handlers need. No global `browser`, no module state. */
export interface TabEventDeps {
  store: Store;
  sessions: {
    getTabValue: typeof browser.sessions.getTabValue;
  };
  newId: () => string;
  now: () => number;
}

/**
 * Tracks a newly created tab, unless it is in a private window. Adopts its `sessions` value
 * (trackId/keepOpen) when present and not already in use by another tracked tab.
 */
export function handleCreated(deps: TabEventDeps, tab: browser.tabs.Tab): Promise<void> {
  if (tab.incognito || tab.id === undefined) return Promise.resolve();
  const tabId = tab.id;

  return Promise.all([deps.sessions.getTabValue(tabId, SESSION_KEY), deps.store.getTrackedTabs()]).then(
    ([raw, tracked]) => {
      const sessionValue = parseSessionValue(raw);
      const takenTrackIds = new Set(
        tracked.filter((other) => other.tabId !== tabId).map((other) => other.trackId),
      );
      const record = buildTrackedTab(
        {
          id: tabId,
          windowId: tab.windowId ?? 0,
          active: tab.active,
          url: tab.url ?? "",
          title: tab.title ?? "",
          favIconUrl: tab.favIconUrl,
        },
        sessionValue,
        takenTrackIds,
        deps.newId(),
        deps.now(),
      );
      return deps.store.trackTab(record).then(() => undefined);
    },
  );
}

/** Clears the newly active tab's timer and starts the previously active tab's timer. */
export function handleActivated(
  deps: TabEventDeps,
  { tabId, windowId }: browser.tabs._OnActivatedActiveInfo,
): Promise<void> {
  return deps.store.activateTab(tabId, windowId);
}

/** Forwards a changed url/title/favIconUrl to the store, unless the tab is in a private window. */
export function handleUpdated(
  deps: TabEventDeps,
  tabId: number,
  changeInfo: browser.tabs._OnUpdatedChangeInfo,
  tab: browser.tabs.Tab,
): Promise<void> {
  if (tab.incognito) return Promise.resolve();

  const patch: UpdateTrackedTabInput = {};
  if (changeInfo.url !== undefined) patch.url = changeInfo.url;
  if (changeInfo.title !== undefined) patch.title = changeInfo.title;
  if (changeInfo.favIconUrl !== undefined) patch.favIconUrl = changeInfo.favIconUrl;
  if (Object.keys(patch).length === 0) return Promise.resolve();

  return deps.store.updateTrackedTab(tabId, patch).then(() => undefined);
}

/** Updates a tracked tab's window id after it moves to another window. */
export function handleAttached(
  deps: TabEventDeps,
  tabId: number,
  { newWindowId }: browser.tabs._OnAttachedAttachInfo,
): Promise<void> {
  return deps.store.updateTrackedTab(tabId, { windowId: newWindowId }).then(() => undefined);
}

/** Removes a tab's tracking record, adding it to "Recently closed" when eligible. */
export function handleRemoved(deps: TabEventDeps, tabId: number): Promise<void> {
  return deps.store.recordTabClosed(tabId).then(() => undefined);
}
