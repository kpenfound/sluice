import { createStore } from "../lib/store";
import type { Store, StorageNamespace } from "../lib/store";
import type { TrackedTab } from "../lib/lifecycle";
import { badgeText } from "./badge";
import { handleVisited } from "./revisit";
import { tick } from "./tick";
import {
  handleActivated,
  handleAttached,
  handleCreated,
  handleRemoved,
  handleUpdated,
} from "./tabevents";
import type { TabEventDeps } from "./tabevents";
import { closeExpired, reconcileTabs, syncSessionValues } from "./tabsync";
import type { TabSyncDeps } from "./tabsync";

const ALARM_NAME = "sluice-tick";
const LAUNCHER_PAGE = "newtab.html";

/** The `browser` members the background script's event wiring uses. */
export interface BackgroundApi {
  storage: StorageNamespace;
  alarms: {
    get(name: string): Promise<browser.alarms.Alarm | undefined>;
    create(name: string, alarmInfo: browser.alarms._CreateAlarmInfo): Promise<void>;
    onAlarm: typeof browser.alarms.onAlarm;
  };
  commands: {
    onCommand: typeof browser.commands.onCommand;
  };
  history: {
    onVisited: typeof browser.history.onVisited;
  };
  runtime: {
    onInstalled: typeof browser.runtime.onInstalled;
    onStartup: typeof browser.runtime.onStartup;
    getURL: typeof browser.runtime.getURL;
  };
  tabs: {
    create: typeof browser.tabs.create;
    query: typeof browser.tabs.query;
    remove: typeof browser.tabs.remove;
    onCreated: typeof browser.tabs.onCreated;
    onActivated: typeof browser.tabs.onActivated;
    onUpdated: typeof browser.tabs.onUpdated;
    onAttached: typeof browser.tabs.onAttached;
    onRemoved: typeof browser.tabs.onRemoved;
  };
  sessions: {
    getTabValue: typeof browser.sessions.getTabValue;
    setTabValue: typeof browser.sessions.setTabValue;
  };
  action: {
    setBadgeText: typeof browser.action.setBadgeText;
  };
}

/** Creates the repeating alarm named `ALARM_NAME`, unless one is already registered. */
function ensureAlarm(api: BackgroundApi): Promise<void> {
  return api.alarms.get(ALARM_NAME).then((existing) => {
    if (existing !== undefined) return;
    return api.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  });
}

/**
 * Runs the per-minute duties: writes `lastActiveAt`, prunes pauses, sets the badge, closes
 * expired tabs and prunes "Recently closed".
 */
async function runTick(api: BackgroundApi, store: Store, tabSyncDeps: TabSyncDeps): Promise<void> {
  await tick({ store, setBadgeText: (text) => api.action.setBadgeText({ text }), now: tabSyncDeps.now });
  await closeExpired(tabSyncDeps);
  await store.pruneRecentlyClosed();
}

/** Recomputes the badge from fresh store reads and sets it. */
async function refreshBadge(api: BackgroundApi, store: Store): Promise<void> {
  const [buckets, items, pauses] = await Promise.all([
    store.getBuckets(),
    store.getItems(),
    store.getPauses(),
  ]);
  await api.action.setBadgeText({ text: badgeText(buckets, items, pauses, Date.now()) });
}

/**
 * Registers every background listener synchronously against `api`, then ensures the
 * per-minute alarm exists. Carries no state between events: each handler reads
 * whatever it needs from storage through a store built fresh from `api.storage`, and the
 * one piece of state kept across events within a single `start()` call — the previous
 * `trackedTabs` array, for mirroring changes to `sessions` — lives in this function's own
 * closure, not at module level, so two `start()` calls stay independent.
 */
export function start(api: BackgroundApi): void {
  const now = Date.now;
  const newId = (): string => crypto.randomUUID();
  const store = createStore(api.storage, { now, newId });

  const tabEventDeps: TabEventDeps = { store, sessions: api.sessions, newId, now };
  const tabSyncDeps: TabSyncDeps = { store, tabs: api.tabs, sessions: api.sessions, newId, now };

  let previousTrackedTabs: TrackedTab[] = [];

  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) void runTick(api, store, tabSyncDeps);
  });

  api.history.onVisited.addListener((item) => {
    void handleVisited(store, item);
  });

  api.commands.onCommand.addListener((command) => {
    if (command !== "open-launcher") return;
    void api.tabs.create({ url: api.runtime.getURL(LAUNCHER_PAGE) });
  });

  api.tabs.onCreated.addListener((tab) => {
    void handleCreated(tabEventDeps, tab);
  });
  api.tabs.onActivated.addListener((activeInfo) => {
    void handleActivated(tabEventDeps, activeInfo);
  });
  api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    void handleUpdated(tabEventDeps, tabId, changeInfo, tab);
  });
  api.tabs.onAttached.addListener((tabId, attachInfo) => {
    void handleAttached(tabEventDeps, tabId, attachInfo);
  });
  api.tabs.onRemoved.addListener((tabId) => {
    void handleRemoved(tabEventDeps, tabId);
  });

  api.runtime.onInstalled.addListener(() => {
    void reconcileTabs(tabSyncDeps, { restoring: false })
      .then(() => ensureAlarm(api))
      .then(() => runTick(api, store, tabSyncDeps));
  });
  api.runtime.onStartup.addListener(() => {
    void store
      .recordAwayGap()
      .then(() => reconcileTabs(tabSyncDeps, { restoring: true }))
      .then(() => ensureAlarm(api))
      .then(() => runTick(api, store, tabSyncDeps));
  });

  store.subscribe((changes) => {
    void refreshBadge(api, store);

    if ("trackedTabs" in changes) {
      const current = (changes.trackedTabs?.newValue as TrackedTab[] | undefined) ?? [];
      void syncSessionValues(tabSyncDeps, previousTrackedTabs, current);
      previousTrackedTabs = current;
    }
  });

  void ensureAlarm(api);
}
