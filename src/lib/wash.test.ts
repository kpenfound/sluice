import { describe, expect, test } from "vitest";
import {
  WASH_COMMAND,
  WASH_MESSAGE_TYPE,
  WASH_PAGE,
  isWashExempt,
  isWashMessage,
  tabsToWash,
  triageTabs,
} from "./wash";
import type { WashTab } from "./wash";
import type { TrackedTab } from "./lifecycle";
import type { Item } from "./model";

const NOW = 1_700_000_000_000;

function makeTab(overrides: Partial<WashTab> = {}): WashTab {
  return {
    id: 1,
    windowId: 1,
    index: 0,
    url: "https://example.com/",
    title: "Example",
    audible: false,
    incognito: false,
    ...overrides,
  };
}

function makeTracked(overrides: Partial<TrackedTab> = {}): TrackedTab {
  return {
    tabId: 1,
    windowId: 1,
    trackId: "track-1",
    url: "https://example.com/",
    title: "Example",
    keepOpen: false,
    inactiveSince: null,
    ...overrides,
  };
}

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: "item-1",
    url: "https://example.com/",
    normUrl: "https://example.com",
    title: "Example",
    bucketId: "bucket-1",
    riffle: "24h",
    queuedAt: NOW,
    riffleEnteredAt: NOW,
    lastVisitedAt: null,
    ...overrides,
  };
}

describe("constants", () => {
  test("WASH_COMMAND", () => {
    expect(WASH_COMMAND).toBe("wash");
  });

  test("WASH_PAGE", () => {
    expect(WASH_PAGE).toBe("newtab.html?wash=1");
  });

  test("WASH_MESSAGE_TYPE", () => {
    expect(WASH_MESSAGE_TYPE).toBe("sluice-wash");
  });
});

describe("isWashMessage", () => {
  test("accepts the wash message", () => {
    expect(isWashMessage({ type: "sluice-wash" })).toBe(true);
  });

  test("rejects a different type", () => {
    expect(isWashMessage({ type: "other" })).toBe(false);
  });

  test("rejects null", () => {
    expect(isWashMessage(null)).toBe(false);
  });

  test("rejects a non-object", () => {
    expect(isWashMessage("sluice-wash")).toBe(false);
  });

  test("rejects an object with no type", () => {
    expect(isWashMessage({})).toBe(false);
  });
});

describe("isWashExempt", () => {
  test("an audible tab is exempt", () => {
    const tab = makeTab({ audible: true });
    expect(isWashExempt(tab, [])).toBe(true);
  });

  test("a tracked tab with keepOpen true is exempt", () => {
    const tab = makeTab({ id: 5 });
    const tracked = [makeTracked({ tabId: 5, keepOpen: true })];
    expect(isWashExempt(tab, tracked)).toBe(true);
  });

  test("a tracked tab with keepOpen false is not exempt", () => {
    const tab = makeTab({ id: 5 });
    const tracked = [makeTracked({ tabId: 5, keepOpen: false })];
    expect(isWashExempt(tab, tracked)).toBe(false);
  });

  test("an untracked tab is not exempt", () => {
    const tab = makeTab({ id: 5 });
    expect(isWashExempt(tab, [])).toBe(false);
  });
});

describe("tabsToWash", () => {
  test("incognito tabs are never washed", () => {
    const tabs = [makeTab({ id: 1, incognito: true })];
    expect(tabsToWash(tabs, [], null)).toEqual([]);
  });

  test("the kept tab is never washed", () => {
    const tabs = [makeTab({ id: 1 }), makeTab({ id: 2 })];
    expect(tabsToWash(tabs, [], 1)).toEqual([2]);
  });

  test("audible and keep-open tabs are not washed", () => {
    const tabs = [
      makeTab({ id: 1, audible: true }),
      makeTab({ id: 2 }),
      makeTab({ id: 3 }),
    ];
    const tracked = [makeTracked({ tabId: 2, keepOpen: true })];
    expect(tabsToWash(tabs, tracked, null)).toEqual([3]);
  });

  test("a tab has no active or pinned exemption: WashTab carries no such field, so it is always washed", () => {
    const tabs = [makeTab({ id: 1 })];
    expect(tabsToWash(tabs, [], null)).toEqual([1]);
  });

  test("tabs without an id are ignored", () => {
    const tabs = [makeTab({ id: undefined })];
    expect(tabsToWash(tabs, [], null)).toEqual([]);
  });

  test("empty input washes nothing", () => {
    expect(tabsToWash([], [], null)).toEqual([]);
  });
});

describe("triageTabs", () => {
  test("a queued tab is washed but not listed", () => {
    const tabs = [makeTab({ id: 1, url: "https://example.com/" })];
    const items = [makeItem({ normUrl: "https://example.com" })];
    expect(tabsToWash(tabs, [], null)).toEqual([1]);
    expect(triageTabs(tabs, [], items, null)).toEqual([]);
  });

  test("a queued tab with a utm param variant is washed but not listed", () => {
    const tabs = [makeTab({ id: 1, url: "https://example.com/?utm_source=x" })];
    const items = [makeItem({ normUrl: "https://example.com" })];
    expect(tabsToWash(tabs, [], null)).toEqual([1]);
    expect(triageTabs(tabs, [], items, null)).toEqual([]);
  });

  test("a queued tab with a trailing-slash variant is washed but not listed", () => {
    const tabs = [makeTab({ id: 1, url: "https://example.com" })];
    const items = [makeItem({ normUrl: "https://example.com" })];
    expect(tabsToWash(tabs, [], null)).toEqual([1]);
    expect(triageTabs(tabs, [], items, null)).toEqual([]);
  });

  test("a non-http(s) tab is washed but not listed", () => {
    const tabs = [makeTab({ id: 1, url: "about:blank" }), makeTab({ id: 2, url: "moz-extension://abc/page.html" })];
    expect(tabsToWash(tabs, [], null)).toEqual([1, 2]);
    expect(triageTabs(tabs, [], [], null)).toEqual([]);
  });

  test("incognito tabs are never listed", () => {
    const tabs = [makeTab({ id: 1, incognito: true })];
    expect(triageTabs(tabs, [], [], null)).toEqual([]);
  });

  test("the kept tab is never listed", () => {
    const tabs = [makeTab({ id: 1 }), makeTab({ id: 2 })];
    const result = triageTabs(tabs, [], [], 1);
    expect(result.map((t) => t.id)).toEqual([2]);
  });

  test("a tab has no active or pinned exemption and so is listed", () => {
    const tabs = [makeTab({ id: 1 })];
    expect(triageTabs(tabs, [], [], null).map((t) => t.id)).toEqual([1]);
  });

  test("an unqueued http(s) tab is listed", () => {
    const tabs = [makeTab({ id: 1, url: "https://example.com/page" })];
    expect(triageTabs(tabs, [], [], null).map((t) => t.id)).toEqual([1]);
  });

  test("tabs without an id are ignored", () => {
    const tabs = [makeTab({ id: undefined })];
    expect(triageTabs(tabs, [], [], null)).toEqual([]);
  });

  test("empty input yields an empty list", () => {
    expect(triageTabs([], [], [], null)).toEqual([]);
  });

  test("ordering is by windowId, then index, then id", () => {
    const tabs = [
      makeTab({ id: 3, windowId: 2, index: 0 }),
      makeTab({ id: 1, windowId: 1, index: 1 }),
      makeTab({ id: 2, windowId: 1, index: 0 }),
      makeTab({ id: 5, windowId: 1, index: 1 }),
    ];
    expect(triageTabs(tabs, [], [], null).map((t) => t.id)).toEqual([2, 1, 5, 3]);
  });
});
