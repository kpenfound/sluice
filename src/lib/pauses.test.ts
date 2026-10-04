import { describe, expect, test } from "vitest";
import { remaining } from "./due";
import { HOUR, DAY } from "./model";
import type { Item, Pause } from "./model";
import { mergePauses, prunablePauses, prunePauses, runningPause, validatePause } from "./pauses";

const NOW = 1_700_000_000_000;

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

function makePause(overrides: Partial<Pause> & { id: string; start: number }): Pause {
  return { end: null, ...overrides };
}

describe("validatePause", () => {
  test("rejects a non-null end equal to start", () => {
    expect(validatePause(makePause({ id: "p1", start: NOW, end: NOW }))).toBe(false);
  });

  test("rejects a non-null end before start", () => {
    expect(validatePause(makePause({ id: "p1", start: NOW, end: NOW - HOUR }))).toBe(false);
  });

  test("accepts a non-null end after start", () => {
    expect(validatePause(makePause({ id: "p1", start: NOW, end: NOW + HOUR }))).toBe(true);
  });

  test("accepts a null end", () => {
    expect(validatePause(makePause({ id: "p1", start: NOW, end: null }))).toBe(true);
  });
});

describe("mergePauses", () => {
  test("merges overlapping ranges", () => {
    const merged = mergePauses([
      { id: "p1", start: 0, end: 100 },
      { id: "p2", start: 50, end: 150 },
    ]);
    expect(merged).toEqual([{ id: "p1", start: 0, end: 150, label: undefined }]);
  });

  test("merges touching ranges, where one range's end equals the next one's start", () => {
    const merged = mergePauses([
      { id: "p1", start: 0, end: 50 },
      { id: "p2", start: 50, end: 100 },
    ]);
    expect(merged).toEqual([{ id: "p1", start: 0, end: 100, label: undefined }]);
  });

  test("merges a range contained entirely inside another", () => {
    const merged = mergePauses([
      { id: "p1", start: 0, end: 100 },
      { id: "p2", start: 20, end: 30 },
    ]);
    expect(merged).toEqual([{ id: "p1", start: 0, end: 100, label: undefined }]);
  });

  test("leaves disjoint ranges separate", () => {
    const merged = mergePauses([
      { id: "p1", start: 0, end: 10 },
      { id: "p2", start: 50, end: 60 },
    ]);
    expect(merged).toEqual([
      { id: "p1", start: 0, end: 10, label: undefined },
      { id: "p2", start: 50, end: 60, label: undefined },
    ]);
  });

  test("an open-ended pause absorbs a later scheduled pause", () => {
    const merged = mergePauses([
      { id: "p1", start: 0, end: null },
      { id: "p2", start: 100, end: 200 },
    ]);
    expect(merged).toEqual([{ id: "p1", start: 0, end: null, label: undefined }]);
  });

  test("sorts the output by start regardless of input order", () => {
    const merged = mergePauses([
      { id: "p2", start: 50, end: 60 },
      { id: "p1", start: 0, end: 10 },
    ]);
    expect(merged.map((p) => p.start)).toEqual([0, 50]);
  });

  test("a merged pause keeps the earliest member's id and start, and the latest end", () => {
    const merged = mergePauses([
      { id: "p1", start: 0, end: 10 },
      { id: "p2", start: 10, end: 20 },
      { id: "p3", start: 15, end: 50 },
    ]);
    expect(merged).toEqual([{ id: "p1", start: 0, end: 50, label: undefined }]);
  });

  test("a merged pause's end is null when any member is open-ended", () => {
    const merged = mergePauses([
      { id: "p1", start: 0, end: 10 },
      { id: "p2", start: 5, end: null },
      { id: "p3", start: 8, end: 12 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.end).toBeNull();
  });

  test("a merged pause takes the first defined label in start order", () => {
    const merged = mergePauses([
      { id: "p1", start: 0, end: 50, label: undefined },
      { id: "p2", start: 40, end: 80, label: "Lunch" },
      { id: "p3", start: 70, end: 100, label: "Other" },
    ]);
    expect(merged).toEqual([{ id: "p1", start: 0, end: 100, label: "Lunch" }]);
  });
});

describe("runningPause", () => {
  test("returns an open-ended pause whose start is in the past", () => {
    const pause = makePause({ id: "p1", start: NOW - HOUR, end: null });
    expect(runningPause([pause], NOW)).toBe(pause);
  });

  test("returns a pause with a future end", () => {
    const pause = makePause({ id: "p1", start: NOW - HOUR, end: NOW + HOUR });
    expect(runningPause([pause], NOW)).toBe(pause);
  });

  test("ignores an already-ended pause", () => {
    const pause = makePause({ id: "p1", start: NOW - 2 * HOUR, end: NOW - HOUR });
    expect(runningPause([pause], NOW)).toBeUndefined();
  });

  test("ignores a pause scheduled to start in the future", () => {
    const pause = makePause({ id: "p1", start: NOW + HOUR, end: NOW + 2 * HOUR });
    expect(runningPause([pause], NOW)).toBeUndefined();
  });
});

describe("pruning", () => {
  test("removes a pause that ended before every non-stale item's anchor", () => {
    const items = [makeItem({ riffleEnteredAt: NOW - HOUR })];
    const pause = makePause({ id: "p1", start: NOW - 3 * HOUR, end: NOW - 2 * HOUR });
    expect(prunablePauses([pause], items, NOW)).toEqual([pause]);
    expect(prunePauses([pause], items, NOW)).toEqual([]);
  });

  test("keeps a pause that ends after some non-stale item's anchor", () => {
    const items = [makeItem({ riffleEnteredAt: NOW - HOUR })];
    const pause = makePause({ id: "p1", start: NOW - HOUR, end: NOW - 30 * 60 * 1000 });
    expect(prunablePauses([pause], items, NOW)).toEqual([]);
    expect(prunePauses([pause], items, NOW)).toEqual([pause]);
  });

  test("ignores stale items' anchors when computing the oldest anchor", () => {
    const items = [
      makeItem({ id: "stale-1", riffle: "stale", riffleEnteredAt: NOW - 1000 * DAY }),
      makeItem({ id: "fresh-1", riffle: "24h", riffleEnteredAt: NOW - HOUR }),
    ];
    // Ends after the stale item's ancient anchor but before the non-stale item's anchor:
    // prunable only if the stale anchor is correctly ignored.
    const pause = makePause({ id: "p1", start: NOW - 13 * HOUR, end: NOW - 12 * HOUR });
    expect(prunablePauses([pause], items, NOW)).toEqual([pause]);
  });

  test("every ended pause is prunable when there are no non-stale items", () => {
    const items = [makeItem({ id: "stale-1", riffle: "stale", riffleEnteredAt: NOW - 1000 * DAY })];
    const farPast = makePause({ id: "p1", start: NOW - 1000 * DAY, end: NOW - 999 * DAY });
    const recentPast = makePause({ id: "p2", start: NOW - 2 * HOUR, end: NOW - HOUR });
    expect(prunablePauses([farPast, recentPast], items, NOW)).toEqual([farPast, recentPast]);
    expect(prunePauses([farPast, recentPast], items, NOW)).toEqual([]);
  });

  test("never prunes a running pause, even with no non-stale items", () => {
    const items: Item[] = [];
    const running = makePause({ id: "p1", start: NOW - HOUR, end: null });
    expect(prunablePauses([running], items, NOW)).toEqual([]);
    expect(prunePauses([running], items, NOW)).toEqual([running]);
  });

  test("never prunes a scheduled pause", () => {
    const items: Item[] = [];
    const scheduled = makePause({ id: "p1", start: NOW + HOUR, end: NOW + 2 * HOUR });
    expect(prunablePauses([scheduled], items, NOW)).toEqual([]);
    expect(prunePauses([scheduled], items, NOW)).toEqual([scheduled]);
  });

  test("pruning never changes remaining() for any item", () => {
    const items = [
      makeItem({ id: "a", riffle: "24h", riffleEnteredAt: NOW - 20 * HOUR }),
      makeItem({ id: "b", riffle: "72h", riffleEnteredAt: NOW - 10 * HOUR, lastVisitedAt: NOW - 2 * HOUR }),
      makeItem({ id: "c", riffle: "stale", riffleEnteredAt: NOW - 1000 * DAY }),
    ];
    const pauses = [
      makePause({ id: "p1", start: NOW - 1000 * DAY, end: NOW - 999 * DAY }),
      makePause({ id: "p2", start: NOW - 5 * HOUR, end: NOW - 4 * HOUR }),
      makePause({ id: "p3", start: NOW - HOUR, end: null }),
    ];

    const before = items.map((item) => remaining(item, pauses, NOW));
    const pruned = prunePauses(pauses, items, NOW);
    const after = items.map((item) => remaining(item, pruned, NOW));

    expect(after).toEqual(before);
  });
});
