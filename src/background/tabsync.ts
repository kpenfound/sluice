import type { Store } from "../lib/store";
import { SESSION_KEY, buildTrackedTab, parseSessionValue, tabsToClose } from "../lib/lifecycle";
import type { LiveTab, TrackedTab } from "../lib/lifecycle";

/** What the tab-sync functions need: a store, the `tabs`/`sessions` members they call, and injected id/time sources. */
export interface TabSyncDeps {
  store: Store;
  tabs: {
    query: typeof browser.tabs.query;
    remove: typeof browser.tabs.remove;
  };
  sessions: {
    getTabValue: typeof browser.sessions.getTabValue;
    setTabValue: typeof browser.sessions.setTabValue;
  };
  newId: () => string;
  now: () => number;
}

/**
 * Rebuilds `trackedTabs` from the tabs open right now, skipping incognito ones. With
 * `restoring: true` (startup), every existing record is discarded first, without adding
 * any of them to "Recently closed" — stale records are simply dropped. With
 * `restoring: false` (install), the existing record for a tab id that is still open is
 * kept as-is; every other open tab is built fresh via `buildTrackedTab`, adopting its
 * parsed `sessions` value when the carried trackId isn't already taken in this pass.
 * Finally removes any "Recently closed" entry whose trackId was adopted from a `sessions`
 * value, since that tab is open again.
 */
export async function reconcileTabs(
  deps: TabSyncDeps,
  options: { restoring: boolean },
): Promise<void> {
  const { store, tabs, sessions, newId, now } = deps;

  const liveTabs = await tabs.query({});
  const normalTabs = liveTabs.filter((tab) => !tab.incognito && tab.id !== undefined);

  const existing = options.restoring ? [] : await store.getTrackedTabs();
  const existingByTabId = new Map(existing.map((tab) => [tab.tabId, tab]));

  const takenTrackIds = new Set(existing.map((tab) => tab.trackId));
  const adoptedTrackIds: string[] = [];
  const records: TrackedTab[] = [];

  for (const tab of normalTabs) {
    const tabId = tab.id!;
    const kept = existingByTabId.get(tabId);
    if (kept !== undefined) {
      records.push(kept);
      continue;
    }

    const rawSessionValue = await sessions.getTabValue(tabId, SESSION_KEY);
    const sessionValue = parseSessionValue(rawSessionValue);
    const record = buildTrackedTab(
      {
        id: tabId,
        windowId: tab.windowId ?? -1,
        active: tab.active,
        url: tab.url ?? "",
        title: tab.title ?? "",
        favIconUrl: tab.favIconUrl,
      },
      sessionValue,
      takenTrackIds,
      newId(),
      now(),
    );

    takenTrackIds.add(record.trackId);
    if (sessionValue !== null && record.trackId === sessionValue.trackId) {
      adoptedTrackIds.push(record.trackId);
    }
    records.push(record);
  }

  await store.replaceTrackedTabs(records);
  await store.removeClosedByTrackIds(adoptedTrackIds);
}

/**
 * Closes every tracked tab that `lifecycle.ts`'s `tabsToClose` finds expired against the
 * live tab set, making no `tabs.remove` call when none are expired. The resulting
 * "Recently closed" entry comes from the `onRemoved` event this triggers, not from here.
 */
export async function closeExpired(deps: TabSyncDeps): Promise<void> {
  const { store, tabs, now } = deps;

  const [tracked, timeout, liveTabs] = await Promise.all([
    store.getTrackedTabs(),
    store.getAutoCloseAfter(),
    tabs.query({}),
  ]);

  const live: LiveTab[] = liveTabs
    .filter((tab) => tab.id !== undefined)
    .map((tab) => ({
      id: tab.id!,
      active: tab.active,
      audible: tab.audible ?? false,
      incognito: tab.incognito,
      url: tab.url ?? "",
    }));

  const toClose = tabsToClose(tracked, live, timeout, now());
  if (toClose.length > 0) await tabs.remove(toClose);
}

/**
 * Mirrors each record in `current` whose trackId or keepOpen is new or changed since
 * `previous` into its `sessions` tab value. A rejected `setTabValue` (e.g. the tab closed
 * meanwhile) is caught and doesn't stop the rest.
 */
export async function syncSessionValues(
  deps: TabSyncDeps,
  previous: TrackedTab[],
  current: TrackedTab[],
): Promise<void> {
  const { sessions } = deps;
  const previousByTabId = new Map(previous.map((tab) => [tab.tabId, tab]));

  const changed = current.filter((tab) => {
    const before = previousByTabId.get(tab.tabId);
    return before === undefined || before.trackId !== tab.trackId || before.keepOpen !== tab.keepOpen;
  });

  await Promise.all(
    changed.map((tab) =>
      sessions
        .setTabValue(tab.tabId, SESSION_KEY, { trackId: tab.trackId, keepOpen: tab.keepOpen })
        .catch(() => undefined),
    ),
  );
}
