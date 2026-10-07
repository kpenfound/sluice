import { describe, expect, test } from "vitest";
import type { AwayGap } from "../lib/away";
import type { ClosedTab, TrackedTab } from "../lib/lifecycle";
import { HOUR, RIFFLES } from "../lib/model";
import type { Bucket, Item, Pause } from "../lib/model";
import type { WashTab } from "../lib/wash";
import {
  dueLabel,
  formatDuration,
  keyAction,
  launcherView,
  openTabsView,
  recentlyClosedView,
  triageView,
} from "./model";
import type { LauncherViewInput } from "./model";

const NOW = 1_700_000_000_000;

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
    queuedAt: NOW,
    riffleEnteredAt: NOW,
    lastVisitedAt: null,
    ...overrides,
  };
}

function baseInput(overrides: Partial<LauncherViewInput> = {}): LauncherViewInput {
  return {
    buckets,
    items: [],
    pauses: [],
    awayGap: null,
    selectedBucketId: "b-dagger",
    query: "",
    now: NOW,
    ...overrides,
  };
}

describe("launcherView: bucket switcher", () => {
  test("lists every bucket sorted by order, with overdue counts including zero", () => {
    const items = [
      makeItem({ id: "i1", bucketId: "b-dagger", riffle: "24h", riffleEnteredAt: NOW - 100 * HOUR }),
    ];
    const view = launcherView(baseInput({ items }));
    expect(view.buckets.map((b) => b.id)).toEqual(["b-dagger", "b-personal", "b-side"]);
    expect(view.buckets.map((b) => b.overdueCount)).toEqual([1, 0, 0]);
  });

  test("marks the effective selected bucket", () => {
    const view = launcherView(baseInput({ selectedBucketId: "b-personal" }));
    expect(view.buckets.find((b) => b.id === "b-personal")?.selected).toBe(true);
    expect(view.buckets.find((b) => b.id === "b-dagger")?.selected).toBe(false);
    expect(view.selectedBucketId).toBe("b-personal");
  });

  test("falls back to the lowest-order bucket when selectedBucketId names no bucket", () => {
    const view = launcherView(baseInput({ selectedBucketId: "does-not-exist" }));
    expect(view.selectedBucketId).toBe("b-dagger");
  });

  test("falls back to the lowest-order bucket when selectedBucketId is null", () => {
    const view = launcherView(baseInput({ selectedBucketId: null }));
    expect(view.selectedBucketId).toBe("b-dagger");
  });
});

describe("launcherView: grouping into columns", () => {
  test("places each item only in its own riffle's column", () => {
    const items = [
      makeItem({ id: "i-24h", riffle: "24h" }),
      makeItem({ id: "i-72h", riffle: "72h" }),
      makeItem({ id: "i-1w", riffle: "1w" }),
      makeItem({ id: "i-1mo", riffle: "1mo" }),
      makeItem({ id: "i-stale", riffle: "stale" }),
    ];
    const view = launcherView(baseInput({ items }));
    expect(view.columns.map((c) => c.riffle)).toEqual(["24h", "72h", "1w", "1mo", "stale"]);
    for (const column of view.columns) {
      expect(column.items.map((i) => i.id)).toEqual([`i-${column.riffle}`]);
    }
  });

  test("excludes items from other buckets when no search is active", () => {
    const items = [
      makeItem({ id: "mine", bucketId: "b-dagger" }),
      makeItem({ id: "other", bucketId: "b-personal" }),
    ];
    const view = launcherView(baseInput({ items, selectedBucketId: "b-dagger" }));
    const column72h = view.columns.find((c) => c.riffle === "72h");
    expect(column72h?.items.map((i) => i.id)).toEqual(["mine"]);
  });
});

describe("launcherView: ordering within a column", () => {
  test("overdue items come first, most overdue first, then the rest ascending by remaining", () => {
    const items = [
      // 72h TTL; remaining = TTL - elapsed
      makeItem({ id: "soon", riffle: "72h", riffleEnteredAt: NOW - 70 * HOUR }), // remaining 2h
      makeItem({ id: "later", riffle: "72h", riffleEnteredAt: NOW - 10 * HOUR }), // remaining 62h
      makeItem({ id: "very-overdue", riffle: "72h", riffleEnteredAt: NOW - 100 * HOUR }), // remaining -28h
      makeItem({ id: "slightly-overdue", riffle: "72h", riffleEnteredAt: NOW - 73 * HOUR }), // remaining -1h
    ];
    const view = launcherView(baseInput({ items }));
    const column = view.columns.find((c) => c.riffle === "72h");
    expect(column?.items.map((i) => i.id)).toEqual([
      "very-overdue",
      "slightly-overdue",
      "soon",
      "later",
    ]);
  });

  test("ties on remaining break by queuedAt ascending", () => {
    const items = [
      makeItem({
        id: "newer",
        riffle: "72h",
        riffleEnteredAt: NOW - 10 * HOUR,
        queuedAt: NOW - 5 * HOUR,
      }),
      makeItem({
        id: "older",
        riffle: "72h",
        riffleEnteredAt: NOW - 10 * HOUR,
        queuedAt: NOW - 50 * HOUR,
      }),
    ];
    const view = launcherView(baseInput({ items }));
    const column = view.columns.find((c) => c.riffle === "72h");
    expect(column?.items.map((i) => i.id)).toEqual(["older", "newer"]);
  });

  test("ties on remaining and queuedAt break by id", () => {
    const items = [
      makeItem({ id: "b-item", riffle: "72h", riffleEnteredAt: NOW - 10 * HOUR, queuedAt: NOW - 5 * HOUR }),
      makeItem({ id: "a-item", riffle: "72h", riffleEnteredAt: NOW - 10 * HOUR, queuedAt: NOW - 5 * HOUR }),
    ];
    const view = launcherView(baseInput({ items }));
    const column = view.columns.find((c) => c.riffle === "72h");
    expect(column?.items.map((i) => i.id)).toEqual(["a-item", "b-item"]);
  });

  test("Stale orders by riffleEnteredAt descending (newest first)", () => {
    const items = [
      makeItem({ id: "oldest", riffle: "stale", riffleEnteredAt: NOW - 100 * HOUR }),
      makeItem({ id: "newest", riffle: "stale", riffleEnteredAt: NOW - 1 * HOUR }),
      makeItem({ id: "middle", riffle: "stale", riffleEnteredAt: NOW - 50 * HOUR }),
    ];
    const view = launcherView(baseInput({ items }));
    const column = view.columns.find((c) => c.riffle === "stale");
    expect(column?.items.map((i) => i.id)).toEqual(["newest", "middle", "oldest"]);
  });

  test("Stale ties on riffleEnteredAt break by queuedAt ascending, then id", () => {
    const items = [
      makeItem({
        id: "z",
        riffle: "stale",
        riffleEnteredAt: NOW - 10 * HOUR,
        queuedAt: NOW - 5 * HOUR,
      }),
      makeItem({
        id: "a",
        riffle: "stale",
        riffleEnteredAt: NOW - 10 * HOUR,
        queuedAt: NOW - 5 * HOUR,
      }),
      makeItem({
        id: "earlier-queued",
        riffle: "stale",
        riffleEnteredAt: NOW - 10 * HOUR,
        queuedAt: NOW - 50 * HOUR,
      }),
    ];
    const view = launcherView(baseInput({ items }));
    const column = view.columns.find((c) => c.riffle === "stale");
    expect(column?.items.map((i) => i.id)).toEqual(["earlier-queued", "a", "z"]);
  });
});

describe("launcherView: item view fields", () => {
  test("carries favIconUrl, domain, timeInRiffle, totalAge, remaining and overdue", () => {
    const item = makeItem({
      id: "i1",
      url: "https://example.com/post",
      favIconUrl: "https://example.com/favicon.ico",
      riffle: "24h",
      riffleEnteredAt: NOW - 2 * HOUR,
      queuedAt: NOW - 5 * HOUR,
    });
    const view = launcherView(baseInput({ items: [item] }));
    const column = view.columns.find((c) => c.riffle === "24h");
    const itemView = column?.items[0];
    expect(itemView?.favIconUrl).toBe("https://example.com/favicon.ico");
    expect(itemView?.domain).toBe("example.com");
    expect(itemView?.timeInRiffle).toBe(2 * HOUR);
    expect(itemView?.totalAge).toBe(5 * HOUR);
    expect(itemView?.remaining).toBe(22 * HOUR);
    expect(itemView?.overdue).toBe(false);
  });

  test("favIconUrl is undefined when absent", () => {
    const item = makeItem({ id: "i1" });
    delete item.favIconUrl;
    const view = launcherView(baseInput({ items: [item] }));
    const column = view.columns.find((c) => c.riffle === "72h");
    expect(column?.items[0]?.favIconUrl).toBeUndefined();
  });

  test("domain is an empty string for an unparseable URL, and doesn't throw", () => {
    const item = makeItem({ id: "i1", url: "not a url" });
    expect(() => launcherView(baseInput({ items: [item] }))).not.toThrow();
    const view = launcherView(baseInput({ items: [item] }));
    const column = view.columns.find((c) => c.riffle === "72h");
    expect(column?.items[0]?.domain).toBe("");
  });

  test("remaining is null for Stale items", () => {
    const item = makeItem({ id: "i1", riffle: "stale" });
    const view = launcherView(baseInput({ items: [item] }));
    const column = view.columns.find((c) => c.riffle === "stale");
    expect(column?.items[0]?.remaining).toBeNull();
    expect(column?.items[0]?.overdue).toBe(false);
  });
});

describe("launcherView: search", () => {
  test("a non-blank query matches title or url case-insensitively, across every bucket", () => {
    const items = [
      makeItem({ id: "title-match", bucketId: "b-dagger", title: "Read about Widgets", url: "https://a.example/x" }),
      makeItem({ id: "url-match", bucketId: "b-personal", title: "Something else", url: "https://widgets.example/y" }),
      makeItem({ id: "no-match", bucketId: "b-side", title: "Unrelated", url: "https://other.example/z" }),
    ];
    const view = launcherView(baseInput({ items, selectedBucketId: "b-dagger", query: "WIDGET" }));
    const column = view.columns.find((c) => c.riffle === "72h");
    expect(column?.items.map((i) => i.id)).toEqual(["title-match", "url-match"]);
  });

  test("matches include Stale, and are labelled with their bucket name", () => {
    const items = [
      makeItem({ id: "stale-match", bucketId: "b-personal", riffle: "stale", title: "Widget archive" }),
    ];
    const view = launcherView(baseInput({ items, selectedBucketId: "b-dagger", query: "widget" }));
    const column = view.columns.find((c) => c.riffle === "stale");
    expect(column?.items.map((i) => i.id)).toEqual(["stale-match"]);
    expect(column?.items[0]?.bucketName).toBe("Personal");
  });

  test("a blank or whitespace-only query shows only the selected bucket's items", () => {
    const items = [
      makeItem({ id: "mine", bucketId: "b-dagger" }),
      makeItem({ id: "other", bucketId: "b-personal" }),
    ];
    const blank = launcherView(baseInput({ items, selectedBucketId: "b-dagger", query: "   " }));
    const column = blank.columns.find((c) => c.riffle === "72h");
    expect(column?.items.map((i) => i.id)).toEqual(["mine"]);
  });

  test("staleExpanded is true only while a query is active", () => {
    const noQuery = launcherView(baseInput({ query: "" }));
    expect(noQuery.staleExpanded).toBe(false);
    const withQuery = launcherView(baseInput({ query: "x" }));
    expect(withQuery.staleExpanded).toBe(true);
  });
});

describe("launcherView: pause banner", () => {
  test("shows the running pause's start", () => {
    const pauses: Pause[] = [{ id: "p1", start: NOW - HOUR, end: null }];
    const view = launcherView(baseInput({ pauses }));
    expect(view.pauseBanner).toEqual({ start: NOW - HOUR });
  });

  test("is null with no pause", () => {
    const view = launcherView(baseInput({ pauses: [] }));
    expect(view.pauseBanner).toBeNull();
  });

  test("is null for a pause scheduled in the future", () => {
    const pauses: Pause[] = [{ id: "p1", start: NOW + HOUR, end: null }];
    const view = launcherView(baseInput({ pauses }));
    expect(view.pauseBanner).toBeNull();
  });
});

describe("launcherView: away-gap banner", () => {
  test("shows the gap's range and the freed-item count", () => {
    const gap: AwayGap = { start: NOW - 100 * HOUR, end: NOW };
    const items = [
      // went overdue only because of the gap: 24h TTL, entered riffle before the gap started
      makeItem({ id: "freed", riffle: "24h", riffleEnteredAt: NOW - 100 * HOUR }),
    ];
    const view = launcherView(baseInput({ items, awayGap: gap }));
    expect(view.awayGapBanner).toEqual({ start: gap.start, end: gap.end, freed: 1 });
  });

  test("is null with no pending gap", () => {
    const view = launcherView(baseInput({ awayGap: null }));
    expect(view.awayGapBanner).toBeNull();
  });
});

describe("launcherView: actionsEnabled", () => {
  test("is true with no pending away gap", () => {
    const view = launcherView(baseInput({ awayGap: null }));
    expect(view.actionsEnabled).toBe(true);
  });

  test("is false while an away gap is pending", () => {
    const gap: AwayGap = { start: NOW - 100 * HOUR, end: NOW };
    const view = launcherView(baseInput({ awayGap: gap }));
    expect(view.actionsEnabled).toBe(false);
  });
});

describe("formatDuration", () => {
  test("formats sub-hour durations in minutes", () => {
    expect(formatDuration(5 * 60 * 1000)).toBe("5m");
  });

  test("formats sub-day durations in hours", () => {
    expect(formatDuration(5 * HOUR)).toBe("5h");
  });

  test("formats longer durations in days", () => {
    expect(formatDuration(5 * 24 * HOUR)).toBe("5d");
  });
});

describe("dueLabel", () => {
  test("is empty for null (Stale)", () => {
    expect(dueLabel(null)).toBe("");
  });

  test("is 'due in X' for a positive remaining", () => {
    expect(dueLabel(5 * HOUR)).toBe("due in 5h");
  });

  test("is 'overdue by X' at the remaining = 0 boundary", () => {
    expect(dueLabel(0)).toBe("overdue by 0m");
  });

  test("is 'overdue by X' for a negative remaining", () => {
    expect(dueLabel(-3 * HOUR)).toBe("overdue by 3h");
  });

  test("is 'due in X' for remaining just above zero", () => {
    expect(dueLabel(60 * 1000)).toBe("due in 1m");
  });
});

describe("keyAction", () => {
  test("maps navigation, action and bucket/search keys outside a text input", () => {
    expect(keyAction("ArrowDown", false)).toBe("nextItem");
    expect(keyAction("j", false)).toBe("nextItem");
    expect(keyAction("ArrowUp", false)).toBe("prevItem");
    expect(keyAction("k", false)).toBe("prevItem");
    expect(keyAction("ArrowRight", false)).toBe("nextColumn");
    expect(keyAction("l", false)).toBe("nextColumn");
    expect(keyAction("ArrowLeft", false)).toBe("prevColumn");
    expect(keyAction("h", false)).toBe("prevColumn");
    expect(keyAction("Enter", false)).toBe("open");
    expect(keyAction("o", false)).toBe("open");
    expect(keyAction("d", false)).toBe("defer");
    expect(keyAction("m", false)).toBe("move");
    expect(keyAction("b", false)).toBe("changeBucket");
    expect(keyAction("x", false)).toBe("resolve");
    expect(keyAction("Delete", false)).toBe("resolve");
    expect(keyAction("/", false)).toBe("focusSearch");
    expect(keyAction("[", false)).toBe("prevBucket");
    expect(keyAction("]", false)).toBe("nextBucket");
    expect(keyAction("Escape", false)).toBe("clearSearch");
  });

  test("returns null for an unmapped key", () => {
    expect(keyAction("q", false)).toBeNull();
  });

  test("every key but Escape is ignored while focus is in a text input", () => {
    expect(keyAction("j", true)).toBeNull();
    expect(keyAction("ArrowDown", true)).toBeNull();
    expect(keyAction("/", true)).toBeNull();
    expect(keyAction("d", true)).toBeNull();
    expect(keyAction("Escape", true)).toBe("clearSearch");
  });
});

function makeTrackedTab(overrides: Partial<TrackedTab> = {}): TrackedTab {
  return {
    tabId: 1,
    windowId: 1,
    trackId: "t-1",
    url: "https://example.com/post",
    title: "A post",
    favIconUrl: "https://example.com/favicon.ico",
    keepOpen: false,
    inactiveSince: NOW - HOUR,
    ...overrides,
  };
}

describe("openTabsView: cues", () => {
  test("active for a tab with no running timer", () => {
    const tab = makeTrackedTab({ inactiveSince: null, keepOpen: false });
    const [row] = openTabsView({ trackedTabs: [tab], autoCloseAfter: 2 * HOUR, now: NOW });
    expect(row?.cue).toEqual({ kind: "active" });
  });

  test("active takes priority over keepOpen when both could apply", () => {
    const tab = makeTrackedTab({ inactiveSince: null, keepOpen: true });
    const [row] = openTabsView({ trackedTabs: [tab], autoCloseAfter: 2 * HOUR, now: NOW });
    expect(row?.cue).toEqual({ kind: "active" });
  });

  test("keptOpen for a kept-open tab with a running timer", () => {
    const tab = makeTrackedTab({ inactiveSince: NOW - HOUR, keepOpen: true });
    const [row] = openTabsView({ trackedTabs: [tab], autoCloseAfter: 2 * HOUR, now: NOW });
    expect(row?.cue).toEqual({ kind: "keptOpen" });
  });

  test("remaining with a 'closes in' label while time is left", () => {
    const tab = makeTrackedTab({ inactiveSince: NOW - HOUR, keepOpen: false });
    const [row] = openTabsView({ trackedTabs: [tab], autoCloseAfter: 2 * HOUR, now: NOW });
    expect(row?.cue).toEqual({ kind: "remaining", ms: HOUR, label: "closes in 1h" });
  });

  test("closing exactly at the remaining = 0 boundary", () => {
    const tab = makeTrackedTab({ inactiveSince: NOW - 2 * HOUR, keepOpen: false });
    const [row] = openTabsView({ trackedTabs: [tab], autoCloseAfter: 2 * HOUR, now: NOW });
    expect(row?.cue).toEqual({ kind: "closing" });
  });

  test("closing past the boundary", () => {
    const tab = makeTrackedTab({ inactiveSince: NOW - 3 * HOUR, keepOpen: false });
    const [row] = openTabsView({ trackedTabs: [tab], autoCloseAfter: 2 * HOUR, now: NOW });
    expect(row?.cue).toEqual({ kind: "closing" });
  });

  test("a changed autoCloseAfter changes the remaining time", () => {
    const tab = makeTrackedTab({ inactiveSince: NOW - HOUR, keepOpen: false });
    const shortTimeout = openTabsView({ trackedTabs: [tab], autoCloseAfter: HOUR, now: NOW });
    const longTimeout = openTabsView({ trackedTabs: [tab], autoCloseAfter: 3 * HOUR, now: NOW });
    expect(shortTimeout[0]?.cue).toEqual({ kind: "closing" });
    expect(longTimeout[0]?.cue).toEqual({ kind: "remaining", ms: 2 * HOUR, label: "closes in 2h" });
  });

  test("carries title, url, domain, favIconUrl and keepOpen through", () => {
    const tab = makeTrackedTab({
      tabId: 42,
      title: "A post",
      url: "https://example.com/post",
      favIconUrl: "https://example.com/favicon.ico",
      keepOpen: true,
      inactiveSince: NOW - HOUR,
    });
    const [row] = openTabsView({ trackedTabs: [tab], autoCloseAfter: 2 * HOUR, now: NOW });
    expect(row).toMatchObject({
      tabId: 42,
      title: "A post",
      url: "https://example.com/post",
      domain: "example.com",
      favIconUrl: "https://example.com/favicon.ico",
      keepOpen: true,
    });
  });
});

describe("openTabsView: ordering", () => {
  test("running-timer rows come first, soonest-closing first, then active/keptOpen rows", () => {
    const tabs = [
      makeTrackedTab({ tabId: 1, inactiveSince: NOW - 90 * 60 * 1000 }), // remaining 30m
      makeTrackedTab({ tabId: 2, inactiveSince: null }), // active
      makeTrackedTab({ tabId: 3, inactiveSince: NOW - 3 * HOUR }), // closing (remaining -1h)
      makeTrackedTab({ tabId: 4, keepOpen: true, inactiveSince: NOW - HOUR }), // kept open
      makeTrackedTab({ tabId: 5, inactiveSince: NOW - 30 * 60 * 1000 }), // remaining 90m
    ];
    const rows = openTabsView({ trackedTabs: tabs, autoCloseAfter: 2 * HOUR, now: NOW });
    expect(rows.map((r) => r.tabId)).toEqual([3, 1, 5, 2, 4]);
  });

  test("ties on remaining time break by ascending tabId", () => {
    const tabs = [
      makeTrackedTab({ tabId: 20, inactiveSince: NOW - HOUR }),
      makeTrackedTab({ tabId: 10, inactiveSince: NOW - HOUR }),
    ];
    const rows = openTabsView({ trackedTabs: tabs, autoCloseAfter: 2 * HOUR, now: NOW });
    expect(rows.map((r) => r.tabId)).toEqual([10, 20]);
  });

  test("ties between active/keptOpen rows (no running timer) break by ascending tabId", () => {
    const tabs = [
      makeTrackedTab({ tabId: 20, inactiveSince: null }),
      makeTrackedTab({ tabId: 10, keepOpen: true, inactiveSince: NOW - HOUR }),
    ];
    const rows = openTabsView({ trackedTabs: tabs, autoCloseAfter: 2 * HOUR, now: NOW });
    expect(rows.map((r) => r.tabId)).toEqual([10, 20]);
  });
});

function makeClosedTab(overrides: Partial<ClosedTab> = {}): ClosedTab {
  return {
    id: "c-1",
    trackId: "t-1",
    url: "https://example.com/post",
    normUrl: "https://example.com/post",
    title: "A post",
    favIconUrl: "https://example.com/favicon.ico",
    closedAt: NOW,
    ...overrides,
  };
}

describe("recentlyClosedView", () => {
  test("lists entries newest first by closedAt", () => {
    const entries = [
      makeClosedTab({ id: "oldest", url: "https://a.example/1", closedAt: NOW - 3 * HOUR }),
      makeClosedTab({ id: "newest", url: "https://a.example/2", closedAt: NOW - 1 * HOUR }),
      makeClosedTab({ id: "middle", url: "https://a.example/3", closedAt: NOW - 2 * HOUR }),
    ];
    const view = recentlyClosedView({ recentlyClosed: entries, items: [] });
    expect(view.map((e) => e.id)).toEqual(["newest", "middle", "oldest"]);
  });

  test("hides an entry whose URL was queued after it closed, matched through normalize()", () => {
    const entries = [
      makeClosedTab({ id: "queued", url: "https://example.com/post?utm_source=x" }),
      makeClosedTab({ id: "not-queued", url: "https://other.example/page" }),
    ];
    const items: Item[] = [
      {
        id: "item-1",
        url: "https://example.com/post",
        normUrl: "https://example.com/post",
        title: "A post",
        bucketId: "b-dagger",
        riffle: "72h",
        queuedAt: NOW,
        riffleEnteredAt: NOW,
        lastVisitedAt: null,
      },
    ];
    const view = recentlyClosedView({ recentlyClosed: entries, items });
    expect(view.map((e) => e.id)).toEqual(["not-queued"]);
  });
});

function makeWashTab(overrides: Partial<WashTab> = {}): WashTab {
  return {
    id: 1,
    windowId: 1,
    index: 0,
    url: "https://example.com/",
    title: "Example",
    favIconUrl: "https://example.com/favicon.ico",
    audible: false,
    incognito: false,
    ...overrides,
  };
}

describe("triageView: rows", () => {
  test("lists tabs in triageTabs order, with title/url/domain/favIconUrl", () => {
    const tabs = [
      makeWashTab({ id: 2, windowId: 1, index: 1, url: "https://b.example/", title: "B" }),
      makeWashTab({ id: 1, windowId: 1, index: 0, url: "https://a.example/", title: "A" }),
    ];
    const view = triageView({
      tabs,
      trackedTabs: [],
      items: [],
      buckets,
      lastBucketId: null,
      selfTabId: null,
    });
    expect(view.rows).toEqual([
      {
        tabId: 1,
        title: "A",
        url: "https://a.example/",
        domain: "a.example",
        favIconUrl: "https://example.com/favicon.ico",
      },
      {
        tabId: 2,
        title: "B",
        url: "https://b.example/",
        domain: "b.example",
        favIconUrl: "https://example.com/favicon.ico",
      },
    ]);
  });

  test("excludes selfTabId", () => {
    const tabs = [makeWashTab({ id: 1 }), makeWashTab({ id: 2 })];
    const view = triageView({
      tabs,
      trackedTabs: [],
      items: [],
      buckets,
      lastBucketId: null,
      selfTabId: 1,
    });
    expect(view.rows.map((r) => r.tabId)).toEqual([2]);
  });

  test("excludes an audible tab", () => {
    const tabs = [makeWashTab({ id: 1, audible: true }), makeWashTab({ id: 2 })];
    const view = triageView({
      tabs,
      trackedTabs: [],
      items: [],
      buckets,
      lastBucketId: null,
      selfTabId: null,
    });
    expect(view.rows.map((r) => r.tabId)).toEqual([2]);
  });

  test("excludes an incognito tab", () => {
    const tabs = [makeWashTab({ id: 1, incognito: true }), makeWashTab({ id: 2 })];
    const view = triageView({
      tabs,
      trackedTabs: [],
      items: [],
      buckets,
      lastBucketId: null,
      selfTabId: null,
    });
    expect(view.rows.map((r) => r.tabId)).toEqual([2]);
  });

  test("excludes a tab tracked with keepOpen: true", () => {
    const tabs = [makeWashTab({ id: 1 }), makeWashTab({ id: 2 })];
    const trackedTabs = [makeTrackedTab({ tabId: 1, keepOpen: true })];
    const view = triageView({
      tabs,
      trackedTabs,
      items: [],
      buckets,
      lastBucketId: null,
      selfTabId: null,
    });
    expect(view.rows.map((r) => r.tabId)).toEqual([2]);
  });

  test("excludes a tab whose normalized URL is already queued", () => {
    const tabs = [
      makeWashTab({ id: 1, url: "https://example.com/post?utm_source=x" }),
      makeWashTab({ id: 2, url: "https://other.example/page" }),
    ];
    const items: Item[] = [makeItem({ url: "https://example.com/post", normUrl: "https://example.com/post" })];
    const view = triageView({
      tabs,
      trackedTabs: [],
      items,
      buckets,
      lastBucketId: null,
      selfTabId: null,
    });
    expect(view.rows.map((r) => r.tabId)).toEqual([2]);
  });

  test("excludes a non-http(s) tab", () => {
    const tabs = [makeWashTab({ id: 1, url: "about:preferences" }), makeWashTab({ id: 2 })];
    const view = triageView({
      tabs,
      trackedTabs: [],
      items: [],
      buckets,
      lastBucketId: null,
      selfTabId: null,
    });
    expect(view.rows.map((r) => r.tabId)).toEqual([2]);
  });
});

describe("triageView: closeCount", () => {
  test("counts a queued tab and a non-http(s) tab that rows omit", () => {
    const tabs = [
      makeWashTab({ id: 1, url: "https://example.com/post" }),
      makeWashTab({ id: 2, url: "about:preferences" }),
    ];
    const items: Item[] = [makeItem({ url: "https://example.com/post", normUrl: "https://example.com/post" })];
    const view = triageView({
      tabs,
      trackedTabs: [],
      items,
      buckets,
      lastBucketId: null,
      selfTabId: null,
    });
    expect(view.rows).toEqual([]);
    expect(view.closeCount).toBe(2);
  });

  test("excludes an exempt tab and the self tab", () => {
    const tabs = [
      makeWashTab({ id: 1 }),
      makeWashTab({ id: 2, audible: true }),
      makeWashTab({ id: 3 }),
    ];
    const trackedTabs = [makeTrackedTab({ tabId: 1, keepOpen: true })];
    const view = triageView({
      tabs,
      trackedTabs,
      items: [],
      buckets,
      lastBucketId: null,
      selfTabId: 3,
    });
    expect(view.closeCount).toBe(0);
  });
});

describe("triageView: defaultBucketId", () => {
  test("is lastBucketId when that bucket exists", () => {
    const view = triageView({
      tabs: [],
      trackedTabs: [],
      items: [],
      buckets,
      lastBucketId: "b-side",
      selfTabId: null,
    });
    expect(view.defaultBucketId).toBe("b-side");
  });

  test("falls back to the lowest-order bucket when lastBucketId's bucket is missing", () => {
    const view = triageView({
      tabs: [],
      trackedTabs: [],
      items: [],
      buckets,
      lastBucketId: "b-nonexistent",
      selfTabId: null,
    });
    expect(view.defaultBucketId).toBe("b-dagger");
  });

  test("falls back to the lowest-order bucket when lastBucketId is null", () => {
    const view = triageView({
      tabs: [],
      trackedTabs: [],
      items: [],
      buckets,
      lastBucketId: null,
      selfTabId: null,
    });
    expect(view.defaultBucketId).toBe("b-dagger");
  });

  test("is null when there are no buckets", () => {
    const view = triageView({
      tabs: [],
      trackedTabs: [],
      items: [],
      buckets: [],
      lastBucketId: null,
      selfTabId: null,
    });
    expect(view.defaultBucketId).toBeNull();
  });
});

describe("triageView: buckets and riffles", () => {
  test("buckets are sorted by order", () => {
    const view = triageView({
      tabs: [],
      trackedTabs: [],
      items: [],
      buckets,
      lastBucketId: null,
      selfTabId: null,
    });
    expect(view.buckets.map((b) => b.id)).toEqual(["b-dagger", "b-personal", "b-side"]);
  });

  test("riffles is RIFFLES", () => {
    const view = triageView({
      tabs: [],
      trackedTabs: [],
      items: [],
      buckets,
      lastBucketId: null,
      selfTabId: null,
    });
    expect(view.riffles).toEqual(RIFFLES);
  });
});

describe("triageView: empty tabs", () => {
  test("rows is empty and closeCount is 0", () => {
    const view = triageView({
      tabs: [],
      trackedTabs: [],
      items: [],
      buckets,
      lastBucketId: null,
      selfTabId: null,
    });
    expect(view.rows).toEqual([]);
    expect(view.closeCount).toBe(0);
  });
});

test("search preserves bucket identity when bucket names are identical", () => {
  const view = launcherView(baseInput({
    buckets: buckets.map((bucket) => ({ ...bucket, name: "Work" })),
    query: "post",
    items: [makeItem({ bucketId: "b-personal" })],
  }));
  const item = view.columns.find((column) => column.riffle === "72h")!.items[0]!;
  expect(item.bucketName).toBe("Work");
  expect(item.bucketId).toBe("b-personal");
});

test("internal pages have no auto-close countdown or extension identifier", () => {
  const rows = openTabsView({
    trackedTabs: [{
      tabId: 1, windowId: 1, trackId: "internal", title: "Sluice",
      url: "moz-extension://private-extension-id/newtab.html",
      keepOpen: false, inactiveSince: NOW - HOUR,
    }],
    autoCloseAfter: 2 * HOUR,
    now: NOW,
  });
  expect(rows[0]!.cue).toEqual({ kind: "notTimed" });
  expect(rows[0]!.domain).toBe("");
});
