import { afterEach, describe, expect, test, vi } from "vitest";
import { start } from "./main";
import type { BackgroundApi } from "./main";
import { createStore } from "../lib/store";
import type { StorageChange, StorageNamespace } from "../lib/store";
import { HOUR } from "../lib/model";
import { WASH_COMMAND, WASH_MESSAGE_TYPE } from "../lib/wash";

type Listener = (changes: Record<string, StorageChange>, areaName: string) => void;

/**
 * A fixed instant used by every clock-dependent test, via `vi.setSystemTime`, so away-gap and
 * lastActiveAt math never races the real clock. `start(api)` takes no injectable `now`, so the
 * clock is pinned from the test side instead.
 */
const FIXED_NOW = 1_700_000_000_000;

/**
 * An in-memory fake of `storage.local` and `storage.onChanged`, local to this test file. Leaves
 * unverified: real `storage.local`'s serialization and quota behavior.
 */
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

  get listenerCount(): number {
    return this.listeners.length;
  }
}

/**
 * A fake `WebExtEvent`: records listeners and lets the test fire them. Leaves unverified: real
 * listener ordering and Firefox's event-page wake-up behavior.
 */
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

/**
 * A fake `browser.alarms`, tracking created alarms and recording `create` calls. Leaves
 * unverified: real OS-scheduled alarm timing -- alarms here only fire when a test calls `fire`.
 */
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
 * that event (not its own `tabs.remove` call) to put a closed tab into "Recently closed". Leaves
 * unverified: real Firefox fires `onRemoved` asynchronously, not synchronously inside `remove`
 * like this fake does, and does not model multi-window query scoping.
 */
class FakeTabs {
  tabs: browser.tabs.Tab[] = [];
  createdTabs: Array<browser.tabs._CreateCreateProperties> = [];
  removed: number[][] = [];
  updated: Array<{ tabId: number; props: browser.tabs._UpdateUpdateProperties }> = [];

  onCreated = new FakeEvent<(tab: browser.tabs.Tab) => void>();
  onActivated = new FakeEvent<(activeInfo: browser.tabs._OnActivatedActiveInfo) => void>();
  onUpdated = new FakeEvent<
    (tabId: number, changeInfo: browser.tabs._OnUpdatedChangeInfo, tab: browser.tabs.Tab) => void
  >();
  onAttached = new FakeEvent<(tabId: number, attachInfo: browser.tabs._OnAttachedAttachInfo) => void>();
  onRemoved = new FakeEvent<(tabId: number, removeInfo: browser.tabs._OnRemovedRemoveInfo) => void>();

  create = (createProperties: browser.tabs._CreateCreateProperties): Promise<browser.tabs.Tab> => {
    this.createdTabs.push(createProperties);
    const tab = {
      id: this.createdTabs.length + 1000,
      index: 0,
      windowId: 1,
      highlighted: false,
      active: false,
      pinned: false,
      incognito: false,
      url: createProperties.url,
    } as browser.tabs.Tab;
    this.tabs.push(tab);
    return Promise.resolve(tab);
  };

  query = (_queryInfo: browser.tabs._QueryQueryInfo): Promise<browser.tabs.Tab[]> =>
    Promise.resolve(this.tabs.slice());

  update = (
    tabId: number,
    updateProperties: browser.tabs._UpdateUpdateProperties,
  ): Promise<browser.tabs.Tab> => {
    this.updated.push({ tabId, props: updateProperties });
    const tab = this.tabs.find((t) => t.id === tabId);
    if (tab) {
      if (updateProperties.url !== undefined) tab.url = updateProperties.url;
      if (updateProperties.active !== undefined) tab.active = updateProperties.active;
    }
    return Promise.resolve(tab ?? makeTab({ id: tabId }));
  };

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

/**
 * A fake `browser.sessions`, holding a per-tab `sluice` value map and recording `setTabValue`
 * calls. Leaves unverified: real `sessions` storage's persistence across an actual browser
 * restart and its serialization/quota behavior.
 */
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
  const onMessage = new FakeEvent<
    (
      message: unknown,
      sender: browser.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ) => boolean | Promise<unknown> | void
  >();
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
      onMessage,
      getURL: (path) => `moz-extension://fake-id/${path}`,
    },
    tabs: {
      create: tabs.create,
      query: tabs.query,
      remove: tabs.remove,
      update: tabs.update,
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
    onMessage,
    badgeTexts,
    createdTabs: tabs.createdTabs,
    tabs,
    sessions,
  };
}

describe("start", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("registers every listener synchronously, before any awaited work", () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onVisited, onInstalled, onStartup, onCommand, onMessage, tabs } = makeApi(
      storage,
      alarms,
    );

    start(api);

    expect(alarms.onAlarm.count).toBe(1);
    expect(onVisited.count).toBe(1);
    expect(onInstalled.count).toBe(1);
    expect(onStartup.count).toBe(1);
    expect(onCommand.count).toBe(1);
    expect(onMessage.count).toBe(1);
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
    const store = createStore(storage);

    start(api);
    await flush();

    alarms.onAlarm.fire({ name: "sluice-tick", scheduledTime: 0 });
    await flush();

    expect(await store.getLastActiveAt()).toBeTypeOf("number");
    expect(badgeTexts.at(-1)).toBe("");
  });

  test("an alarm firing under another name does nothing", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, badgeTexts } = makeApi(storage, alarms);
    const store = createStore(storage);

    start(api);
    await flush();
    badgeTexts.length = 0;

    alarms.onAlarm.fire({ name: "some-other-alarm", scheduledTime: 0 });
    await flush();

    expect(await store.getLastActiveAt()).toBeNull();
    expect(badgeTexts).toEqual([]);
  });

  test("firing onInstalled runs the per-minute duties", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onInstalled, badgeTexts } = makeApi(storage, alarms);
    const store = createStore(storage);

    start(api);
    onInstalled.fire({ reason: "install", temporary: false });
    await flush();

    expect(await store.getLastActiveAt()).toBeTypeOf("number");
    expect(badgeTexts.at(-1)).toBe("");
  });

  test("firing onInstalled tracks untracked open tabs as new, keeping existing records", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onInstalled, tabs } = makeApi(storage, alarms);
    const store = createStore(storage);
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

    const tracked = await store.getTrackedTabs();
    expect(tracked.find((tab) => tab.tabId === 1)?.trackId).toBe("kept");
    expect(tracked.some((tab) => tab.tabId === 2)).toBe(true);
  });

  test("firing onStartup runs the per-minute duties", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onStartup, badgeTexts } = makeApi(storage, alarms);
    const store = createStore(storage);

    start(api);
    onStartup.fire();
    await flush();

    expect(await store.getLastActiveAt()).toBeTypeOf("number");
    expect(badgeTexts.at(-1)).toBe("");
  });

  test("firing onStartup with lastActiveAt more than 72h old records an away gap and updates lastActiveAt to now", async () => {
    vi.setSystemTime(FIXED_NOW);
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onStartup } = makeApi(storage, alarms);
    const store = createStore(storage);
    const oldLastActiveAt = FIXED_NOW - 73 * HOUR;
    await storage.local.set({ lastActiveAt: oldLastActiveAt });

    start(api);
    onStartup.fire();
    await flush();

    const gap = await store.getAwayGap();
    expect(gap?.start).toBe(oldLastActiveAt);
    expect(gap?.end).toBe(FIXED_NOW);
    expect(await store.getLastActiveAt()).toBe(FIXED_NOW);
  });

  test("firing onStartup with lastActiveAt exactly 72h old leaves awayGap unset", async () => {
    vi.setSystemTime(FIXED_NOW);
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onStartup } = makeApi(storage, alarms);
    const store = createStore(storage);
    const exactLastActiveAt = FIXED_NOW - 72 * HOUR;
    await storage.local.set({ lastActiveAt: exactLastActiveAt });

    start(api);
    onStartup.fire();
    await flush();

    expect(await store.getAwayGap()).toBeNull();
  });

  test("firing onStartup with no prior lastActiveAt leaves awayGap unset", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onStartup } = makeApi(storage, alarms);
    const store = createStore(storage);

    start(api);
    onStartup.fire();
    await flush();

    expect(await store.getAwayGap()).toBeNull();
  });

  test("firing onStartup records the away gap from the stale lastActiveAt, then restores tracking (adopting keepOpen from sessions) before the tick runs", async () => {
    vi.setSystemTime(FIXED_NOW);
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onStartup, tabs, sessions, badgeTexts } = makeApi(storage, alarms);
    const store = createStore(storage);
    const oldLastActiveAt = FIXED_NOW - 73 * HOUR;
    await storage.local.set({ lastActiveAt: oldLastActiveAt });
    tabs.tabs = [makeTab({ id: 1, active: true, url: "https://example.com/restored" })];
    sessions.values.set(1, { trackId: "restored-1", keepOpen: true });

    // Capture, at every badge-text update, whatever `trackedTabs` already holds (read through a
    // second store instance over the same storage) at that instant -- an outcome-based way to
    // show reconciliation landed before a badge update, with no spy on any Sluice function.
    const readStore = createStore(storage);
    const trackedTabsAtEachBadgeUpdate: ReturnType<typeof readStore.getTrackedTabs>[] = [];
    const setBadgeText = api.action.setBadgeText;
    api.action.setBadgeText = (details) => {
      trackedTabsAtEachBadgeUpdate.push(readStore.getTrackedTabs());
      return setBadgeText(details);
    };

    start(api);
    onStartup.fire();
    await flush();

    // recordAwayGap ran against the stale lastActiveAt, not one already bumped by the tick.
    const gap = await store.getAwayGap();
    expect(gap?.start).toBe(oldLastActiveAt);

    // reconcileTabs restored the tab's keepOpen from its sessions value.
    const tracked = await store.getTrackedTabs();
    expect(tracked).toEqual([expect.objectContaining({ tabId: 1, trackId: "restored-1", keepOpen: true })]);

    // The tick ran too, and by the time its (last) badge update fired, trackedTabs already
    // carried the reconciled, keepOpen-restored record -- reconciliation finished first.
    expect(badgeTexts.at(-1)).toBe("");
    const resolvedSnapshots = await Promise.all(trackedTabsAtEachBadgeUpdate);
    expect(resolvedSnapshots.length).toBeGreaterThan(0);
    expect(resolvedSnapshots.at(-1)).toEqual([
      expect.objectContaining({ tabId: 1, trackId: "restored-1", keepOpen: true }),
    ]);
  });

  test("an alarm tick with an old lastActiveAt records no gap", async () => {
    vi.setSystemTime(FIXED_NOW);
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api } = makeApi(storage, alarms);
    const store = createStore(storage);
    const oldLastActiveAt = FIXED_NOW - 73 * HOUR;
    await storage.local.set({ lastActiveAt: oldLastActiveAt });

    start(api);
    await flush();

    alarms.onAlarm.fire({ name: "sluice-tick", scheduledTime: 0 });
    await flush();

    expect(await store.getAwayGap()).toBeNull();
  });

  test("firing onInstalled records no gap", async () => {
    vi.setSystemTime(FIXED_NOW);
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onInstalled } = makeApi(storage, alarms);
    const store = createStore(storage);
    const oldLastActiveAt = FIXED_NOW - 73 * HOUR;
    await storage.local.set({ lastActiveAt: oldLastActiveAt });

    start(api);
    onInstalled.fire({ reason: "install", temporary: false });
    await flush();

    expect(await store.getAwayGap()).toBeNull();
  });

  test("firing history.onVisited with a queued URL sets that item's lastVisitedAt", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onVisited } = makeApi(storage, alarms);
    const store = createStore(storage);

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

    const items = await store.getItems();
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

  test("firing the wash command with no triage tab open opens the triage URL and closes nothing", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onCommand, createdTabs, tabs } = makeApi(storage, alarms);
    tabs.tabs = [makeTab({ id: 1, url: "https://example.com/" })];

    start(api);
    onCommand.fire(WASH_COMMAND, {} as browser.tabs.Tab);
    await flush();

    expect(createdTabs).toEqual([{ url: "moz-extension://fake-id/newtab.html?wash=1" }]);
    expect(tabs.removed).toEqual([]);
  });

  test("firing the wash command with a triage tab open washes and keeps that tab", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onCommand, tabs } = makeApi(storage, alarms);
    tabs.tabs = [
      makeTab({ id: 1, url: "moz-extension://fake-id/newtab.html?wash=1" }),
      makeTab({ id: 2, url: "https://example.com/open" }),
    ];

    start(api);
    onCommand.fire(WASH_COMMAND, {} as browser.tabs.Tab);
    await flush();

    expect(tabs.removed).toEqual([[2]]);
    expect(tabs.updated).toEqual([
      { tabId: 1, props: { url: "moz-extension://fake-id/newtab.html", active: true } },
    ]);
  });

  test("a wash message from a tab washes and keeps the sender tab", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onMessage, tabs } = makeApi(storage, alarms);
    tabs.tabs = [
      makeTab({ id: 5, url: "https://example.com/triage" }),
      makeTab({ id: 6, url: "https://example.com/other" }),
    ];

    start(api);
    onMessage.fire(
      { type: WASH_MESSAGE_TYPE },
      { tab: makeTab({ id: 5 }) } as browser.runtime.MessageSender,
      () => {},
    );
    await flush();

    expect(tabs.removed).toEqual([[6]]);
    expect(tabs.updated).toEqual([
      { tabId: 5, props: { url: "moz-extension://fake-id/newtab.html", active: true } },
    ]);
  });

  test("a non-wash message is ignored", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onMessage, tabs } = makeApi(storage, alarms);
    tabs.tabs = [makeTab({ id: 1, url: "https://example.com/" })];

    start(api);
    onMessage.fire({ type: "something-else" }, {} as browser.runtime.MessageSender, () => {});
    await flush();

    expect(tabs.removed).toEqual([]);
    expect(tabs.updated).toEqual([]);
  });

  test("after a wash, an unqueued closed tab gets a recently closed entry but a tab queued beforehand does not", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onCommand, tabs } = makeApi(storage, alarms);

    const otherStore = createStore(storage);
    const [bucket] = await otherStore.getBuckets();
    await otherStore.addItem({
      url: "https://example.com/queued",
      title: "Queued",
      bucketId: bucket!.id,
      riffle: "72h",
    });
    await otherStore.replaceTrackedTabs([
      {
        tabId: 2,
        windowId: 1,
        trackId: "queued-tab",
        url: "https://example.com/queued",
        title: "Queued",
        keepOpen: false,
        inactiveSince: null,
      },
      {
        tabId: 3,
        windowId: 1,
        trackId: "unqueued-tab",
        url: "https://example.com/unqueued",
        title: "Unqueued",
        keepOpen: false,
        inactiveSince: null,
      },
    ]);

    tabs.tabs = [
      makeTab({ id: 1, url: "moz-extension://fake-id/newtab.html?wash=1" }),
      makeTab({ id: 2, url: "https://example.com/queued" }),
      makeTab({ id: 3, url: "https://example.com/unqueued" }),
    ];

    start(api);
    onCommand.fire(WASH_COMMAND, {} as browser.tabs.Tab);
    await flush();

    expect(tabs.removed).toEqual([[2, 3]]);

    const closed = await otherStore.getRecentlyClosed();
    expect(closed.some((entry) => entry.url === "https://example.com/unqueued")).toBe(true);
    expect(closed.some((entry) => entry.url === "https://example.com/queued")).toBe(false);
  });

  test("tabs.onCreated tracks a tab, onActivated moves the running timer, and onRemoved adds it to recently closed", async () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, tabs } = makeApi(storage, alarms);
    const store = createStore(storage);

    start(api);
    await flush();

    tabs.onCreated.fire(makeTab({ id: 1, windowId: 1, active: true, url: "https://example.com/one" }));
    tabs.onCreated.fire(makeTab({ id: 2, windowId: 1, active: false, url: "https://example.com/two" }));
    await flush();

    let tracked = await store.getTrackedTabs();
    expect(tracked.find((tab) => tab.tabId === 1)?.inactiveSince).toBeNull();
    expect(tracked.find((tab) => tab.tabId === 2)?.inactiveSince).toBeTypeOf("number");

    tabs.onActivated.fire({ tabId: 2, windowId: 1 });
    await flush();

    tracked = await store.getTrackedTabs();
    expect(tracked.find((tab) => tab.tabId === 2)?.inactiveSince).toBeNull();
    expect(tracked.find((tab) => tab.tabId === 1)?.inactiveSince).toBeTypeOf("number");

    tabs.onRemoved.fire(1, { windowId: 1, isWindowClosing: false });
    await flush();

    const afterRemove = await store.getTrackedTabs();
    expect(afterRemove.some((tab) => tab.tabId === 1)).toBe(false);
    const closed = await store.getRecentlyClosed();
    expect(closed.some((entry) => entry.url === "https://example.com/one")).toBe(true);
  });

  test("the alarm tick closes an expired inactive tab, leaves active and keep-open tabs, and prunes recently closed", async () => {
    vi.setSystemTime(FIXED_NOW);
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, tabs } = makeApi(storage, alarms);
    const store = createStore(storage);
    const whenNow = FIXED_NOW;
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

    const tracked = await store.getTrackedTabs();
    expect(tracked.map((tab) => tab.tabId).sort()).toEqual([2, 3]);

    const closed = await store.getRecentlyClosed();
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
    const store = createStore(storage);
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

    expect(await store.getLastActiveAt()).toBeTypeOf("number");
    expect(second.badgeTexts.at(-1)).toBe("");

    // Storage changes supply their previous values: a tab
    // created through the second start's tab events is tracked and mirrored to its own
    // fake sessions using the previous value carried by its storage event.
    second.tabs.onCreated.fire(makeTab({ id: 1, windowId: 1, active: true, url: "https://example.com/" }));
    await flush();

    const tracked = await store.getTrackedTabs();
    expect(tracked.some((tab) => tab.tabId === 1)).toBe(true);
    expect(second.sessions.setCalls.some((call) => call.tabId === 1)).toBe(true);
  });
});
