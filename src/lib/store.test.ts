import { describe, expect, test } from "vitest";
import { createStore } from "./store";
import type { StorageChange, StorageNamespace } from "./store";
import type { Item } from "./model";
import { HOUR } from "./model";
import { isOverdue } from "./due";

type Listener = (changes: Record<string, StorageChange>, areaName: string) => void;

/**
 * An in-memory fake of `storage.local` and `storage.onChanged`. `local.set` fires
 * `onChanged` for the "local" area, matching the real API; `fire` lets a test
 * simulate events `local.set` wouldn't produce itself, such as another area.
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

/** Wires a fresh fake storage to a store with an injected clock and id generator. */
function createTestStore(storage: FakeStorage = new FakeStorage()) {
  const clock = makeClock();
  const newId = makeIds();
  const store = createStore(storage, { now: clock.now, newId });
  return { storage, clock, newId, store };
}

describe("getItems and getPauses", () => {
  test("return [] when their key is absent", async () => {
    const { store } = createTestStore();
    expect(await store.getItems()).toEqual([]);
    expect(await store.getPauses()).toEqual([]);
  });

  test("read from their own separate keys", async () => {
    const storage = new FakeStorage();
    await storage.local.set({
      items: [{ id: "i1" }],
      pauses: [{ id: "p1" }],
    });
    const { store } = createTestStore(storage);
    expect(await store.getItems()).toEqual([{ id: "i1" }]);
    expect(await store.getPauses()).toEqual([{ id: "p1" }]);
  });
});

describe("getBuckets", () => {
  test("seeds and persists the three default buckets when the key is absent", async () => {
    const { storage, store } = createTestStore();
    const buckets = await store.getBuckets();
    expect(buckets).toEqual([
      { id: "id-0", name: "Dagger", order: 0 },
      { id: "id-1", name: "Side projects", order: 1 },
      { id: "id-2", name: "Personal", order: 2 },
    ]);
    expect(storage.peek("buckets")).toEqual(buckets);
  });

  test("a second read doesn't duplicate the defaults", async () => {
    const { store } = createTestStore();
    const first = await store.getBuckets();
    const second = await store.getBuckets();
    expect(second).toEqual(first);
  });

  test("reads from its own key, separate from items and pauses", async () => {
    const storage = new FakeStorage();
    await storage.local.set({ buckets: [{ id: "b1", name: "Work", order: 0 }] });
    const { store } = createTestStore(storage);
    expect(await store.getBuckets()).toEqual([{ id: "b1", name: "Work", order: 0 }]);
    expect(await store.getItems()).toEqual([]);
    expect(await store.getPauses()).toEqual([]);
  });
});

describe("addBucket", () => {
  test("appends a bucket with order one more than the current highest", async () => {
    const { store } = createTestStore();
    await store.getBuckets();
    const added = await store.addBucket("Reading");
    expect(added).toEqual({ id: "id-3", name: "Reading", order: 3 });
    expect(await store.getBuckets()).toHaveLength(4);
  });

  test("trims the name", async () => {
    const { store } = createTestStore();
    const bucket = await store.addBucket("  Travel  ");
    expect(bucket.name).toBe("Travel");
  });

  test("rejects an empty or whitespace-only name", async () => {
    const { store } = createTestStore();
    await expect(store.addBucket("")).rejects.toThrow();
    await expect(store.addBucket("   ")).rejects.toThrow();
  });
});

describe("renameBucket", () => {
  test("changes only the name", async () => {
    const { store } = createTestStore();
    const [bucket] = await store.getBuckets();
    const renamed = await store.renameBucket(bucket!.id, "Projects");
    expect(renamed).toEqual({ id: bucket!.id, name: "Projects", order: bucket!.order });
  });

  test("rejects an unknown bucket id", async () => {
    const { store } = createTestStore();
    await store.getBuckets();
    await expect(store.renameBucket("missing", "New name")).rejects.toThrow();
  });

  test("rejects an empty or whitespace-only name", async () => {
    const { store } = createTestStore();
    const [bucket] = await store.getBuckets();
    await expect(store.renameBucket(bucket!.id, "")).rejects.toThrow();
    await expect(store.renameBucket(bucket!.id, "   ")).rejects.toThrow();
  });
});

describe("concurrent writes", () => {
  test("two addBucket calls started without awaiting both persist", async () => {
    const { store } = createTestStore();
    await store.getBuckets();

    const first = store.addBucket("Alpha");
    const second = store.addBucket("Beta");
    const [a, b] = await Promise.all([first, second]);

    expect(a.order).not.toBe(b.order);
    const buckets = await store.getBuckets();
    expect(buckets).toHaveLength(5);
    expect(buckets.map((bucket) => bucket.name)).toEqual(
      expect.arrayContaining(["Alpha", "Beta"]),
    );
  });
});

describe("subscribe", () => {
  test("fires for local-area changes that touch buckets, items or pauses", async () => {
    const { storage, store } = createTestStore();
    const received: Array<Record<string, StorageChange>> = [];
    store.subscribe((changes) => received.push(changes));

    await storage.local.set({ buckets: [] });
    await storage.local.set({ items: [] });
    await storage.local.set({ pauses: [] });

    expect(received).toHaveLength(3);
  });

  test("ignores changes in other storage areas", () => {
    const { storage, store } = createTestStore();
    const received: unknown[] = [];
    store.subscribe((changes) => received.push(changes));

    storage.fire({ buckets: { newValue: [] } }, "sync");

    expect(received).toHaveLength(0);
  });

  test("ignores changes to keys other than buckets, items and pauses", async () => {
    const { storage, store } = createTestStore();
    const received: unknown[] = [];
    store.subscribe((changes) => received.push(changes));

    await storage.local.set({ settings: { theme: "dark" } });

    expect(received).toHaveLength(0);
  });

  test("stops receiving events after unsubscribe", async () => {
    const { storage, store } = createTestStore();
    const received: unknown[] = [];
    const unsubscribe = store.subscribe((changes) => received.push(changes));

    await storage.local.set({ buckets: [] });
    unsubscribe();
    await storage.local.set({ items: [] });

    expect(received).toHaveLength(1);
  });
});

describe("addItem", () => {
  test("creates one item for an unqueued URL", async () => {
    const { clock, store } = createTestStore();
    const [bucket] = await store.getBuckets();

    const item = await store.addItem({
      url: "https://example.com/post?utm_source=x",
      title: "Example",
      favIconUrl: "https://example.com/favicon.ico",
      bucketId: bucket!.id,
      riffle: "24h",
    });

    expect(item).toEqual({
      id: "id-3",
      url: "https://example.com/post?utm_source=x",
      normUrl: "https://example.com/post",
      title: "Example",
      favIconUrl: "https://example.com/favicon.ico",
      bucketId: bucket!.id,
      riffle: "24h",
      queuedAt: clock.now(),
      riffleEnteredAt: clock.now(),
      lastVisitedAt: null,
    });
    expect(await store.getItems()).toEqual([item]);
  });

  test("rejects an unknown bucket", async () => {
    const { store } = createTestStore();
    await store.getBuckets();
    await expect(
      store.addItem({ url: "https://example.com", title: "Example", bucketId: "missing", riffle: "24h" }),
    ).rejects.toThrow();
    expect(await store.getItems()).toEqual([]);
  });

  test("rejects an unknown riffle", async () => {
    const { store } = createTestStore();
    const [bucket] = await store.getBuckets();
    await expect(
      store.addItem({
        url: "https://example.com",
        title: "Example",
        bucketId: bucket!.id,
        riffle: "yearly" as never,
      }),
    ).rejects.toThrow();
    expect(await store.getItems()).toEqual([]);
  });

  test("re-adding an already-queued URL moves it instead of duplicating it", async () => {
    const { clock, store } = createTestStore();
    const [bucketA, bucketB] = await store.getBuckets();
    const original = await store.addItem({
      url: "https://example.com/post",
      title: "Example",
      favIconUrl: "https://example.com/favicon.ico",
      bucketId: bucketA!.id,
      riffle: "24h",
    });

    clock.advance(10_000);
    const moved = await store.addItem({
      url: "https://example.com/post#section",
      title: "Different title",
      favIconUrl: "https://example.com/other.ico",
      bucketId: bucketB!.id,
      riffle: "1w",
    });

    expect(moved).toEqual({
      ...original,
      bucketId: bucketB!.id,
      riffle: "1w",
      riffleEnteredAt: clock.now(),
    });
    const items = await store.getItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(original.id);
  });

  test("a URL differing only by tracking params matches the same item", async () => {
    const { store } = createTestStore();
    const [bucket] = await store.getBuckets();
    const original = await store.addItem({
      url: "https://example.com/post",
      title: "Example",
      bucketId: bucket!.id,
      riffle: "24h",
    });

    await store.addItem({
      url: "https://example.com/post?utm_source=newsletter&fbclid=abc",
      title: "Example",
      bucketId: bucket!.id,
      riffle: "72h",
    });

    const items = await store.getItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(original.id);
    expect(items[0]!.queuedAt).toBe(original.queuedAt);
  });
});

describe("deferItem", () => {
  test("steps through the whole ladder, setting riffleEnteredAt and leaving other fields unchanged", async () => {
    const { clock, store } = createTestStore();
    const [bucket] = await store.getBuckets();
    const item = await store.addItem({
      url: "https://example.com",
      title: "Example",
      bucketId: bucket!.id,
      riffle: "24h",
    });

    const ladder: Array<Item["riffle"]> = ["72h", "1w", "1mo", "stale"];
    let current = item;
    for (const expectedRiffle of ladder) {
      clock.advance(1_000);
      const deferred = await store.deferItem(current.id);
      expect(deferred).toEqual({
        ...current,
        riffle: expectedRiffle,
        riffleEnteredAt: clock.now(),
      });
      current = deferred;
    }
  });

  test("is a no-op on a stale item", async () => {
    const { store } = createTestStore();
    const [bucket] = await store.getBuckets();
    const item = await store.addItem({
      url: "https://example.com",
      title: "Example",
      bucketId: bucket!.id,
      riffle: "stale",
    });

    const deferred = await store.deferItem(item.id);
    expect(deferred).toEqual(item);
  });
});

describe("moveItem", () => {
  test("moves an item up, down and out of stale, setting riffleEnteredAt and leaving other fields unchanged", async () => {
    const { clock, store } = createTestStore();
    const [bucket] = await store.getBuckets();
    const item = await store.addItem({
      url: "https://example.com",
      title: "Example",
      bucketId: bucket!.id,
      riffle: "24h",
    });

    clock.advance(1_000);
    const up = await store.moveItem(item.id, "1mo");
    expect(up).toEqual({ ...item, riffle: "1mo", riffleEnteredAt: clock.now() });

    clock.advance(1_000);
    const down = await store.moveItem(item.id, "72h");
    expect(down).toEqual({ ...up, riffle: "72h", riffleEnteredAt: clock.now() });

    clock.advance(1_000);
    const stale = await store.moveItem(item.id, "stale");
    expect(stale).toEqual({ ...down, riffle: "stale", riffleEnteredAt: clock.now() });

    clock.advance(1_000);
    const outOfStale = await store.moveItem(item.id, "24h");
    expect(outOfStale).toEqual({ ...stale, riffle: "24h", riffleEnteredAt: clock.now() });
  });
});

describe("changeBucket", () => {
  test("changes only bucketId, leaving riffle and timestamps unchanged", async () => {
    const { store } = createTestStore();
    const [bucketA, bucketB] = await store.getBuckets();
    const item = await store.addItem({
      url: "https://example.com",
      title: "Example",
      bucketId: bucketA!.id,
      riffle: "24h",
    });

    const changed = await store.changeBucket(item.id, bucketB!.id);
    expect(changed).toEqual({ ...item, bucketId: bucketB!.id });
  });

  test("rejects an unknown bucket", async () => {
    const { store } = createTestStore();
    const [bucket] = await store.getBuckets();
    const item = await store.addItem({
      url: "https://example.com",
      title: "Example",
      bucketId: bucket!.id,
      riffle: "24h",
    });

    await expect(store.changeBucket(item.id, "missing")).rejects.toThrow();
    expect((await store.getItems())[0]).toEqual(item);
  });
});

describe("resolveItem", () => {
  test("removes the item from storage entirely", async () => {
    const { store } = createTestStore();
    const [bucket] = await store.getBuckets();
    const item = await store.addItem({
      url: "https://example.com",
      title: "Example",
      bucketId: bucket!.id,
      riffle: "24h",
    });

    await store.resolveItem(item.id);
    expect(await store.getItems()).toEqual([]);
  });
});

describe("recordVisit", () => {
  test("on a match, sets only lastVisitedAt, leaving the item in its riffle", async () => {
    const { clock, store } = createTestStore();
    const [bucket] = await store.getBuckets();
    const item = await store.addItem({
      url: "https://example.com/post",
      title: "Example",
      bucketId: bucket!.id,
      riffle: "24h",
    });

    clock.advance(5_000);
    const visited = await store.recordVisit("https://example.com/post?utm_source=x");
    expect(visited).toEqual({ ...item, lastVisitedAt: clock.now() });
    expect(visited!.riffle).toBe("24h");
  });

  test("on no match, returns null and writes nothing", async () => {
    const { storage, store } = createTestStore();
    const [bucket] = await store.getBuckets();
    await store.addItem({
      url: "https://example.com/post",
      title: "Example",
      bucketId: bucket!.id,
      riffle: "24h",
    });
    const before = storage.peek("items");

    const visited = await store.recordVisit("https://nothing-here.example.com");

    expect(visited).toBeNull();
    expect(storage.peek("items")).toBe(before);
  });
});

describe("item actions while overdue or paused", () => {
  test("every action succeeds on an item long past its riffle's TTL", async () => {
    const { clock, store } = createTestStore();
    const [bucketA, bucketB] = await store.getBuckets();
    const item = await store.addItem({
      url: "https://example.com/overdue",
      title: "Example",
      bucketId: bucketA!.id,
      riffle: "24h",
    });
    clock.advance(1000 * 60 * 60 * 24 * 365);

    await expect(store.recordVisit("https://example.com/overdue")).resolves.not.toBeNull();
    await expect(store.deferItem(item.id)).resolves.toBeDefined();
    await expect(store.moveItem(item.id, "1mo")).resolves.toBeDefined();
    await expect(store.changeBucket(item.id, bucketB!.id)).resolves.toBeDefined();
    await expect(
      store.addItem({
        url: "https://example.com/another",
        title: "Another",
        bucketId: bucketA!.id,
        riffle: "24h",
      }),
    ).resolves.toBeDefined();
    await expect(store.resolveItem(item.id)).resolves.toBeUndefined();
  });

  test("every action succeeds with a running pause seeded in storage", async () => {
    const { storage, clock, store } = createTestStore();
    const [bucketA, bucketB] = await store.getBuckets();
    await storage.local.set({ pauses: [{ id: "p1", start: clock.now() - 1_000, end: null }] });
    const item = await store.addItem({
      url: "https://example.com/paused",
      title: "Example",
      bucketId: bucketA!.id,
      riffle: "24h",
    });

    await expect(store.recordVisit("https://example.com/paused")).resolves.not.toBeNull();
    await expect(store.deferItem(item.id)).resolves.toBeDefined();
    await expect(store.moveItem(item.id, "1mo")).resolves.toBeDefined();
    await expect(store.changeBucket(item.id, bucketB!.id)).resolves.toBeDefined();
    await expect(store.resolveItem(item.id)).resolves.toBeUndefined();
    expect(storage.peek("pauses")).toEqual([{ id: "p1", start: expect.any(Number), end: null }]);
  });
});

describe("item action concurrency and storage shape", () => {
  test("two concurrent addItem calls for different URLs both persist", async () => {
    const { store } = createTestStore();
    const [bucket] = await store.getBuckets();

    const first = store.addItem({
      url: "https://example.com/a",
      title: "A",
      bucketId: bucket!.id,
      riffle: "24h",
    });
    const second = store.addItem({
      url: "https://example.com/b",
      title: "B",
      bucketId: bucket!.id,
      riffle: "24h",
    });
    const [a, b] = await Promise.all([first, second]);

    expect(a.id).not.toBe(b.id);
    const items = await store.getItems();
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.url)).toEqual(
      expect.arrayContaining(["https://example.com/a", "https://example.com/b"]),
    );
  });

  test("stored items carry only the Data model fields", async () => {
    const { storage, store } = createTestStore();
    const [bucket] = await store.getBuckets();
    await store.addItem({
      url: "https://example.com",
      title: "Example",
      bucketId: bucket!.id,
      riffle: "24h",
    });

    const [stored] = storage.peek("items") as Item[];
    expect(Object.keys(stored!).sort()).toEqual(
      ["bucketId", "id", "lastVisitedAt", "normUrl", "queuedAt", "riffle", "riffleEnteredAt", "title", "url"].sort(),
    );
  });
});

describe("pauseNow", () => {
  test("starts an open-ended pause at now", async () => {
    const { clock, store } = createTestStore();
    const pause = await store.pauseNow();
    expect(pause).toEqual({ id: "id-0", start: clock.now(), end: null });
    expect(await store.getPauses()).toEqual([pause]);
  });

  test("accepts a later end that schedules the resume", async () => {
    const { clock, store } = createTestStore();
    const end = clock.now() + HOUR;
    const pause = await store.pauseNow(end);
    expect(pause).toEqual({ id: "id-0", start: clock.now(), end });
  });
});

describe("resume", () => {
  test("sets end = now on the running pause", async () => {
    const { clock, store } = createTestStore();
    const started = await store.pauseNow();
    clock.advance(5_000);
    const resumed = await store.resume();
    expect(resumed).toEqual({ ...started, end: clock.now() });
    expect(await store.getPauses()).toEqual([resumed]);
  });

  test("does nothing when no pause is running", async () => {
    const { storage, clock, store } = createTestStore();
    await storage.local.set({
      pauses: [{ id: "p1", start: clock.now() - 2 * HOUR, end: clock.now() - HOUR }],
    });
    const before = storage.peek("pauses");

    const result = await store.resume();

    expect(result).toBeNull();
    expect(storage.peek("pauses")).toBe(before);
  });
});

describe("addPause", () => {
  test("a past range with an explicit end", async () => {
    const { clock, store } = createTestStore();
    const start = clock.now() - 2 * HOUR;
    const end = clock.now() - HOUR;
    const pause = await store.addPause({ start, end });
    expect(pause).toEqual({ id: "id-0", start, end });
    expect(await store.getPauses()).toEqual([pause]);
  });

  test("a past range until now", async () => {
    const { clock, store } = createTestStore();
    const start = clock.now() - HOUR;
    const pause = await store.addPause({ start, end: clock.now() });
    expect(pause).toEqual({ id: "id-0", start, end: clock.now() });
  });

  test("a scheduled future pause", async () => {
    const { clock, store } = createTestStore();
    const start = clock.now() + HOUR;
    const end = clock.now() + 2 * HOUR;
    const pause = await store.addPause({ start, end });
    expect(pause).toEqual({ id: "id-0", start, end });
    expect(await store.getPauses()).toEqual([pause]);
  });

  test("rejects a non-null end <= start, leaving stored pauses unchanged", async () => {
    const { clock, store } = createTestStore();
    await store.addPause({ start: clock.now() - HOUR, end: clock.now() });
    const before = await store.getPauses();

    await expect(store.addPause({ start: clock.now(), end: clock.now() })).rejects.toThrow();
    await expect(
      store.addPause({ start: clock.now(), end: clock.now() - HOUR }),
    ).rejects.toThrow();

    expect(await store.getPauses()).toEqual(before);
  });
});

describe("editPause", () => {
  test("changes start", async () => {
    const { clock, store } = createTestStore();
    const pause = await store.addPause({ start: clock.now() - 2 * HOUR, end: clock.now() - HOUR });
    const start = clock.now() - 3 * HOUR;
    const edited = await store.editPause(pause.id, { start });
    expect(edited).toEqual({ ...pause, start });
  });

  test("changes end", async () => {
    const { clock, store } = createTestStore();
    const pause = await store.addPause({ start: clock.now() - 2 * HOUR, end: clock.now() - HOUR });
    const end = clock.now();
    const edited = await store.editPause(pause.id, { end });
    expect(edited).toEqual({ ...pause, end });
  });

  test("changes label", async () => {
    const { clock, store } = createTestStore();
    const pause = await store.addPause({ start: clock.now() - 2 * HOUR, end: clock.now() - HOUR });
    const edited = await store.editPause(pause.id, { label: "Lunch" });
    expect(edited).toEqual({ ...pause, label: "Lunch" });
  });

  test("rejects a non-null end <= start, leaving stored pauses unchanged", async () => {
    const { clock, store } = createTestStore();
    const pause = await store.addPause({ start: clock.now() - 2 * HOUR, end: clock.now() - HOUR });
    const before = await store.getPauses();

    await expect(store.editPause(pause.id, { end: pause.start })).rejects.toThrow();

    expect(await store.getPauses()).toEqual(before);
  });
});

describe("deletePause", () => {
  test("removes a pause by id", async () => {
    const { clock, store } = createTestStore();
    const pause = await store.addPause({ start: clock.now() - 2 * HOUR, end: clock.now() - HOUR });
    await store.deletePause(pause.id);
    expect(await store.getPauses()).toEqual([]);
  });

  test("rejects an unknown pause id", async () => {
    const { store } = createTestStore();
    await expect(store.deletePause("missing")).rejects.toThrow();
  });
});

describe("pause merging on write", () => {
  test("pauseNow merges with a pause that touches its start, keeping the earlier id, start and label", async () => {
    const { clock, store } = createTestStore();
    const earlier = await store.addPause({
      start: clock.now() - HOUR,
      end: clock.now(),
      label: "Earlier",
    });

    const merged = await store.pauseNow();

    expect(merged).toEqual({ id: earlier.id, start: earlier.start, end: null, label: "Earlier" });
    expect(await store.getPauses()).toEqual([merged]);
  });

  test("addPause merges with an overlapping pause, taking the latest end", async () => {
    const { clock, store } = createTestStore();
    const first = await store.addPause({ start: clock.now() - 3 * HOUR, end: clock.now() - HOUR });

    const merged = await store.addPause({ start: clock.now() - 2 * HOUR, end: clock.now() });

    expect(merged).toEqual({ id: first.id, start: first.start, end: clock.now() });
    expect(await store.getPauses()).toEqual([merged]);
  });

  test("editPause re-merges, keeping the earliest id, start and first label and the latest end", async () => {
    const { clock, store } = createTestStore();
    const first = await store.addPause({
      start: clock.now() - 10 * HOUR,
      end: clock.now() - 8 * HOUR,
      label: "First",
    });
    const second = await store.addPause({
      start: clock.now() - 5 * HOUR,
      end: clock.now() - 3 * HOUR,
      label: "Second",
    });

    const edited = await store.editPause(first.id, { end: clock.now() - 4 * HOUR });

    expect(edited).toEqual({ id: first.id, start: first.start, end: second.end, label: "First" });
    expect(await store.getPauses()).toEqual([edited]);
  });

  test("stored pauses stay sorted by start with no overlapping or touching ranges", async () => {
    const { clock, store } = createTestStore();
    await store.addPause({ start: clock.now() + 5 * HOUR, end: clock.now() + 6 * HOUR });
    await store.addPause({ start: clock.now() - 5 * HOUR, end: clock.now() - 4 * HOUR });
    await store.addPause({ start: clock.now() + HOUR, end: clock.now() + 2 * HOUR });

    const pauses = await store.getPauses();

    expect(pauses.map((p) => p.start)).toEqual([...pauses.map((p) => p.start)].sort((a, b) => a - b));
    for (let i = 1; i < pauses.length; i++) {
      const prevEnd = pauses[i - 1]!.end;
      expect(prevEnd).not.toBeNull();
      expect(prevEnd!).toBeLessThan(pauses[i]!.start);
    }
  });
});

describe("pause writes leave items untouched", () => {
  test("addPause, editPause and deletePause don't change the stored items value", async () => {
    const { storage, clock, store } = createTestStore();
    const [bucket] = await store.getBuckets();
    await store.addItem({
      url: "https://example.com",
      title: "Example",
      bucketId: bucket!.id,
      riffle: "24h",
    });
    const itemsBefore = storage.peek("items");

    const pause = await store.addPause({ start: clock.now() - 2 * HOUR, end: clock.now() - HOUR });
    await store.editPause(pause.id, { label: "Lunch" });
    await store.deletePause(pause.id);

    expect(storage.peek("items")).toBe(itemsBefore);
  });

  test("a past pause covering an overdue item's elapsed time makes it no longer overdue on read", async () => {
    const { clock, store } = createTestStore();
    const [bucket] = await store.getBuckets();
    const item = await store.addItem({
      url: "https://example.com",
      title: "Example",
      bucketId: bucket!.id,
      riffle: "24h",
    });

    clock.advance(25 * HOUR);
    expect(isOverdue(item, await store.getPauses(), clock.now())).toBe(true);

    await store.addPause({ start: item.riffleEnteredAt, end: item.riffleEnteredAt + 24 * HOUR });

    const pauses = await store.getPauses();
    expect(isOverdue(item, pauses, clock.now())).toBe(false);
    expect((await store.getItems())[0]).toEqual(item);
  });
});

describe("prunePauses", () => {
  test("removes only prunable pauses, keeping running and scheduled ones", async () => {
    const { clock, store } = createTestStore();
    const [bucket] = await store.getBuckets();
    const base = clock.now();

    const endedEarly = await store.addPause({ start: base - 3 * HOUR, end: base - HOUR });
    await store.addItem({
      url: "https://example.com",
      title: "Example",
      bucketId: bucket!.id,
      riffle: "24h",
    });
    const running = await store.addPause({ start: base, end: base + 2 * HOUR });
    const scheduled = await store.addPause({ start: base + 3 * HOUR, end: base + 4 * HOUR });
    clock.advance(HOUR);

    const pruned = await store.prunePauses();

    expect(pruned.map((p) => p.id).sort()).toEqual([running.id, scheduled.id].sort());
    expect(pruned.some((p) => p.id === endedEarly.id)).toBe(false);
    expect(await store.getPauses()).toEqual(pruned);
  });
});

describe("concurrent pause writes", () => {
  test("two addPause calls started without awaiting both persist", async () => {
    const { clock, store } = createTestStore();

    const first = store.addPause({ start: clock.now() - 10 * HOUR, end: clock.now() - 9 * HOUR });
    const second = store.addPause({ start: clock.now() - 5 * HOUR, end: clock.now() - 4 * HOUR });
    const [a, b] = await Promise.all([first, second]);

    expect(a.id).not.toBe(b.id);
    const pauses = await store.getPauses();
    expect(pauses).toHaveLength(2);
    expect(pauses.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });
});
