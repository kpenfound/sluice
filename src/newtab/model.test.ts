import { describe, expect, test } from "vitest";
import type { AwayGap } from "../lib/away";
import type { ClosedTab, TrackedTab } from "../lib/lifecycle";
import { DAY, HOUR } from "../lib/model";
import type { Bucket, Item, Pause } from "../lib/model";
import type { WashTab } from "../lib/wash";
import {
  dueLabel,
  formatDuration,
  keyAction,
  launcherView,
  openTabsView,
  recentlyClosedPanelView,
  recentlyClosedView,
  STALE_SELECTION_ID,
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
    const realBuckets = view.switcher.filter((e) => !e.isStale);
    expect(realBuckets.map((b) => b.id)).toEqual(["b-dagger", "b-personal", "b-side"]);
    expect(realBuckets.map((b) => b.count)).toEqual([1, 0, 0]);
  });

  test("marks the effective selected bucket", () => {
    const view = launcherView(baseInput({ selectedBucketId: "b-personal" }));
    expect(view.switcher.find((b) => b.id === "b-personal")?.selected).toBe(true);
    expect(view.switcher.find((b) => b.id === "b-dagger")?.selected).toBe(false);
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
    const itemView = view.queue[0];
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
    expect(view.queue[0]?.favIconUrl).toBeUndefined();
  });

  test("domain is an empty string for an unparseable URL, and doesn't throw", () => {
    const item = makeItem({ id: "i1", url: "not a url" });
    expect(() => launcherView(baseInput({ items: [item] }))).not.toThrow();
    const view = launcherView(baseInput({ items: [item] }));
    expect(view.queue[0]?.domain).toBe("");
  });

  test("remaining is null for Stale items", () => {
    const item = makeItem({ id: "i1", riffle: "stale" });
    const view = launcherView(baseInput({ items: [item] }));
    expect(view.staleItems[0]?.remaining).toBeNull();
    expect(view.staleItems[0]?.overdue).toBe(false);
  });
});

describe("launcherView: the single queue", () => {
  test("holds only the selected bucket's 24h/72h/1w/1mo items, excluding Stale and other buckets", () => {
    const items = [
      makeItem({ id: "mine-24h", bucketId: "b-dagger", riffle: "24h" }),
      makeItem({ id: "mine-1mo", bucketId: "b-dagger", riffle: "1mo" }),
      makeItem({ id: "mine-stale", bucketId: "b-dagger", riffle: "stale" }),
      makeItem({ id: "other-bucket", bucketId: "b-personal", riffle: "24h" }),
    ];
    const view = launcherView(baseInput({ items, selectedBucketId: "b-dagger" }));
    expect(view.queue.map((i) => i.id).sort()).toEqual(["mine-1mo", "mine-24h"]);
    expect(view.queue.some((i) => i.id === "mine-stale")).toBe(false);
  });

  test("orders by ascending remaining across riffles: overdue first, most overdue first", () => {
    const items = [
      // 72h TTL; remaining = TTL - elapsed
      makeItem({ id: "soon-72h", riffle: "72h", riffleEnteredAt: NOW - 70 * HOUR }), // remaining 2h
      // 1mo TTL
      makeItem({ id: "later-1mo", riffle: "1mo", riffleEnteredAt: NOW - 10 * DAY }), // remaining ~20d
      // 24h TTL, overdue
      makeItem({ id: "very-overdue-24h", riffle: "24h", riffleEnteredAt: NOW - 100 * HOUR }), // remaining -76h
      // 1w TTL, slightly overdue
      makeItem({ id: "slightly-overdue-1w", riffle: "1w", riffleEnteredAt: NOW - 8 * DAY }), // remaining -1d
    ];
    const view = launcherView(baseInput({ items }));
    expect(view.queue.map((i) => i.id)).toEqual([
      "very-overdue-24h",
      "slightly-overdue-1w",
      "soon-72h",
      "later-1mo",
    ]);
  });

  test("ties on remaining (even across different riffles) break by queuedAt ascending, then id", () => {
    const items = [
      // 72h TTL, riffleEnteredAt NOW - 10h: remaining 62h
      makeItem({
        id: "b-newer",
        riffle: "72h",
        riffleEnteredAt: NOW - 10 * HOUR,
        queuedAt: NOW - 5 * HOUR,
      }),
      makeItem({
        id: "a-newer",
        riffle: "72h",
        riffleEnteredAt: NOW - 10 * HOUR,
        queuedAt: NOW - 5 * HOUR,
      }),
      // 1w TTL, riffleEnteredAt NOW - 106h: remaining also 62h, but queued earlier
      makeItem({
        id: "older",
        riffle: "1w",
        riffleEnteredAt: NOW - 106 * HOUR,
        queuedAt: NOW - 50 * HOUR,
      }),
    ];
    const view = launcherView(baseInput({ items }));
    expect(view.queue.map((i) => i.id)).toEqual(["older", "a-newer", "b-newer"]);
  });

  test("each entry carries its riffle alongside the usual item view fields", () => {
    const item = makeItem({ id: "i1", riffle: "1mo", bucketId: "b-dagger" });
    const view = launcherView(baseInput({ items: [item] }));
    expect(view.queue[0]?.riffle).toBe("1mo");
    expect(view.queue[0]?.bucketName).toBe("Dagger");
    expect(view.queue[0]?.dueLabel).not.toBe("");
  });
});

describe("launcherView: Stale entry and view", () => {
  test("the switcher lists the real buckets by order, then a Stale entry with the Stale item count", () => {
    const items = [
      makeItem({ id: "s1", bucketId: "b-dagger", riffle: "stale" }),
      makeItem({ id: "s2", bucketId: "b-personal", riffle: "stale" }),
      makeItem({ id: "timed", bucketId: "b-dagger", riffle: "72h" }),
    ];
    const view = launcherView(baseInput({ items }));
    expect(view.switcher.map((e) => e.id)).toEqual(["b-dagger", "b-personal", "b-side", STALE_SELECTION_ID]);
    const staleEntry = view.switcher[view.switcher.length - 1]!;
    expect(staleEntry.isStale).toBe(true);
    expect(staleEntry.count).toBe(2);
  });

  test("selecting the Stale entry is reflected in staleSelected and the switcher's selection", () => {
    const view = launcherView(baseInput({ selectedBucketId: STALE_SELECTION_ID }));
    expect(view.staleSelected).toBe(true);
    expect(view.switcher.every((e) => (e.isStale ? e.selected : !e.selected))).toBe(true);
  });

  test("staleItems lists every Stale item from every bucket, each with its bucket name", () => {
    const items = [
      makeItem({ id: "from-dagger", bucketId: "b-dagger", riffle: "stale", riffleEnteredAt: NOW - 10 * HOUR }),
      makeItem({ id: "from-personal", bucketId: "b-personal", riffle: "stale", riffleEnteredAt: NOW - 5 * HOUR }),
    ];
    const view = launcherView(baseInput({ items, selectedBucketId: "b-dagger" }));
    expect(view.staleItems.map((i) => i.id)).toEqual(["from-personal", "from-dagger"]);
    expect(view.staleItems.map((i) => i.bucketName)).toEqual(["Personal", "Dagger"]);
  });

  test("staleItems orders by riffleEnteredAt descending, ties by queuedAt ascending then id", () => {
    const items = [
      makeItem({ id: "oldest", riffle: "stale", riffleEnteredAt: NOW - 100 * HOUR }),
      makeItem({ id: "newest", riffle: "stale", riffleEnteredAt: NOW - 1 * HOUR }),
      makeItem({
        id: "tie-b",
        riffle: "stale",
        riffleEnteredAt: NOW - 50 * HOUR,
        queuedAt: NOW - 5 * HOUR,
      }),
      makeItem({
        id: "tie-a",
        riffle: "stale",
        riffleEnteredAt: NOW - 50 * HOUR,
        queuedAt: NOW - 5 * HOUR,
      }),
    ];
    const view = launcherView(baseInput({ items }));
    expect(view.staleItems.map((i) => i.id)).toEqual(["newest", "tie-a", "tie-b", "oldest"]);
  });

  test("no Stale item ever appears in a bucket's queue, selected or not", () => {
    const items = [
      makeItem({ id: "stale-item", bucketId: "b-dagger", riffle: "stale" }),
      makeItem({ id: "timed-item", bucketId: "b-dagger", riffle: "72h" }),
    ];
    const view = launcherView(baseInput({ items, selectedBucketId: "b-dagger" }));
    expect(view.queue.map((i) => i.id)).toEqual(["timed-item"]);
  });
});

describe("launcherView: searchResults", () => {
  test("spans every bucket and riffle, timed items first by soonest due, then Stale newest first", () => {
    const items = [
      makeItem({
        id: "timed-later",
        bucketId: "b-personal",
        riffle: "1mo",
        title: "widget later",
        riffleEnteredAt: NOW - 1 * DAY,
      }), // remaining ~29d
      makeItem({
        id: "timed-soon",
        bucketId: "b-dagger",
        riffle: "24h",
        title: "widget soon",
        riffleEnteredAt: NOW - 20 * HOUR,
      }), // remaining 4h
      makeItem({
        id: "stale-newer",
        bucketId: "b-side",
        riffle: "stale",
        title: "widget stale newer",
        riffleEnteredAt: NOW - 1 * HOUR,
      }),
      makeItem({
        id: "stale-older",
        bucketId: "b-dagger",
        riffle: "stale",
        title: "widget stale older",
        riffleEnteredAt: NOW - 50 * HOUR,
      }),
      makeItem({ id: "no-match", bucketId: "b-dagger", riffle: "72h", title: "unrelated" }),
    ];
    const view = launcherView(baseInput({ items, query: "widget" }));
    expect(view.searchResults.map((i) => i.id)).toEqual([
      "timed-soon",
      "timed-later",
      "stale-newer",
      "stale-older",
    ]);
    expect(view.searchResults.map((i) => i.bucketName)).toEqual(["Dagger", "Personal", "Side projects", "Dagger"]);
  });

  test("is empty for a blank or whitespace-only query", () => {
    const items = [makeItem({ id: "i1" })];
    expect(launcherView(baseInput({ items, query: "" })).searchResults).toEqual([]);
    expect(launcherView(baseInput({ items, query: "   " })).searchResults).toEqual([]);
  });

  test("matches title or url case-insensitively, across every bucket", () => {
    const items = [
      makeItem({ id: "title-match", bucketId: "b-dagger", title: "Read about Widgets", url: "https://a.example/x" }),
      makeItem({ id: "url-match", bucketId: "b-personal", title: "Something else", url: "https://widgets.example/y" }),
      makeItem({ id: "no-match", bucketId: "b-side", title: "Unrelated", url: "https://other.example/z" }),
    ];
    const view = launcherView(baseInput({ items, query: "WIDGET" }));
    expect(view.searchResults.map((i) => i.id).sort()).toEqual(["title-match", "url-match"]);
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

  test("the old column-navigation keys are unbound, since there are no columns left", () => {
    expect(keyAction("ArrowRight", false)).toBeNull();
    expect(keyAction("l", false)).toBeNull();
    expect(keyAction("ArrowLeft", false)).toBeNull();
    expect(keyAction("h", false)).toBeNull();
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

describe("recentlyClosedPanelView", () => {
  const entries = [
    makeClosedTab({ id: "a", url: "https://a.example/1" }),
    makeClosedTab({ id: "b", url: "https://b.example/2" }),
  ];

  test("collapsed: no entries are handed to the renderer, but the count is still available", () => {
    const panel = recentlyClosedPanelView(entries, false);
    expect(panel.entries).toEqual([]);
    expect(panel.count).toBe(2);
  });

  test("expanded: every entry passes through unchanged, in order", () => {
    const panel = recentlyClosedPanelView(entries, true);
    expect(panel.entries).toBe(entries);
    expect(panel.count).toBe(2);
  });

  test("count reflects zero entries whether collapsed or expanded", () => {
    expect(recentlyClosedPanelView([], false)).toEqual({ count: 0, entries: [] });
    expect(recentlyClosedPanelView([], true)).toEqual({ count: 0, entries: [] });
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

  test("riffles is the enqueue ladder, without Stale", () => {
    const view = triageView({
      tabs: [],
      trackedTabs: [],
      items: [],
      buckets,
      lastBucketId: null,
      selfTabId: null,
    });
    expect(view.riffles).toEqual(["24h", "72h", "1w", "1mo"]);
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
  const item = view.searchResults[0]!;
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
