import { describe, expect, test } from "vitest";
import type { AwayGap } from "../lib/away";
import { HOUR } from "../lib/model";
import type { Bucket, Item, Pause } from "../lib/model";
import { dueLabel, formatDuration, keyAction, launcherView } from "./model";
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
    expect(column?.items.map((i) => i.id).sort()).toEqual(["title-match", "url-match"]);
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
