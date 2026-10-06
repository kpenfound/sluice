import { describe, expect, test } from "vitest";
import { createStore } from "../lib/store";
import type { StorageChange, StorageNamespace } from "../lib/store";
import { handleWashCommand, runWash } from "./wash";
import type { WashDeps } from "./wash";

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
}

/** A fake of the `browser.tabs` members `wash.ts` calls. */
class FakeTabs {
  tabs: browser.tabs.Tab[] = [];
  removed: number[][] = [];
  created: browser.tabs.Tab[] = [];
  updated: Array<{ tabId: number; props: browser.tabs._UpdateUpdateProperties }> = [];
  private nextId = 100;

  query = (_queryInfo: browser.tabs._QueryQueryInfo): Promise<browser.tabs.Tab[]> =>
    Promise.resolve(this.tabs.slice());

  create = (createProperties: browser.tabs._CreateCreateProperties): Promise<browser.tabs.Tab> => {
    const tab = makeTab({ id: this.nextId++, url: createProperties.url ?? "" });
    this.tabs.push(tab);
    this.created.push(tab);
    return Promise.resolve(tab);
  };

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
    this.tabs = this.tabs.filter((tab) => !ids.includes(tab.id!));
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

function makeIds(prefix = "id") {
  let counter = 0;
  return (): string => `${prefix}-${counter++}`;
}

const LAUNCHER_URL = "moz-extension://abc/newtab.html";
const WASH_URL = "moz-extension://abc/newtab.html?wash=1";

function setup() {
  const storage = new FakeStorage();
  const store = createStore(storage, { now: () => 1_700_000_000_000, newId: makeIds("item") });
  const tabs = new FakeTabs();
  const deps: WashDeps = { store, tabs, launcherUrl: LAUNCHER_URL, washUrl: WASH_URL };
  return { storage, store, tabs, deps };
}

describe("handleWashCommand", () => {
  test("first press opens triage and removes nothing", async () => {
    const { tabs, deps } = setup();
    tabs.tabs = [makeTab({ id: 1, url: "https://example.com/" })];

    await handleWashCommand(deps);

    expect(tabs.created.map((tab) => tab.url)).toEqual([WASH_URL]);
    expect(tabs.removed).toEqual([]);
  });

  test("ignores a triage tab open in a private window", async () => {
    const { tabs, deps } = setup();
    tabs.tabs = [makeTab({ id: 1, url: WASH_URL, incognito: true })];

    await handleWashCommand(deps);

    expect(tabs.created.map((tab) => tab.url)).toEqual([WASH_URL]);
    expect(tabs.removed).toEqual([]);
  });

  test("second press washes with the triage tab kept", async () => {
    const { tabs, deps } = setup();
    tabs.tabs = [makeTab({ id: 1, url: WASH_URL }), makeTab({ id: 2, url: "https://example.com/" })];

    await handleWashCommand(deps);

    expect(tabs.created).toEqual([]);
    expect(tabs.removed).toEqual([[2]]);
    expect(tabs.updated).toEqual([{ tabId: 1, props: { url: LAUNCHER_URL, active: true } }]);
  });

  test("with several triage tabs open, the active one is kept", async () => {
    const { tabs, deps } = setup();
    tabs.tabs = [
      makeTab({ id: 1, url: WASH_URL, active: false }),
      makeTab({ id: 2, url: WASH_URL, active: true }),
      makeTab({ id: 3, url: "https://example.com/" }),
    ];

    await handleWashCommand(deps);

    expect(tabs.removed).toEqual([[1, 3]]);
    expect(tabs.updated).toEqual([{ tabId: 2, props: { url: LAUNCHER_URL, active: true } }]);
  });

  test("with several triage tabs and none active, the first returned is kept", async () => {
    const { tabs, deps } = setup();
    tabs.tabs = [
      makeTab({ id: 1, url: WASH_URL }),
      makeTab({ id: 2, url: WASH_URL }),
      makeTab({ id: 3, url: "https://example.com/" }),
    ];

    await handleWashCommand(deps);

    expect(tabs.removed).toEqual([[2, 3]]);
    expect(tabs.updated).toEqual([{ tabId: 1, props: { url: LAUNCHER_URL, active: true } }]);
  });
});

describe("runWash", () => {
  test("closes active, pinned, queued, unqueued and extension-page tabs", async () => {
    const { store, tabs, deps } = setup();
    await store.replaceTrackedTabs([
      {
        tabId: 3,
        windowId: 1,
        trackId: "keep-open",
        url: "https://example.com/keepopen",
        title: "Keep open",
        keepOpen: true,
        inactiveSince: null,
      },
    ]);
    const [bucket] = await store.getBuckets();
    await store.addItem({
      url: "https://queued.example.com/",
      title: "Queued",
      bucketId: bucket!.id,
      riffle: "72h",
    });
    tabs.tabs = [
      makeTab({ id: 1, url: LAUNCHER_URL }), // kept
      makeTab({ id: 2, url: "https://example.com/audible", audible: true }),
      makeTab({ id: 3, url: "https://example.com/keepopen" }),
      makeTab({ id: 4, url: "https://example.com/incognito", incognito: true }),
      makeTab({ id: 5, url: "https://example.com/active", active: true }),
      makeTab({ id: 6, url: "https://example.com/pinned", pinned: true }),
      makeTab({ id: 7, url: "https://queued.example.com/" }),
      makeTab({ id: 8, url: "https://example.com/unqueued" }),
      makeTab({ id: 9, url: WASH_URL }),
    ];

    await runWash(deps, { keptTabId: 1 });

    expect(tabs.removed).toEqual([[5, 6, 7, 8, 9]]);
  });

  test("makes a single tabs.remove call", async () => {
    const { tabs, deps } = setup();
    tabs.tabs = [
      makeTab({ id: 1, url: LAUNCHER_URL }),
      makeTab({ id: 2, url: "https://example.com/a" }),
      makeTab({ id: 3, url: "https://example.com/b" }),
    ];

    await runWash(deps, { keptTabId: 1 });

    expect(tabs.removed).toEqual([[2, 3]]);
  });

  test("makes no tabs.remove call when there is nothing to close", async () => {
    const { tabs, deps } = setup();
    tabs.tabs = [makeTab({ id: 1, url: LAUNCHER_URL }), makeTab({ id: 2, audible: true })];

    await runWash(deps, { keptTabId: 1 });

    expect(tabs.removed).toEqual([]);
  });

  test("updates the kept tab to the launcher URL and makes it active", async () => {
    const { tabs, deps } = setup();
    tabs.tabs = [makeTab({ id: 1, url: WASH_URL })];

    await runWash(deps, { keptTabId: 1 });

    expect(tabs.updated).toEqual([{ tabId: 1, props: { url: LAUNCHER_URL, active: true } }]);
  });

  test("with no keptTabId, creates a launcher tab first and keeps it", async () => {
    const { tabs, deps } = setup();
    tabs.tabs = [makeTab({ id: 1, url: "https://example.com/" })];

    await runWash(deps, {});

    expect(tabs.created.map((tab) => tab.url)).toEqual([LAUNCHER_URL]);
    const createdId = tabs.created[0]!.id!;
    expect(tabs.removed).toEqual([[1]]);
    expect(tabs.updated).toEqual([{ tabId: createdId, props: { url: LAUNCHER_URL, active: true } }]);
  });
});
