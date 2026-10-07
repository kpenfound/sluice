import { describe, expect, test } from "vitest";
import {
  DEFAULT_AUTO_CLOSE_AFTER,
  MIN_AUTO_CLOSE_AFTER,
  RECENTLY_CLOSED_MAX,
  RECENTLY_CLOSED_MAX_AGE,
  SESSION_KEY,
  addClosed,
  buildTrackedTab,
  isClosable,
  isQueuedUrl,
  isValidAutoCloseAfter,
  parseSessionValue,
  pruneClosed,
  remainingTime,
  tabsToClose,
} from "./lifecycle";
import type { ClosedTab, LifecycleTabInput, LiveTab, TrackedTab } from "./lifecycle";
import { HOUR } from "./model";
import type { Item } from "./model";

const NOW = 1_700_000_000_000;

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

function makeLive(overrides: Partial<LiveTab> = {}): LiveTab {
  return {
    id: 1,
    active: false,
    audible: false,
    incognito: false,
    url: "https://example.com/",
    ...overrides,
  };
}

function makeClosed(overrides: Partial<ClosedTab> = {}): ClosedTab {
  return {
    id: "closed-1",
    trackId: "track-1",
    url: "https://example.com/",
    normUrl: "https://example.com",
    title: "Example",
    closedAt: NOW,
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
  test("DEFAULT_AUTO_CLOSE_AFTER is 2 hours", () => {
    expect(DEFAULT_AUTO_CLOSE_AFTER).toBe(7_200_000);
  });

  test("RECENTLY_CLOSED_MAX_AGE is 7 days", () => {
    expect(RECENTLY_CLOSED_MAX_AGE).toBe(604_800_000);
  });

  test("RECENTLY_CLOSED_MAX is 100", () => {
    expect(RECENTLY_CLOSED_MAX).toBe(100);
  });

  test("MIN_AUTO_CLOSE_AFTER is one minute", () => {
    expect(MIN_AUTO_CLOSE_AFTER).toBe(60 * 1000);
  });

  test("SESSION_KEY is sluice", () => {
    expect(SESSION_KEY).toBe("sluice");
  });
});

describe("isClosable", () => {
  test("accepts http URLs", () => {
    expect(isClosable("http://example.com")).toBe(true);
  });

  test("accepts https URLs", () => {
    expect(isClosable("https://example.com/path")).toBe(true);
  });

  test("rejects an unparseable URL", () => {
    expect(isClosable("not a url")).toBe(false);
  });

  test("rejects a non-http(s) scheme", () => {
    expect(isClosable("about:blank")).toBe(false);
    expect(isClosable("ftp://example.com")).toBe(false);
  });
});

describe("isValidAutoCloseAfter", () => {
  test("rejects 0", () => {
    expect(isValidAutoCloseAfter(0)).toBe(false);
  });

  test("rejects negatives", () => {
    expect(isValidAutoCloseAfter(-60 * 1000)).toBe(false);
  });

  test("rejects NaN", () => {
    expect(isValidAutoCloseAfter(NaN)).toBe(false);
  });

  test("rejects Infinity", () => {
    expect(isValidAutoCloseAfter(Infinity)).toBe(false);
  });

  test("rejects a non-whole-minute value", () => {
    expect(isValidAutoCloseAfter(90 * 1000)).toBe(false);
  });

  test("accepts 1 minute", () => {
    expect(isValidAutoCloseAfter(60 * 1000)).toBe(true);
  });

  test("accepts 2 hours", () => {
    expect(isValidAutoCloseAfter(2 * HOUR)).toBe(true);
  });
});

describe("remainingTime", () => {
  test("is null for a keep-open tab, even with a running timer", () => {
    const tab = makeTracked({ keepOpen: true, inactiveSince: NOW - HOUR });
    expect(remainingTime(tab, 2 * HOUR, NOW)).toBeNull();
  });

  test("is null when inactiveSince is null (the active tab)", () => {
    const tab = makeTracked({ inactiveSince: null });
    expect(remainingTime(tab, 2 * HOUR, NOW)).toBeNull();
  });

  test("is positive before the timeout", () => {
    const tab = makeTracked({ inactiveSince: NOW - HOUR });
    expect(remainingTime(tab, 2 * HOUR, NOW)).toBe(HOUR);
  });

  test("is exactly 0 at the timeout boundary", () => {
    const tab = makeTracked({ inactiveSince: NOW - 2 * HOUR });
    expect(remainingTime(tab, 2 * HOUR, NOW)).toBe(0);
  });

  test("is negative after the timeout", () => {
    const tab = makeTracked({ inactiveSince: NOW - 3 * HOUR });
    expect(remainingTime(tab, 2 * HOUR, NOW)).toBe(-HOUR);
  });
});

describe("tabsToClose", () => {
  test("includes an expired tab at exactly the boundary", () => {
    const tracked = makeTracked({ tabId: 1, inactiveSince: NOW - 2 * HOUR });
    const live = [makeLive({ id: 1 })];
    expect(tabsToClose([tracked], live, 2 * HOUR, NOW)).toEqual([1]);
  });

  test("excludes a tab that is not yet expired", () => {
    const tracked = makeTracked({ tabId: 1, inactiveSince: NOW - HOUR });
    const live = [makeLive({ id: 1 })];
    expect(tabsToClose([tracked], live, 2 * HOUR, NOW)).toEqual([]);
  });

  test("excludes the active tab", () => {
    const tracked = makeTracked({ tabId: 1, inactiveSince: NOW - 2 * HOUR });
    const live = [makeLive({ id: 1, active: true })];
    expect(tabsToClose([tracked], live, 2 * HOUR, NOW)).toEqual([]);
  });

  test("excludes a keep-open tab", () => {
    const tracked = makeTracked({ tabId: 1, keepOpen: true, inactiveSince: NOW - 2 * HOUR });
    const live = [makeLive({ id: 1 })];
    expect(tabsToClose([tracked], live, 2 * HOUR, NOW)).toEqual([]);
  });

  test("excludes an audible tab", () => {
    const tracked = makeTracked({ tabId: 1, inactiveSince: NOW - 2 * HOUR });
    const live = [makeLive({ id: 1, audible: true })];
    expect(tabsToClose([tracked], live, 2 * HOUR, NOW)).toEqual([]);
  });

  test("excludes an incognito tab", () => {
    const tracked = makeTracked({ tabId: 1, inactiveSince: NOW - 2 * HOUR });
    const live = [makeLive({ id: 1, incognito: true })];
    expect(tabsToClose([tracked], live, 2 * HOUR, NOW)).toEqual([]);
  });

  test("excludes a tab whose live URL is not http(s)", () => {
    const tracked = makeTracked({ tabId: 1, inactiveSince: NOW - 2 * HOUR });
    const live = [makeLive({ id: 1, url: "about:blank" })];
    expect(tabsToClose([tracked], live, 2 * HOUR, NOW)).toEqual([]);
  });

  test("excludes a tab missing from live", () => {
    const tracked = makeTracked({ tabId: 1, inactiveSince: NOW - 2 * HOUR });
    expect(tabsToClose([tracked], [], 2 * HOUR, NOW)).toEqual([]);
  });
});

describe("isQueuedUrl", () => {
  test("matches when normalize() makes the URLs equal despite a utm param", () => {
    const items = [makeItem({ normUrl: "https://example.com/page" })];
    expect(isQueuedUrl("https://example.com/page?utm_source=x", items)).toBe(true);
  });

  test("matches when normalize() makes the URLs equal despite a trailing slash", () => {
    const items = [makeItem({ normUrl: "https://example.com/page" })];
    expect(isQueuedUrl("https://example.com/page/", items)).toBe(true);
  });

  test("doesn't match an unrelated URL", () => {
    const items = [makeItem({ normUrl: "https://example.com/page" })];
    expect(isQueuedUrl("https://example.com/other", items)).toBe(false);
  });
});

describe("addClosed", () => {
  test("puts the new entry first", () => {
    const existing = makeClosed({ id: "old", normUrl: "https://example.com/old", closedAt: NOW - HOUR });
    const entry = makeClosed({ id: "new", normUrl: "https://example.com/new", closedAt: NOW });
    expect(addClosed([existing], entry, NOW)).toEqual([entry, existing]);
  });

  test("replaces an existing entry with the same normUrl", () => {
    const existing = makeClosed({ id: "old", normUrl: "https://example.com/page", closedAt: NOW - HOUR });
    const entry = makeClosed({ id: "new", normUrl: "https://example.com/page", closedAt: NOW });
    expect(addClosed([existing], entry, NOW)).toEqual([entry]);
  });

  test("prunes after adding", () => {
    const old = makeClosed({ id: "stale", normUrl: "https://example.com/stale", closedAt: NOW - RECENTLY_CLOSED_MAX_AGE - 1 });
    const entry = makeClosed({ id: "new", normUrl: "https://example.com/new", closedAt: NOW });
    expect(addClosed([old], entry, NOW)).toEqual([entry]);
  });
});

describe("pruneClosed", () => {
  test("keeps an entry exactly 7 days old", () => {
    const entry = makeClosed({ closedAt: NOW - RECENTLY_CLOSED_MAX_AGE });
    const list = [entry];
    expect(pruneClosed(list, NOW)).toBe(list);
  });

  test("drops an entry just past 7 days old", () => {
    const entry = makeClosed({ closedAt: NOW - RECENTLY_CLOSED_MAX_AGE - 1 });
    expect(pruneClosed([entry], NOW)).toEqual([]);
  });

  test("caps at 100 entries, dropping the oldest first", () => {
    const list: ClosedTab[] = [];
    for (let i = 0; i < 101; i++) {
      list.push(makeClosed({ id: `closed-${i}`, normUrl: `https://example.com/${i}`, closedAt: NOW - i * 1000 }));
    }
    const result = pruneClosed(list, NOW);
    expect(result).toHaveLength(100);
    expect(result.at(-1)?.id).toBe("closed-99");
    expect(result.some((e) => e.id === "closed-100")).toBe(false);
  });

  test("returns the same array reference when nothing is pruned", () => {
    const list = [makeClosed()];
    expect(pruneClosed(list, NOW)).toBe(list);
  });
});

describe("parseSessionValue", () => {
  test("accepts a well-formed value", () => {
    expect(parseSessionValue({ trackId: "track-1", keepOpen: true })).toEqual({
      trackId: "track-1",
      keepOpen: true,
    });
  });

  test("returns null for undefined", () => {
    expect(parseSessionValue(undefined)).toBeNull();
  });

  test("returns null for a missing trackId", () => {
    expect(parseSessionValue({ keepOpen: true })).toBeNull();
  });

  test("returns null for an empty trackId", () => {
    expect(parseSessionValue({ trackId: "", keepOpen: true })).toBeNull();
  });

  test("returns null for a non-boolean keepOpen", () => {
    expect(parseSessionValue({ trackId: "track-1", keepOpen: "yes" })).toBeNull();
  });
});

describe("buildTrackedTab", () => {
  function makeTab(overrides: Partial<LifecycleTabInput> = {}): LifecycleTabInput {
    return {
      id: 1,
      windowId: 1,
      active: false,
      url: "https://example.com/",
      title: "Example",
      ...overrides,
    };
  }

  test("adopts a session value whose trackId is not taken", () => {
    const tab = makeTab();
    const sessionValue = { trackId: "restored-1", keepOpen: true };
    const result = buildTrackedTab(tab, sessionValue, new Set(), "fresh-1", NOW);
    expect(result.trackId).toBe("restored-1");
    expect(result.keepOpen).toBe(true);
  });

  test("uses the fresh id and keepOpen false when the session value is null", () => {
    const tab = makeTab();
    const result = buildTrackedTab(tab, null, new Set(), "fresh-1", NOW);
    expect(result.trackId).toBe("fresh-1");
    expect(result.keepOpen).toBe(false);
  });

  test("uses the fresh id and keepOpen false when the session value's trackId is already taken", () => {
    const tab = makeTab();
    const sessionValue = { trackId: "dup-1", keepOpen: true };
    const result = buildTrackedTab(tab, sessionValue, new Set(["dup-1"]), "fresh-1", NOW);
    expect(result.trackId).toBe("fresh-1");
    expect(result.keepOpen).toBe(false);
  });

  test("sets inactiveSince null for an active tab", () => {
    const tab = makeTab({ active: true });
    const result = buildTrackedTab(tab, null, new Set(), "fresh-1", NOW);
    expect(result.inactiveSince).toBeNull();
  });

  test("sets inactiveSince to now for an inactive tab", () => {
    const tab = makeTab({ active: false });
    const result = buildTrackedTab(tab, null, new Set(), "fresh-1", NOW);
    expect(result.inactiveSince).toBe(NOW);
  });
});
