import { describe, expect, test } from "vitest";
import { createStore } from "../lib/store";
import type { StorageChange, StorageNamespace } from "../lib/store";
import { SESSION_KEY } from "../lib/lifecycle";
import { handleActivated, handleAttached, handleCreated, handleRemoved, handleUpdated } from "./tabevents";
import type { TabEventDeps } from "./tabevents";

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
}

/** A manually-advanced clock, for tests that need a stable or moving `now`. */
function makeClock(start = 1_000_000) {
  let current = start;
  return {
    now: (): number => current,
    advance(ms: number): void {
      current += ms;
    },
  };
}

/** A predictable id generator, distinct from the real `crypto.randomUUID`. */
function makeIds(prefix = "id") {
  let counter = 0;
  return (): string => `${prefix}-${counter++}`;
}

/**
 * A fake `browser.sessions` namespace, holding a per-tab `sluice` value map.
 * Leaves unverified: it implements only `getTabValue` (the one member `TabEventDeps`
 * needs), never persists a value itself, and holds no real Firefox session data across
 * a browser restart.
 */
function makeSessions(values: Record<number, unknown> = {}): TabEventDeps["sessions"] {
  return {
    getTabValue: (tabId: number, key: string) =>
      Promise.resolve(
        key === SESSION_KEY ? (values[tabId] as string | object | undefined) : undefined,
      ),
  };
}

/** A tab fixture, filling in every field the handlers or `Tab`'s required fields need. */
function makeTab(overrides: Partial<browser.tabs.Tab> = {}): browser.tabs.Tab {
  return {
    id: 1,
    index: 0,
    windowId: 1,
    highlighted: false,
    active: false,
    pinned: false,
    incognito: false,
    url: "https://example.com/",
    title: "Example",
    ...overrides,
  };
}

function createDeps(options: { sessionValues?: Record<number, unknown> } = {}) {
  const storage = new FakeStorage();
  const clock = makeClock();
  const store = createStore(storage, { now: clock.now, newId: makeIds("store") });
  const deps: TabEventDeps = {
    store,
    sessions: makeSessions(options.sessionValues),
    newId: makeIds("track"),
    now: clock.now,
  };
  return { storage, clock, store, deps };
}

describe("handleCreated", () => {
  test("a background tab is tracked with inactiveSince = now", async () => {
    const { clock, store, deps } = createDeps();

    await handleCreated(deps, makeTab({ id: 1, active: false }));

    const [tab] = await store.getTrackedTabs();
    expect(tab).toEqual({
      tabId: 1,
      windowId: 1,
      trackId: "track-0",
      url: "https://example.com/",
      title: "Example",
      keepOpen: false,
      inactiveSince: clock.now(),
    });
  });

  test("an active tab is tracked with inactiveSince = null", async () => {
    const { store, deps } = createDeps();

    await handleCreated(deps, makeTab({ id: 1, active: true }));

    const [tab] = await store.getTrackedTabs();
    expect(tab!.inactiveSince).toBeNull();
  });

  test("an incognito tab is not tracked", async () => {
    const { store, deps } = createDeps();

    await handleCreated(deps, makeTab({ id: 1, incognito: true }));

    expect(await store.getTrackedTabs()).toEqual([]);
  });

  test("a sessions value is adopted: trackId and keepOpen come from it", async () => {
    const { store, deps } = createDeps({
      sessionValues: { 1: { trackId: "restored-1", keepOpen: true } },
    });

    await handleCreated(deps, makeTab({ id: 1, active: true }));

    const [tab] = await store.getTrackedTabs();
    expect(tab!.trackId).toBe("restored-1");
    expect(tab!.keepOpen).toBe(true);
  });

  test("a duplicate whose sessions trackId is already tracked gets a fresh trackId and keepOpen false", async () => {
    const { store, deps } = createDeps({
      sessionValues: {
        1: { trackId: "shared", keepOpen: true },
        2: { trackId: "shared", keepOpen: true },
      },
    });
    await handleCreated(deps, makeTab({ id: 1, active: true }));

    await handleCreated(deps, makeTab({ id: 2, active: true }));

    const tabs = await store.getTrackedTabs();
    const duplicate = tabs.find((t) => t.tabId === 2);
    expect(duplicate!.trackId).not.toBe("shared");
    expect(duplicate!.keepOpen).toBe(false);
  });
});

describe("handleActivated", () => {
  test("clears the activated tab's timer and starts the previously active tab's timer in the same window only", async () => {
    const { clock, store, deps } = createDeps();
    await handleCreated(deps, makeTab({ id: 1, windowId: 1, active: true }));
    await handleCreated(deps, makeTab({ id: 2, windowId: 1, active: false }));
    await handleCreated(deps, makeTab({ id: 3, windowId: 2, active: true }));
    clock.advance(5_000);

    await handleActivated(deps, { tabId: 2, windowId: 1 });

    const byId = new Map((await store.getTrackedTabs()).map((tab) => [tab.tabId, tab]));
    expect(byId.get(2)!.inactiveSince).toBeNull();
    expect(byId.get(1)!.inactiveSince).toBe(clock.now());
    expect(byId.get(3)!.inactiveSince).toBeNull();
  });
});

describe("handleUpdated", () => {
  test("updates the tracked tab's url, title and favIconUrl", async () => {
    const { store, deps } = createDeps();
    await handleCreated(deps, makeTab({ id: 1 }));

    await handleUpdated(
      deps,
      1,
      { url: "https://example.com/new", title: "New title", favIconUrl: "https://example.com/f.ico" },
      makeTab({ id: 1, url: "https://example.com/new", title: "New title" }),
    );

    const [tab] = await store.getTrackedTabs();
    expect(tab!.url).toBe("https://example.com/new");
    expect(tab!.title).toBe("New title");
    expect(tab!.favIconUrl).toBe("https://example.com/f.ico");
  });

  test("ignores an incognito tab", async () => {
    const { storage, deps } = createDeps();

    await handleUpdated(deps, 1, { url: "https://example.com/new" }, makeTab({ id: 1, incognito: true }));

    expect(storage.peek("trackedTabs")).toBeUndefined();
  });

  test("ignores changeInfo carrying none of url/title/favIconUrl", async () => {
    const { storage, store, deps } = createDeps();
    await handleCreated(deps, makeTab({ id: 1 }));
    const before = storage.peek("trackedTabs");

    await handleUpdated(deps, 1, { audible: true }, makeTab({ id: 1 }));

    expect(storage.peek("trackedTabs")).toBe(before);
    const [tab] = await store.getTrackedTabs();
    expect(tab!.url).toBe("https://example.com/");
  });
});

describe("handleAttached", () => {
  test("updates the tab's windowId", async () => {
    const { store, deps } = createDeps();
    await handleCreated(deps, makeTab({ id: 1, windowId: 1 }));

    await handleAttached(deps, 1, { newWindowId: 2, newPosition: 0 });

    const [tab] = await store.getTrackedTabs();
    expect(tab!.windowId).toBe(2);
  });
});

describe("handleRemoved", () => {
  test("adds an unqueued http(s) tab to recentlyClosed", async () => {
    const { store, deps } = createDeps();
    await handleCreated(deps, makeTab({ id: 1, url: "https://example.com/page" }));

    await handleRemoved(deps, 1);

    expect(await store.getTrackedTabs()).toEqual([]);
    const [closed] = await store.getRecentlyClosed();
    expect(closed!.url).toBe("https://example.com/page");
  });

  test("does not add a queued tab to recentlyClosed", async () => {
    const { store, deps } = createDeps();
    const [bucket] = await store.getBuckets();
    await store.addItem({
      url: "https://example.com/page",
      title: "Example",
      bucketId: bucket!.id,
      riffle: "72h",
    });
    await handleCreated(deps, makeTab({ id: 1, url: "https://example.com/page" }));

    await handleRemoved(deps, 1);

    expect(await store.getRecentlyClosed()).toEqual([]);
  });
});
