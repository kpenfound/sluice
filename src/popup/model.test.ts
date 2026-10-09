import { describe, expect, test } from "vitest";
import type { Bucket, Item, Pause } from "../lib/model";
import type { TrackedTab } from "../lib/lifecycle";
import { createStore } from "../lib/store";
import type { StorageChange, StorageNamespace } from "../lib/store";
import { move, pause, popupState, resolve, resumePause, saveTab, setKeepOpen } from "./model";
import type { Tab } from "./model";

type Listener = (changes: Record<string, StorageChange>, areaName: string) => void;

/**
 * An in-memory fake of `storage.local` and `storage.onChanged`, local to this test file.
 * Leaves real storage serialization and quota limits, and Firefox's actual `onChanged`
 * event timing, unverified.
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

  peek(key: string): unknown {
    return this.data[key];
  }
}

function makeClock(start = 1_000_000) {
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

function createTestStore(storage: FakeStorage = new FakeStorage()) {
  const clock = makeClock();
  const newId = makeIds();
  const store = createStore(storage, { now: clock.now, newId });
  return { storage, clock, newId, store };
}

const buckets: Bucket[] = [
  { id: "b-personal", name: "Personal", order: 1 },
  { id: "b-dagger", name: "Dagger", order: 0 },
  { id: "b-side", name: "Side projects", order: 2 },
];

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: "item-1",
    url: "https://example.com/post",
    normUrl: "https://example.com/post",
    title: "A post",
    bucketId: "b-dagger",
    riffle: "72h",
    queuedAt: 0,
    riffleEnteredAt: 0,
    lastVisitedAt: null,
    ...overrides,
  };
}

function makeTrackedTab(overrides: Partial<TrackedTab> = {}): TrackedTab {
  return {
    tabId: 1,
    windowId: 1,
    trackId: "track-1",
    url: "https://example.com/post",
    title: "A post",
    keepOpen: false,
    inactiveSince: null,
    ...overrides,
  };
}

describe("popupState", () => {
  test("an about: tab is unqueueable", () => {
    const tab: Tab = { url: "about:preferences", title: "Preferences" };
    const state = popupState({
      tab,
      tabId: 1,
      buckets,
      items: [],
      pauses: [],
      trackedTabs: [],
      lastBucketId: null,
      now: 0,
    });
    expect(state.kind).toBe("unqueueable");
  });

  test("a moz-extension: tab is unqueueable", () => {
    const tab: Tab = { url: "moz-extension://abc/page.html", title: "Page" };
    const state = popupState({
      tab,
      tabId: 1,
      buckets,
      items: [],
      pauses: [],
      trackedTabs: [],
      lastBucketId: null,
      now: 0,
    });
    expect(state.kind).toBe("unqueueable");
  });

  test("an unqueued https tab is the add state, with 72h and buckets in order", () => {
    const tab: Tab = { url: "https://example.com/new", title: "New page" };
    const state = popupState({
      tab,
      tabId: 1,
      buckets,
      items: [],
      pauses: [],
      trackedTabs: [],
      lastBucketId: null,
      now: 0,
    });
    expect(state.kind).toBe("add");
    if (state.kind !== "add") throw new Error("expected add state");
    expect(state.title).toBe("New page");
    expect(state.buckets.map((b) => b.id)).toEqual(["b-dagger", "b-personal", "b-side"]);
    expect(state.defaultRiffle).toBe("72h");
    expect(state.riffles).toEqual(["24h", "72h", "1w", "1mo"]);
  });

  test("a tab differing only by fragment is queued, with the item's bucket name and riffle", () => {
    const item = makeItem({ normUrl: "https://example.com/post", bucketId: "b-personal", riffle: "1w" });
    const tab: Tab = { url: "https://example.com/post#section", title: "A post" };
    const state = popupState({
      tab,
      tabId: 1,
      buckets,
      items: [item],
      pauses: [],
      trackedTabs: [],
      lastBucketId: null,
      now: 0,
    });
    expect(state.kind).toBe("queued");
    if (state.kind !== "queued") throw new Error("expected queued state");
    expect(state.item.id).toBe(item.id);
    expect(state.bucketName).toBe("Personal");
    expect(state.riffle).toBe("1w");
  });

  test("a tab differing only by a utm_ param is queued", () => {
    const item = makeItem({ normUrl: "https://example.com/post" });
    const tab: Tab = { url: "https://example.com/post?utm_source=newsletter", title: "A post" };
    const state = popupState({
      tab,
      tabId: 1,
      buckets,
      items: [item],
      pauses: [],
      trackedTabs: [],
      lastBucketId: null,
      now: 0,
    });
    expect(state.kind).toBe("queued");
  });

  test("a tab differing only by a trailing slash is queued", () => {
    const item = makeItem({ normUrl: "https://example.com/post" });
    const tab: Tab = { url: "https://example.com/post/", title: "A post" };
    const state = popupState({
      tab,
      tabId: 1,
      buckets,
      items: [item],
      pauses: [],
      trackedTabs: [],
      lastBucketId: null,
      now: 0,
    });
    expect(state.kind).toBe("queued");
  });

  test("the add state's default bucket is the last-used bucket when it still exists", () => {
    const tab: Tab = { url: "https://example.com/new", title: "New page" };
    const state = popupState({
      tab,
      tabId: 1,
      buckets,
      items: [],
      pauses: [],
      trackedTabs: [],
      lastBucketId: "b-side",
      now: 0,
    });
    if (state.kind !== "add") throw new Error("expected add state");
    expect(state.defaultBucketId).toBe("b-side");
  });

  test("the add state's default bucket is the lowest-order bucket when none was ever recorded", () => {
    const tab: Tab = { url: "https://example.com/new", title: "New page" };
    const state = popupState({
      tab,
      tabId: 1,
      buckets,
      items: [],
      pauses: [],
      trackedTabs: [],
      lastBucketId: null,
      now: 0,
    });
    if (state.kind !== "add") throw new Error("expected add state");
    expect(state.defaultBucketId).toBe("b-dagger");
  });

  test("the add state's default bucket falls back to the lowest-order bucket when the stored one was deleted", () => {
    const tab: Tab = { url: "https://example.com/new", title: "New page" };
    const state = popupState({
      tab,
      tabId: 1,
      buckets,
      items: [],
      pauses: [],
      trackedTabs: [],
      lastBucketId: "b-deleted",
      now: 0,
    });
    if (state.kind !== "add") throw new Error("expected add state");
    expect(state.defaultBucketId).toBe("b-dagger");
  });

  test("pause state is idle with no pauses", () => {
    const tab: Tab = { url: "https://example.com/new", title: "New page" };
    const state = popupState({
      tab,
      tabId: 1,
      buckets,
      items: [],
      pauses: [],
      trackedTabs: [],
      lastBucketId: null,
      now: 1000,
    });
    expect(state.pause).toEqual({ status: "idle" });
  });

  test("pause state is idle with only an ended pause", () => {
    const pauses: Pause[] = [{ id: "p1", start: 0, end: 500 }];
    const tab: Tab = { url: "https://example.com/new", title: "New page" };
    const state = popupState({
      tab,
      tabId: 1,
      buckets,
      items: [],
      pauses,
      trackedTabs: [],
      lastBucketId: null,
      now: 1000,
    });
    expect(state.pause).toEqual({ status: "idle" });
  });

  test("pause state is running with a running pause's scheduled end", () => {
    const pauses: Pause[] = [{ id: "p1", start: 0, end: 2000 }];
    const tab: Tab = { url: "https://example.com/new", title: "New page" };
    const state = popupState({
      tab,
      tabId: 1,
      buckets,
      items: [],
      pauses,
      trackedTabs: [],
      lastBucketId: null,
      now: 1000,
    });
    expect(state.pause).toEqual({ status: "running", end: 2000 });
  });

  test("pause state is running with an open-ended pause", () => {
    const pauses: Pause[] = [{ id: "p1", start: 0, end: null }];
    const tab: Tab = { url: "https://example.com/new", title: "New page" };
    const state = popupState({
      tab,
      tabId: 1,
      buckets,
      items: [],
      pauses,
      trackedTabs: [],
      lastBucketId: null,
      now: 1000,
    });
    expect(state.pause).toEqual({ status: "running", end: null });
  });

  test("keepOpen is { tracked: false } when the tab has no tracking record", () => {
    const tab: Tab = { url: "https://example.com/new", title: "New page" };
    const state = popupState({
      tab,
      tabId: 1,
      buckets,
      items: [],
      pauses: [],
      trackedTabs: [],
      lastBucketId: null,
      now: 0,
    });
    expect(state.keepOpen).toEqual({ tracked: false });
  });

  test("keepOpen reflects the tracked tab's flag in the add state", () => {
    const tab: Tab = { url: "https://example.com/new", title: "New page" };
    const trackedTabs = [makeTrackedTab({ tabId: 1, keepOpen: true })];
    const state = popupState({
      tab,
      tabId: 1,
      buckets,
      items: [],
      pauses: [],
      trackedTabs,
      lastBucketId: null,
      now: 0,
    });
    expect(state.kind).toBe("add");
    expect(state.keepOpen).toEqual({ tracked: true, keepOpen: true });
  });

  test("keepOpen reflects the tracked tab's flag in the queued state", () => {
    const item = makeItem({ normUrl: "https://example.com/post" });
    const tab: Tab = { url: "https://example.com/post", title: "A post" };
    const trackedTabs = [makeTrackedTab({ tabId: 1, keepOpen: false })];
    const state = popupState({
      tab,
      tabId: 1,
      buckets,
      items: [item],
      pauses: [],
      trackedTabs,
      lastBucketId: null,
      now: 0,
    });
    expect(state.kind).toBe("queued");
    expect(state.keepOpen).toEqual({ tracked: true, keepOpen: false });
  });

  test("keepOpen reflects the tracked tab's flag in the unqueueable state", () => {
    const tab: Tab = { url: "about:preferences", title: "Preferences" };
    const trackedTabs = [makeTrackedTab({ tabId: 1, keepOpen: true })];
    const state = popupState({
      tab,
      tabId: 1,
      buckets,
      items: [],
      pauses: [],
      trackedTabs,
      lastBucketId: null,
      now: 0,
    });
    expect(state.kind).toBe("unqueueable");
    expect(state.keepOpen).toEqual({ tracked: true, keepOpen: true });
  });

  test("keepOpen only looks at the record matching the current tab id", () => {
    const tab: Tab = { url: "https://example.com/new", title: "New page" };
    const trackedTabs = [makeTrackedTab({ tabId: 2, keepOpen: true })];
    const state = popupState({
      tab,
      tabId: 1,
      buckets,
      items: [],
      pauses: [],
      trackedTabs,
      lastBucketId: null,
      now: 0,
    });
    expect(state.keepOpen).toEqual({ tracked: false });
  });
});

describe("saveTab", () => {
  test("stores the item with the tab's url, title and favicon, the chosen bucket and riffle, and lastBucketId", async () => {
    const { store } = createTestStore();
    const seeded = await store.getBuckets();
    const bucketId = seeded[0]!.id;
    const tab: Tab = {
      url: "https://example.com/post",
      title: "A post",
      favIconUrl: "https://example.com/favicon.ico",
    };

    const item = await saveTab(store, tab, bucketId, "1w");

    expect(item.url).toBe(tab.url);
    expect(item.title).toBe(tab.title);
    expect(item.favIconUrl).toBe(tab.favIconUrl);
    expect(item.bucketId).toBe(bucketId);
    expect(item.riffle).toBe("1w");
    expect(await store.getLastBucketId()).toBe(bucketId);
  });
});

describe("move", () => {
  test("changes the riffle", async () => {
    const { store } = createTestStore();
    const bucketId = (await store.getBuckets())[0]!.id;
    const item = await saveTab(
      store,
      { url: "https://example.com/post", title: "A post" },
      bucketId,
      "72h",
    );

    const moved = await move(store, item.id, "1mo");

    expect(moved.riffle).toBe("1mo");
  });
});

describe("resolve", () => {
  test("removes the item, after which popupState returns add for that tab", async () => {
    const { store } = createTestStore();
    const stored = await store.getBuckets();
    const tab: Tab = { url: "https://example.com/post", title: "A post" };
    const item = await saveTab(store, tab, stored[0]!.id, "72h");

    await resolve(store, item.id);

    const items = await store.getItems();
    expect(items).toEqual([]);

    const state = popupState({
      tab,
      tabId: 1,
      buckets: stored,
      items,
      pauses: [],
      trackedTabs: [],
      lastBucketId: null,
      now: 0,
    });
    expect(state.kind).toBe("add");
  });
});

describe("pause", () => {
  test("with no end stores a running pause starting now", async () => {
    const { clock, store } = createTestStore();

    const result = await pause(store, null, clock.now());

    expect(result.ok).toBe(true);
    expect(await store.getPauses()).toEqual([{ id: "id-0", start: clock.now(), end: null }]);
  });

  test("with a future end stores a pause scheduled to end then", async () => {
    const { clock, store } = createTestStore();
    const end = clock.now() + 1000;

    const result = await pause(store, end, clock.now());

    expect(result.ok).toBe(true);
    expect(await store.getPauses()).toEqual([{ id: "id-0", start: clock.now(), end }]);
  });

  test("with an end at now returns an error and leaves stored pauses unchanged", async () => {
    const { storage, clock, store } = createTestStore();

    const result = await pause(store, clock.now(), clock.now());

    expect(result.ok).toBe(false);
    expect(storage.peek("pauses")).toBeUndefined();
  });

  test("with an end before now returns an error and leaves stored pauses unchanged", async () => {
    const { storage, clock, store } = createTestStore();

    const result = await pause(store, clock.now() - 1000, clock.now());

    expect(result.ok).toBe(false);
    expect(storage.peek("pauses")).toBeUndefined();
  });
});

describe("resumePause", () => {
  test("sets end = now on the running pause", async () => {
    const { clock, store } = createTestStore();
    await pause(store, null, clock.now());
    clock.advance(500);

    const resumed = await resumePause(store);

    expect(resumed?.end).toBe(clock.now());
  });
});

describe("setKeepOpen", () => {
  test("marks a tracked tab keep-open, persisted through the store's tracked tabs", async () => {
    const { store } = createTestStore();
    await store.trackTab(makeTrackedTab({ tabId: 1, keepOpen: false }));

    const result = await setKeepOpen(store, 1, true);

    expect(result.keepOpen).toBe(true);
    const [tab] = await store.getTrackedTabs();
    expect(tab!.keepOpen).toBe(true);
  });

  test("rejects for an untracked tab id", async () => {
    const { store } = createTestStore();

    await expect(setKeepOpen(store, 999, true)).rejects.toBeDefined();
  });
});
