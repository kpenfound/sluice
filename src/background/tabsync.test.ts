import { describe, expect, test } from "vitest";
import { closeExpired, reconcileTabs, syncSessionValues } from "./tabsync";
import type { TabSyncDeps } from "./tabsync";
import { createStore } from "../lib/store";
import type { StorageChange, StorageNamespace } from "../lib/store";
import type { ClosedTab, TrackedTab } from "../lib/lifecycle";
import { SESSION_KEY } from "../lib/lifecycle";
import { HOUR } from "../lib/model";

type Listener = (changes: Record<string, StorageChange>, areaName: string) => void;

/**
 * An in-memory fake of `storage.local` and `storage.onChanged`, local to this test file.
 * Leaves unverified: real `storage.local`'s serialization, quota limits and persistence
 * across a process restart.
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
      this.fire(changes, "local");
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

  fire(changes: Record<string, StorageChange>, areaName: string): void {
    for (const listener of this.listeners) listener(changes, areaName);
  }
}

/**
 * A fake of the `browser.tabs` members `tabsync.ts` calls.
 * Leaves unverified: `remove` here just records the ids and does not fire any `onRemoved`
 * event the way a real tab close would — the resulting "Recently closed" entry, which
 * `tabsync.ts` relies on `onRemoved` to produce, is not exercised by this file.
 */
class FakeTabs {
  tabs: browser.tabs.Tab[] = [];
  removed: number[][] = [];

  query = (_queryInfo: browser.tabs._QueryQueryInfo): Promise<browser.tabs.Tab[]> =>
    Promise.resolve(this.tabs.slice());

  remove = (tabIds: number | number[]): Promise<void> => {
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
    this.removed.push(ids);
    return Promise.resolve();
  };
}

/**
 * A fake of the `browser.sessions` members `tabsync.ts` calls.
 * Leaves unverified: real `sessions.setTabValue`/`getTabValue` persistence across an
 * actual browser restart, and any serialization or quota limits Firefox enforces on a
 * session value.
 */
class FakeSessions {
  values = new Map<number, unknown>();
  rejectSetFor = new Set<number>();
  setCalls: Array<{ tabId: number; value: unknown }> = [];

  getTabValue = (tabId: number, _key: string): Promise<string | object | undefined> =>
    Promise.resolve(this.values.get(tabId) as string | object | undefined);

  setTabValue = (tabId: number, _key: string, value: unknown): Promise<void> => {
    this.setCalls.push({ tabId, value });
    if (this.rejectSetFor.has(tabId)) return Promise.reject(new Error("tab closed"));
    this.values.set(tabId, value);
    return Promise.resolve();
  };
}

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

function makeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: (): number => current,
    advance(ms: number): void {
      current += ms;
    },
  };
}

function makeIds(prefix = "id") {
  let counter = 0;
  return (): string => `${prefix}-${counter++}`;
}

function setup() {
  const storage = new FakeStorage();
  const clock = makeClock();
  const newId = makeIds();
  const store = createStore(storage, { now: clock.now, newId: makeIds("item") });
  const tabs = new FakeTabs();
  const sessions = new FakeSessions();
  const deps: TabSyncDeps = { store, tabs, sessions, newId, now: clock.now };
  return { storage, store, tabs, sessions, clock, newId, deps };
}

describe("reconcileTabs with restoring: true", () => {
  test("discards a stale existing record without adding it to recently closed", async () => {
    const { store, deps } = setup();
    await store.replaceTrackedTabs([
      {
        tabId: 99,
        windowId: 1,
        trackId: "stale-1",
        url: "https://stale.example.com/",
        title: "Stale",
        keepOpen: false,
        inactiveSince: null,
      },
    ]);

    await reconcileTabs(deps, { restoring: true });

    expect(await store.getTrackedTabs()).toEqual([]);
    expect(await store.getRecentlyClosed()).toEqual([]);
  });

  test("adopts a tab's sessions value for trackId and keepOpen", async () => {
    const { store, tabs, sessions, deps } = setup();
    tabs.tabs = [makeTab({ id: 1, active: true })];
    sessions.values.set(1, { trackId: "restored-1", keepOpen: true });

    await reconcileTabs(deps, { restoring: true });

    const tracked = await store.getTrackedTabs();
    expect(tracked).toHaveLength(1);
    expect(tracked[0]).toMatchObject({ tabId: 1, trackId: "restored-1", keepOpen: true });
  });

  test("treats a tab with no sessions value as new, inactiveSince = now, active tab null", async () => {
    const { store, tabs, clock, deps } = setup();
    tabs.tabs = [makeTab({ id: 1, active: true }), makeTab({ id: 2, active: false })];

    await reconcileTabs(deps, { restoring: true });

    const tracked = await store.getTrackedTabs();
    const active = tracked.find((tab) => tab.tabId === 1);
    const inactive = tracked.find((tab) => tab.tabId === 2);
    expect(active?.inactiveSince).toBeNull();
    expect(active?.keepOpen).toBe(false);
    expect(inactive?.inactiveSince).toBe(clock.now());
  });

  test("skips incognito tabs entirely", async () => {
    const { store, tabs, deps } = setup();
    tabs.tabs = [makeTab({ id: 1, incognito: true }), makeTab({ id: 2 })];

    await reconcileTabs(deps, { restoring: true });

    const tracked = await store.getTrackedTabs();
    expect(tracked.map((tab) => tab.tabId)).toEqual([2]);
  });

  test("removes a recently-closed entry whose trackId was restored", async () => {
    const { storage, store, tabs, sessions, deps } = setup();
    tabs.tabs = [makeTab({ id: 1, active: true })];
    sessions.values.set(1, { trackId: "restored-1", keepOpen: false });
    const closedEntry: ClosedTab = {
      id: "closed-1",
      trackId: "restored-1",
      url: "https://old.example.com/",
      normUrl: "https://old.example.com",
      title: "Old",
      closedAt: 0,
    };
    const otherEntry: ClosedTab = {
      id: "closed-2",
      trackId: "other",
      url: "https://other.example.com/",
      normUrl: "https://other.example.com",
      title: "Other",
      closedAt: 0,
    };
    await storage.local.set({ recentlyClosed: [closedEntry, otherEntry] });

    await reconcileTabs(deps, { restoring: true });

    const remaining = await store.getRecentlyClosed();
    expect(remaining.map((entry) => entry.id)).toEqual(["closed-2"]);
  });
});

describe("reconcileTabs with restoring: false", () => {
  test("keeps the existing record for an open tab id", async () => {
    const { store, tabs, deps } = setup();
    const existing: TrackedTab = {
      tabId: 1,
      windowId: 1,
      trackId: "track-1",
      url: "https://example.com/",
      title: "Example",
      keepOpen: false,
      inactiveSince: 500_000,
    };
    await store.replaceTrackedTabs([existing]);
    tabs.tabs = [makeTab({ id: 1 })];

    await reconcileTabs(deps, { restoring: false });

    const tracked = await store.getTrackedTabs();
    expect(tracked).toEqual([existing]);
  });

  test("tracks an untracked open tab as new", async () => {
    const { store, tabs, deps } = setup();
    tabs.tabs = [makeTab({ id: 2, active: false })];

    await reconcileTabs(deps, { restoring: false });

    const tracked = await store.getTrackedTabs();
    expect(tracked).toHaveLength(1);
    expect(tracked[0]?.tabId).toBe(2);
    expect(tracked[0]?.keepOpen).toBe(false);
  });
});

describe("closeExpired", () => {
  test("removes an expired inactive tab", async () => {
    const { store, tabs, clock, deps } = setup();
    await store.replaceTrackedTabs([
      {
        tabId: 1,
        windowId: 1,
        trackId: "track-1",
        url: "https://example.com/",
        title: "Example",
        keepOpen: false,
        inactiveSince: clock.now() - 2 * HOUR,
      },
    ]);
    tabs.tabs = [makeTab({ id: 1 })];

    await closeExpired(deps);

    expect(tabs.removed).toEqual([[1]]);
  });

  test("does not remove active, keep-open, audible, incognito, non-http(s) or not-yet-expired tabs", async () => {
    const { store, tabs, clock, deps } = setup();
    const base = {
      windowId: 1,
      url: "https://example.com/",
      title: "Example",
      inactiveSince: clock.now() - 2 * HOUR,
    };
    await store.replaceTrackedTabs([
      { ...base, tabId: 1, trackId: "active", keepOpen: false },
      { ...base, tabId: 2, trackId: "keep-open", keepOpen: true },
      { ...base, tabId: 3, trackId: "audible", keepOpen: false },
      { ...base, tabId: 4, trackId: "incognito", keepOpen: false },
      { ...base, tabId: 5, trackId: "non-http", keepOpen: false },
      { ...base, tabId: 6, trackId: "not-expired", keepOpen: false, inactiveSince: clock.now() - HOUR },
    ]);
    tabs.tabs = [
      makeTab({ id: 1, active: true }),
      makeTab({ id: 2 }),
      makeTab({ id: 3, audible: true }),
      makeTab({ id: 4, incognito: true }),
      makeTab({ id: 5, url: "about:blank" }),
      makeTab({ id: 6 }),
    ];

    await closeExpired(deps);

    expect(tabs.removed).toEqual([]);
  });

  test("makes no tabs.remove call when nothing is expired", async () => {
    const { store, tabs, clock, deps } = setup();
    await store.replaceTrackedTabs([
      {
        tabId: 1,
        windowId: 1,
        trackId: "track-1",
        url: "https://example.com/",
        title: "Example",
        keepOpen: false,
        inactiveSince: clock.now() - HOUR,
      },
    ]);
    tabs.tabs = [makeTab({ id: 1 })];

    await closeExpired(deps);

    expect(tabs.removed).toEqual([]);
  });
});

describe("syncSessionValues", () => {
  function makeTracked(overrides: Partial<TrackedTab> & { tabId: number }): TrackedTab {
    return {
      windowId: 1,
      trackId: "track-1",
      url: "https://example.com/",
      title: "Example",
      keepOpen: false,
      inactiveSince: null,
      ...overrides,
    };
  }

  test("writes only new or changed records", async () => {
    const { sessions, deps } = setup();
    const previous = [makeTracked({ tabId: 1, trackId: "track-1", keepOpen: false })];
    const current = [
      makeTracked({ tabId: 1, trackId: "track-1", keepOpen: true }), // changed keepOpen
      makeTracked({ tabId: 2, trackId: "track-2", keepOpen: false }), // new
    ];

    await syncSessionValues(deps, previous, current);

    expect(sessions.setCalls.map((call) => call.tabId).sort()).toEqual([1, 2]);
    expect(sessions.values.get(1)).toEqual({ trackId: "track-1", keepOpen: true });
    expect(sessions.values.get(2)).toEqual({ trackId: "track-2", keepOpen: false });
  });

  test("does not write a record unchanged from previous", async () => {
    const { sessions, deps } = setup();
    const record = makeTracked({ tabId: 1, trackId: "track-1", keepOpen: false });

    await syncSessionValues(deps, [record], [record]);

    expect(sessions.setCalls).toEqual([]);
  });

  test("continues past a rejected setTabValue", async () => {
    const { sessions, deps } = setup();
    sessions.rejectSetFor.add(1);
    const current = [
      makeTracked({ tabId: 1, trackId: "track-1", keepOpen: true }),
      makeTracked({ tabId: 2, trackId: "track-2", keepOpen: true }),
    ];

    await expect(syncSessionValues(deps, [], current)).resolves.toBeUndefined();

    expect(sessions.values.get(2)).toEqual({ trackId: "track-2", keepOpen: true });
    expect(sessions.values.has(1)).toBe(false);
  });
});
