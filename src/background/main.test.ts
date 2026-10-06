import { describe, expect, test } from "vitest";
import { start } from "./main";
import type { BackgroundApi } from "./main";
import { createStore } from "../lib/store";
import type { StorageChange, StorageNamespace } from "../lib/store";
import { HOUR } from "../lib/model";

type Listener = (changes: Record<string, StorageChange>, areaName: string) => void;

/** An in-memory fake of `storage.local` and `storage.onChanged`, local to this test file. */
class FakeStorage implements StorageNamespace {
  private data: Record<string, unknown> = {};
  private listeners: Listener[] = [];

  local = {
    get: (keys: string | string[]): Promise<Record<string, unknown>> => {
      const keyList = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of keyList) {
        if (key in this.data) result[key] = this.data[key];
      }
      return Promise.resolve(result);
    },
    set: (items: Record<string, unknown>): Promise<void> => {
      const changes: Record<string, StorageChange> = {};
      for (const [key, newValue] of Object.entries(items)) {
        changes[key] = { oldValue: this.data[key], newValue };
        this.data[key] = newValue;
      }
      for (const listener of this.listeners) listener(changes, "local");
      return Promise.resolve();
    },
  };

  onChanged = {
    addListener: (listener: Listener): void => {
      this.listeners.push(listener);
    },
    removeListener: (listener: Listener): void => {
      this.listeners = this.listeners.filter((existing) => existing !== listener);
    },
  };

  peek(key: string): unknown {
    return this.data[key];
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
}

/** A fake `WebExtEvent`: records listeners and lets the test fire them. */
class FakeEvent<TCallback extends (...args: never[]) => unknown> {
  private listeners: TCallback[] = [];

  addListener = (cb: TCallback): void => {
    this.listeners.push(cb);
  };

  removeListener = (cb: TCallback): void => {
    this.listeners = this.listeners.filter((existing) => existing !== cb);
  };

  hasListener = (cb: TCallback): boolean => this.listeners.includes(cb);

  get count(): number {
    return this.listeners.length;
  }

  fire(...args: Parameters<TCallback>): void {
    for (const listener of this.listeners) listener(...args);
  }
}

/** A fake `browser.alarms`, tracking created alarms and recording `create` calls. */
class FakeAlarms {
  private alarms = new Map<string, browser.alarms.Alarm>();
  createCalls: Array<{ name: string; alarmInfo: browser.alarms._CreateAlarmInfo }> = [];
  onAlarm = new FakeEvent<(alarm: browser.alarms.Alarm) => void>();

  get = (name: string): Promise<browser.alarms.Alarm | undefined> => {
    return Promise.resolve(this.alarms.get(name));
  };

  create = (name: string, alarmInfo: browser.alarms._CreateAlarmInfo): Promise<void> => {
    this.createCalls.push({ name, alarmInfo });
    this.alarms.set(name, { name, scheduledTime: 0, periodInMinutes: alarmInfo.periodInMinutes });
    return Promise.resolve();
  };

  seed(name: string): void {
    this.alarms.set(name, { name, scheduledTime: 0, periodInMinutes: 1 });
  }
}

/**
 * A fake `browser.tabs`, holding the live tab set `query` returns, recording `remove` calls,
 * and exposing the five tab lifecycle events as `FakeEvent`s. `remove` mimics Firefox by
 * dropping the tab from the live set and firing `onRemoved`, since `closeExpired` relies on
 * that event (not its own `tabs.remove` call) to put a closed tab into "Recently closed".
 */
class FakeTabs {
  tabs: browser.tabs.Tab[] = [];
  createdTabs: Array<browser.tabs._CreateCreateProperties> = [];
  removed: number[][] = [];

  onCreated = new FakeEvent<(tab: browser.tabs.Tab) => void>();
  onActivated = new FakeEvent<(activeInfo: browser.tabs._OnActivatedActiveInfo) => void>();
  onUpdated = new FakeEvent<
    (tabId: number, changeInfo: browser.tabs._OnUpdatedChangeInfo, tab: browser.tabs.Tab) => void
  >();
  onAttached = new FakeEvent<(tabId: number, attachInfo: browser.tabs._OnAttachedAttachInfo) => void>();
  onRemoved = new FakeEvent<(tabId: number, removeInfo: browser.tabs._OnRemovedRemoveInfo) => void>();

  create = (createProperties: browser.tabs._CreateCreateProperties): Promise<browser.tabs.Tab> => {
    this.createdTabs.push(createProperties);
    return Promise.resolve({
      id: this.createdTabs.length,
      index: 0,
      windowId: 1,
      highlighted: false,
      active: false,
      pinned: false,
      incognito: false,
      url: createProperties.url,
    } as browser.tabs.Tab);
  };

  query = (_queryInfo: browser.tabs._QueryQueryInfo): Promise<browser.tabs.Tab[]> =>
    Promise.resolve(this.tabs.slice());

  remove = (tabIds: number | number[]): Promise<void> => {
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
    this.removed.push(ids);
    for (const id of ids) {
      this.tabs = this.tabs.filter((tab) => tab.id !== id);
      this.onRemoved.fire(id, { windowId: 1, isWindowClosing: false });
    }
    return Promise.resolve();
  };
}

/** A fake `browser.sessions`, holding a per-tab `sluice` value map and recording `setTabValue` calls. */
class FakeSessions {
  values = new Map<number, unknown>();
  setCalls: Array<{ tabId: number; value: unknown }> = [];

  getTabValue = (tabId: number, _key: string): Promise<string | object | undefined> =>
    Promise.resolve(this.values.get(tabId) as string | object | undefined);

  setTabValue = (tabId: number, _key: string, value: unknown): Promise<void> => {
    this.setCalls.push({ tabId, value });
    this.values.set(tabId, value);
    return Promise.resolve();
  };
}

/** A tab fixture, filling in every field the handlers or `Tab`'s required fields need. */
function makeTab(overrides: Partial<browser.tabs.Tab> & { id: number }): browser.tabs.Tab {
  return {
    index: 0,
    windowId: 1,
    highlighted: false,
    active: false,
    pinned: false,
    audible: false,
    incognito: false,
    url: "https://example.com/",
    title: "Example",
    ...overrides,
  };
}

/** Drains pending microtasks and macrotasks, for assertions after an un-awaited handler fires. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeApi(storage: StorageNamespace, alarms: FakeAlarms) {
  const onVisited = new FakeEvent<(item: browser.history.HistoryItem) => void>();
  const onInstalled = new FakeEvent<(details: browser.runtime._OnInstalledDetails) => void>();
  const onStartup = new FakeEvent<() => void>();
  const onCommand = new FakeEvent<(command: string, tab: browser.tabs.Tab) => void>();
  const badgeTexts: Array<string | null> = [];
  const tabs = new FakeTabs();
  const sessions = new FakeSessions();

  const api: BackgroundApi = {
    storage,
    alarms: {
      get: alarms.get,
      create: alarms.create,
      onAlarm: alarms.onAlarm,
    },
    commands: { onCommand },
    history: { onVisited },
    runtime: {
      onInstalled,
      onStartup,
      getURL: (path) => `moz-extension://fake-id/${path}`,
    },
    tabs: {
      create: tabs.create,
      query: tabs.query,
      remove: tabs.remove,
      onCreated: tabs.onCreated,
      onActivated: tabs.onActivated,
      onUpdated: tabs.onUpdated,
      onAttached: tabs.onAttached,
      onRemoved: tabs.onRemoved,
    },
    sessions: {
      getTabValue: sessions.getTabValue,
      setTabValue: sessions.setTabValue,
    },
    action: {
      setBadgeText: (details) => {
        badgeTexts.push(details.text);
        return Promise.resolve();
      },
    },
  };

  return {
    api,
    onVisited,
    onInstalled,
    onStartup,
    onCommand,
    badgeTexts,
    createdTabs: tabs.createdTabs,
    tabs,
    sessions,
  };
}

describe("start", () => {
  test("registers every listener synchronously, before any awaited work", () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onVisited, onInstalled, onStartup, onCommand, tabs } = makeApi(storage, alarms);

    start(api);

    expect(alarms.onAlarm.count).toBe(1);
    expect(onVisited.count).toBe(1);
    expect(onInstalled.count).toBe(1);
    expect(onStartup.count).toBe(1);
    expect(onCommand.count).toBe(1);
    expect(tabs.onCreated.count).toBe(1);
    expect(tabs.onActivated.count).toBe(1);
    expect(tabs.onUpdated.count).toBe(1);
    expect(tabs.onAttached.count).toBe(1);
    expect(tabs.onRemoved.count).toBe(1);
    expect(storage.listenerCount).toBe(1);
  });

  test("creates the alarm with periodInMinutes: 1 when absent", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api } = makeApi(storage, alarms);

    start(api);
    await flush();

    expect(alarms.createCalls).toEqual([
      { name: "sluice-tick", alarmInfo: { periodInMinutes: 1 } },
    ]);
  });

  test("does not re-create the alarm when alarms.get already returns it", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    alarms.seed("sluice-tick");
    const { api } = makeApi(storage, alarms);

    start(api);
    await flush();

    expect(alarms.createCalls).toEqual([]);
  });

  test("firing the alarm runs the per-minute duties", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, badgeTexts } = makeApi(storage, alarms);

    start(api);
    await flush();

    alarms.onAlarm.fire({ name: "sluice-tick", scheduledTime: 0 });
    await flush();

    expect(storage.peek("lastActiveAt")).toBeTypeOf("number");
    expect(badgeTexts.at(-1)).toBe("");
  });

  test("an alarm firing under another name does nothing", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, badgeTexts } = makeApi(storage, alarms);

    start(api);
    await flush();
    badgeTexts.length = 0;

    alarms.onAlarm.fire({ name: "some-other-alarm", scheduledTime: 0 });
    await flush();

    expect(storage.peek("lastActiveAt")).toBeUndefined();
    expect(badgeTexts).toEqual([]);
  });

  test("firing onInstalled runs the per-minute duties", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onInstalled, badgeTexts } = makeApi(storage, alarms);

    start(api);
    onInstalled.fire({ reason: "install", temporary: false });
    await flush();

    expect(storage.peek("lastActiveAt")).toBeTypeOf("number");
    expect(badgeTexts.at(-1)).toBe("");
  });

  test("firing onInstalled tracks untracked open tabs as new, keeping existing records", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onInstalled, tabs } = makeApi(storage, alarms);
    await storage.local.set({
      trackedTabs: [
        {
          tabId: 1,
          windowId: 1,
          trackId: "kept",
          url: "https://example.com/kept",
          title: "Kept",
          keepOpen: false,
          inactiveSince: null,
        },
      ],
    });
    tabs.tabs = [
      makeTab({ id: 1, url: "https://example.com/kept" }),
      makeTab({ id: 2, url: "https://example.com/new" }),
    ];

    start(api);
    onInstalled.fire({ reason: "install", temporary: false });
    await flush();

    const tracked = storage.peek("trackedTabs") as Array<{ tabId: number; trackId: string }>;
    expect(tracked.find((tab) => tab.tabId === 1)?.trackId).toBe("kept");
    expect(tracked.some((tab) => tab.tabId === 2)).toBe(true);
  });

  test("firing onStartup runs the per-minute duties", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onStartup, badgeTexts } = makeApi(storage, alarms);

    start(api);
    onStartup.fire();
    await flush();

    expect(storage.peek("lastActiveAt")).toBeTypeOf("number");
    expect(badgeTexts.at(-1)).toBe("");
  });

  test("firing onStartup with lastActiveAt more than 72h old records an away gap and updates lastActiveAt to now", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onStartup } = makeApi(storage, alarms);
    const oldLastActiveAt = Date.now() - (73 * 60 * 60 * 1000);
    await storage.local.set({ lastActiveAt: oldLastActiveAt });

    start(api);
    onStartup.fire();
    await flush();

    const gap = storage.peek("awayGap") as { start: number; end: number };
    expect(gap.start).toBe(oldLastActiveAt);
    expect(gap.end).toBeTypeOf("number");
    const lastActiveAt = storage.peek("lastActiveAt") as number;
    expect(lastActiveAt).toBeGreaterThan(oldLastActiveAt);
  });

  test("firing onStartup with lastActiveAt exactly 72h old leaves awayGap unset", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onStartup } = makeApi(storage, alarms);
    const exactLastActiveAt = Date.now() - (72 * 60 * 60 * 1000);
    await storage.local.set({ lastActiveAt: exactLastActiveAt });

    start(api);
    onStartup.fire();
    await flush();

    expect(storage.peek("awayGap")).toBeUndefined();
  });

  test("firing onStartup with no prior lastActiveAt leaves awayGap unset", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onStartup } = makeApi(storage, alarms);

    start(api);
    onStartup.fire();
    await flush();

    expect(storage.peek("awayGap")).toBeUndefined();
  });

  test("firing onStartup records the away gap from the stale lastActiveAt, then restores tracking (adopting keepOpen from sessions) before the tick runs", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onStartup, tabs, sessions, badgeTexts } = makeApi(storage, alarms);
    const oldLastActiveAt = Date.now() - (73 * 60 * 60 * 1000);
    await storage.local.set({ lastActiveAt: oldLastActiveAt });
    tabs.tabs = [makeTab({ id: 1, active: true, url: "https://example.com/restored" })];
    sessions.values.set(1, { trackId: "restored-1", keepOpen: true });

    start(api);
    onStartup.fire();
    await flush();

    // recordAwayGap ran against the stale lastActiveAt, not one already bumped by the tick.
    const gap = storage.peek("awayGap") as { start: number };
    expect(gap.start).toBe(oldLastActiveAt);

    // reconcileTabs restored the tab's keepOpen from its sessions value.
    const tracked = storage.peek("trackedTabs") as Array<{
      tabId: number;
      trackId: string;
      keepOpen: boolean;
    }>;
    expect(tracked).toEqual([expect.objectContaining({ tabId: 1, trackId: "restored-1", keepOpen: true })]);

    // The tick ran too, after reconciliation.
    expect(badgeTexts.at(-1)).toBe("");
  });

  test("an alarm tick with an old lastActiveAt records no gap", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api } = makeApi(storage, alarms);
    const oldLastActiveAt = Date.now() - (73 * 60 * 60 * 1000);
    await storage.local.set({ lastActiveAt: oldLastActiveAt });

    start(api);
    await flush();

    alarms.onAlarm.fire({ name: "sluice-tick", scheduledTime: 0 });
    await flush();

    expect(storage.peek("awayGap")).toBeUndefined();
  });

  test("firing onInstalled records no gap", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onInstalled } = makeApi(storage, alarms);
    const oldLastActiveAt = Date.now() - (73 * 60 * 60 * 1000);
    await storage.local.set({ lastActiveAt: oldLastActiveAt });

    start(api);
    onInstalled.fire({ reason: "install", temporary: false });
    await flush();

    expect(storage.peek("awayGap")).toBeUndefined();
  });

  test("firing history.onVisited with a queued URL sets that item's lastVisitedAt", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onVisited } = makeApi(storage, alarms);

    // Seed a queued item directly in storage, the same way `store.addItem` would.
    await storage.local.set({
      buckets: [{ id: "bucket-1", name: "Dagger", order: 0 }],
      items: [
        {
          id: "item-1",
          url: "https://example.com/",
          normUrl: "https://example.com",
          title: "Example",
          bucketId: "bucket-1",
          riffle: "72h",
          queuedAt: 1,
          riffleEnteredAt: 1,
          lastVisitedAt: null,
        },
      ],
    });

    start(api);
    onVisited.fire({ id: "1", url: "https://example.com/" });
    await flush();

    const items = storage.peek("items") as Array<{ lastVisitedAt: number | null }>;
    expect(items[0]!.lastVisitedAt).not.toBeNull();
  });

  test("firing the open-launcher command opens exactly one tab at the launcher URL", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onCommand, createdTabs } = makeApi(storage, alarms);

    start(api);
    onCommand.fire("open-launcher", {} as browser.tabs.Tab);
    await flush();

    expect(createdTabs).toEqual([{ url: "moz-extension://fake-id/newtab.html" }]);
  });

  test("firing an unknown command creates no tab", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onCommand, createdTabs } = makeApi(storage, alarms);

    start(api);
    onCommand.fire("some-other-command", {} as browser.tabs.Tab);
    await flush();

    expect(createdTabs).toEqual([]);
  });

  test("tabs.onCreated tracks a tab, onActivated moves the running timer, and onRemoved adds it to recently closed", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, tabs } = makeApi(storage, alarms);

    start(api);
    await flush();

    tabs.onCreated.fire(makeTab({ id: 1, windowId: 1, active: true, url: "https://example.com/one" }));
    tabs.onCreated.fire(makeTab({ id: 2, windowId: 1, active: false, url: "https://example.com/two" }));
    await flush();

    let tracked = storage.peek("trackedTabs") as Array<{ tabId: number; inactiveSince: number | null }>;
    expect(tracked.find((tab) => tab.tabId === 1)?.inactiveSince).toBeNull();
    expect(tracked.find((tab) => tab.tabId === 2)?.inactiveSince).toBeTypeOf("number");

    tabs.onActivated.fire({ tabId: 2, windowId: 1 });
    await flush();

    tracked = storage.peek("trackedTabs") as Array<{ tabId: number; inactiveSince: number | null }>;
    expect(tracked.find((tab) => tab.tabId === 2)?.inactiveSince).toBeNull();
    expect(tracked.find((tab) => tab.tabId === 1)?.inactiveSince).toBeTypeOf("number");

    tabs.onRemoved.fire(1, { windowId: 1, isWindowClosing: false });
    await flush();

    const afterRemove = storage.peek("trackedTabs") as Array<{ tabId: number }>;
    expect(afterRemove.some((tab) => tab.tabId === 1)).toBe(false);
    const closed = storage.peek("recentlyClosed") as Array<{ url: string }>;
    expect(closed.some((entry) => entry.url === "https://example.com/one")).toBe(true);
  });

  test("the alarm tick closes an expired inactive tab, leaves active and keep-open tabs, and prunes recently closed", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, tabs } = makeApi(storage, alarms);
    const whenNow = Date.now();
    await storage.local.set({
      trackedTabs: [
        {
          tabId: 1,
          windowId: 1,
          trackId: "expired",
          url: "https://example.com/expired",
          title: "Expired",
          keepOpen: false,
          inactiveSince: whenNow - 3 * HOUR,
        },
        {
          tabId: 2,
          windowId: 1,
          trackId: "active",
          url: "https://example.com/active",
          title: "Active",
          keepOpen: false,
          inactiveSince: whenNow - 3 * HOUR,
        },
        {
          tabId: 3,
          windowId: 1,
          trackId: "kept",
          url: "https://example.com/kept",
          title: "Kept",
          keepOpen: true,
          inactiveSince: whenNow - 3 * HOUR,
        },
      ],
      recentlyClosed: [
        {
          id: "stale-entry",
          trackId: "old-track",
          url: "https://old.example.com/",
          normUrl: "https://old.example.com",
          title: "Old",
          closedAt: whenNow - 8 * 24 * HOUR,
        },
      ],
    });
    tabs.tabs = [
      makeTab({ id: 1, windowId: 1, active: false, url: "https://example.com/expired" }),
      makeTab({ id: 2, windowId: 1, active: true, url: "https://example.com/active" }),
      makeTab({ id: 3, windowId: 1, active: false, url: "https://example.com/kept" }),
    ];

    start(api);
    await flush();

    alarms.onAlarm.fire({ name: "sluice-tick", scheduledTime: 0 });
    await flush();

    expect(tabs.removed).toEqual([[1]]);

    const tracked = storage.peek("trackedTabs") as Array<{ tabId: number }>;
    expect(tracked.map((tab) => tab.tabId).sort()).toEqual([2, 3]);

    const closed = storage.peek("recentlyClosed") as Array<{ trackId: string }>;
    expect(closed.some((entry) => entry.trackId === "old-track")).toBe(false);
    expect(closed.some((entry) => entry.trackId === "expired")).toBe(true);
  });

  test("a keep-open change on a tracked tab is mirrored to sessions.setTabValue", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, tabs, sessions } = makeApi(storage, alarms);

    start(api);
    await flush();

    tabs.onCreated.fire(makeTab({ id: 1, windowId: 1, active: false, url: "https://example.com/" }));
    await flush();
    sessions.setCalls.length = 0;

    const otherStore = createStore(storage);
    await otherStore.setKeepOpen(1, true);
    await flush();

    expect(sessions.setCalls).toEqual([
      { tabId: 1, value: { trackId: expect.any(String), keepOpen: true } },
    ]);
  });

  test("a store write to items or pauses triggers a badge refresh, but touchActive() alone does not", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, badgeTexts } = makeApi(storage, alarms);

    start(api);
    await flush();
    badgeTexts.length = 0;

    const otherStore = createStore(storage);
    await otherStore.touchActive();
    await flush();
    expect(badgeTexts).toEqual([]);

    const [bucket] = await otherStore.getBuckets();
    await otherStore.addItem({
      url: "https://example.com/new",
      title: "New",
      bucketId: bucket!.id,
      riffle: "72h",
    });
    await flush();

    expect(badgeTexts.length).toBeGreaterThan(0);

    badgeTexts.length = 0;
    await otherStore.pauseNow();
    await flush();

    expect(badgeTexts.length).toBeGreaterThan(0);
  });

  test("starting a second time against the same storage behaves the same, with no state carried between starts", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const first = makeApi(storage, alarms);

    start(first.api);
    await flush();
    expect(alarms.createCalls.length).toBe(1);

    // A second `start`, simulating a suspended-and-restarted background script, sees
    // the alarm already registered and doesn't recreate it.
    const second = makeApi(storage, alarms);
    start(second.api);
    await flush();
    expect(alarms.createCalls.length).toBe(1);

    second.onVisited.fire({ id: "1", url: "https://example.com/" });
    await flush();

    alarms.onAlarm.fire({ name: "sluice-tick", scheduledTime: 0 });
    await flush();

    expect(storage.peek("lastActiveAt")).toBeTypeOf("number");
    expect(second.badgeTexts.at(-1)).toBe("");

    // Each `start()` keeps its own independent "previous trackedTabs" closure: a tab
    // created through the second start's tab events is tracked and mirrored to its own
    // fake sessions, with no leftover state from the first start's (empty) closure.
    second.tabs.onCreated.fire(makeTab({ id: 1, windowId: 1, active: true, url: "https://example.com/" }));
    await flush();

    const tracked = storage.peek("trackedTabs") as Array<{ tabId: number }>;
    expect(tracked.some((tab) => tab.tabId === 1)).toBe(true);
    expect(second.sessions.setCalls.some((call) => call.tabId === 1)).toBe(true);
  });
});
