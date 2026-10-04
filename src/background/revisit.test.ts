import { describe, expect, test } from "vitest";
import { createStore } from "../lib/store";
import type { StorageChange, StorageNamespace } from "../lib/store";
import { handleVisited } from "./revisit";

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

function makeIds(prefix = "id") {
  let counter = 0;
  return (): string => `${prefix}-${counter++}`;
}

describe("handleVisited", () => {
  test("a visit whose URL normalizes to a queued item's normUrl sets lastVisitedAt, leaving riffle and riffleEnteredAt unchanged", async () => {
    const storage = new FakeStorage();
    const clock = makeClock();
    const store = createStore(storage, { now: clock.now, newId: makeIds() });
    const [bucket] = await store.getBuckets();

    const item = await store.addItem({
      url: "https://github.com/octocat/hello-world/pull/42",
      title: "Hello World PR",
      bucketId: bucket!.id,
      riffle: "72h",
    });

    clock.advance(60_000);
    await handleVisited(store, { url: "https://github.com/octocat/hello-world/pull/42/files" });

    const [visited] = await store.getItems();
    expect(visited!.lastVisitedAt).toBe(clock.now());
    expect(visited!.riffle).toBe(item.riffle);
    expect(visited!.riffleEnteredAt).toBe(item.riffleEnteredAt);
  });

  test("a visit whose URL normalizes to a queued item's normUrl via a utm_ variant sets lastVisitedAt", async () => {
    const storage = new FakeStorage();
    const clock = makeClock();
    const store = createStore(storage, { now: clock.now, newId: makeIds() });
    const [bucket] = await store.getBuckets();

    await store.addItem({
      url: "https://example.com/article?x=1",
      title: "Article",
      bucketId: bucket!.id,
      riffle: "72h",
    });

    clock.advance(60_000);
    await handleVisited(store, { url: "https://example.com/article?utm_source=newsletter&x=1" });

    const [visited] = await store.getItems();
    expect(visited!.lastVisitedAt).toBe(clock.now());
  });

  test("a non-matching URL makes no set call", async () => {
    const storage = new FakeStorage();
    const clock = makeClock();
    const store = createStore(storage, { now: clock.now, newId: makeIds() });
    const [bucket] = await store.getBuckets();

    await store.addItem({
      url: "https://example.com/queued",
      title: "Queued",
      bucketId: bucket!.id,
      riffle: "72h",
    });

    const itemsBeforeVisit = storage.peek("items");
    await handleVisited(store, { url: "https://example.com/unrelated" });

    expect(storage.peek("items")).toBe(itemsBeforeVisit);
  });

  test("a visit without a URL makes no set call", async () => {
    const storage = new FakeStorage();
    const clock = makeClock();
    const store = createStore(storage, { now: clock.now, newId: makeIds() });
    const [bucket] = await store.getBuckets();

    await store.addItem({
      url: "https://example.com/queued",
      title: "Queued",
      bucketId: bucket!.id,
      riffle: "72h",
    });

    const itemsBeforeVisit = storage.peek("items");
    await handleVisited(store, {});

    expect(storage.peek("items")).toBe(itemsBeforeVisit);
  });
});
