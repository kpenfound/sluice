import { describe, expect, test } from "vitest";
import { start } from "./main";
import type { BackgroundApi } from "./main";
import { createStore } from "../lib/store";
import type { StorageChange, StorageNamespace } from "../lib/store";

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

/** Drains pending microtasks and macrotasks, for assertions after an un-awaited handler fires. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeApi(storage: StorageNamespace, alarms: FakeAlarms) {
  const onVisited = new FakeEvent<(item: browser.history.HistoryItem) => void>();
  const onInstalled = new FakeEvent<(details: browser.runtime._OnInstalledDetails) => void>();
  const onStartup = new FakeEvent<() => void>();
  const badgeTexts: Array<string | null> = [];

  const api: BackgroundApi = {
    storage,
    alarms: {
      get: alarms.get,
      create: alarms.create,
      onAlarm: alarms.onAlarm,
    },
    history: { onVisited },
    runtime: { onInstalled, onStartup },
    action: {
      setBadgeText: (details) => {
        badgeTexts.push(details.text);
        return Promise.resolve();
      },
    },
  };

  return { api, onVisited, onInstalled, onStartup, badgeTexts };
}

describe("start", () => {
  test("registers every listener synchronously, before any awaited work", () => {
    const storage = new FakeStorage();
    const alarms = new FakeAlarms();
    const { api, onVisited, onInstalled, onStartup } = makeApi(storage, alarms);

    start(api);

    expect(alarms.onAlarm.count).toBe(1);
    expect(onVisited.count).toBe(1);
    expect(onInstalled.count).toBe(1);
    expect(onStartup.count).toBe(1);
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
  });
});
