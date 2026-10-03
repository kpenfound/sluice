import { describe, expect, test } from "vitest";
import { createStore } from "./store";
import type { StorageChange, StorageNamespace } from "./store";

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
