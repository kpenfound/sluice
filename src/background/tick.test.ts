import { describe, expect, test } from "vitest";
import { tick } from "./tick";
import { badgeText } from "./badge";
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

function makeIds(prefix = "id") {
  let counter = 0;
  return (): string => `${prefix}-${counter++}`;
}

function setup() {
  const storage = new FakeStorage();
  const clock = makeClock();
  const newId = makeIds();
  const store = createStore(storage, { now: clock.now, newId });
  const badgeTexts: string[] = [];
  const setBadgeText = (text: string): void => {
    badgeTexts.push(text);
  };
  return { storage, clock, store, setBadgeText, badgeTexts };
}

describe("tick", () => {
  test("writes lastActiveAt as the injected now", async () => {
    const { storage, clock, store, setBadgeText } = setup();
    await tick({ store, setBadgeText, now: clock.now });
    expect(storage.peek("lastActiveAt")).toBe(clock.now());
  });

  test("removes a prunable ended pause", async () => {
    const { storage, clock, store, setBadgeText } = setup();
    await store.addPause({ start: clock.now(), end: clock.now() + 1 * HOUR });
    clock.advance(100 * HOUR);

    await tick({ store, setBadgeText, now: clock.now });

    expect(storage.peek("pauses")).toEqual([]);
  });

  test("makes no write to pauses when nothing is prunable", async () => {
    const { storage, clock, store, setBadgeText } = setup();
    await store.addPause({ start: clock.now(), end: null });
    const before = storage.peek("pauses");

    clock.advance(1_000);
    await tick({ store, setBadgeText, now: clock.now });

    expect(storage.peek("pauses")).toBe(before);
  });

  test("sets the badge to badgeText of the post-tick state", async () => {
    const { clock, store, setBadgeText, badgeTexts } = setup();
    const bucket = (await store.getBuckets())[0]!;
    await store.addItem({
      url: "https://example.com/",
      title: "Example",
      bucketId: bucket.id,
      riffle: "24h",
    });
    clock.advance(24 * HOUR);

    await tick({ store, setBadgeText, now: clock.now });

    const buckets = await store.getBuckets();
    const items = await store.getItems();
    const pauses = await store.getPauses();
    expect(badgeTexts).toEqual([badgeText(buckets, items, pauses, clock.now())]);
    expect(badgeTexts).toEqual(["1"]);
  });

  test("a scheduled pause's end passing between two ticks shows the symbol then the count, with no write to that pause", async () => {
    const { storage, clock, store, setBadgeText, badgeTexts } = setup();
    const bucket = (await store.getBuckets())[0]!;
    await store.addItem({
      url: "https://example.com/",
      title: "Example",
      bucketId: bucket.id,
      riffle: "24h",
    });
    clock.advance(30 * HOUR);
    await store.addPause({ start: clock.now(), end: clock.now() + 1 * HOUR });

    await tick({ store, setBadgeText, now: clock.now });
    expect(badgeTexts[0]).toBe("⏸");
    const pauseAfterFirstTick = storage.peek("pauses");

    clock.advance(2 * HOUR);
    await tick({ store, setBadgeText, now: clock.now });
    expect(badgeTexts[1]).toBe("1");
    expect(storage.peek("pauses")).toBe(pauseAfterFirstTick);
  });
});
