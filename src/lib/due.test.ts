import { describe, expect, test } from "vitest";
import { anchor, isOverdue, overdueCounts, remaining, timeInRiffle, totalAge } from "./due";
import { HOUR, DAY } from "./model";
import type { Bucket, Item, Pause } from "./model";

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

function makePause(overrides: Partial<Pause> & { start: number }): Pause {
  return { id: "pause-1", end: null, ...overrides };
}

describe("anchor", () => {
  test("uses lastVisitedAt when it's later than riffleEnteredAt", () => {
    const item = makeItem({ riffleEnteredAt: NOW - 100 * HOUR, lastVisitedAt: NOW - 10 * HOUR });
    expect(anchor(item)).toBe(NOW - 10 * HOUR);
  });

  test("uses riffleEnteredAt when it's later than lastVisitedAt", () => {
    const item = makeItem({ riffleEnteredAt: NOW - 10 * HOUR, lastVisitedAt: NOW - 100 * HOUR });
    expect(anchor(item)).toBe(NOW - 10 * HOUR);
  });

  test("uses riffleEnteredAt when there's no visit yet", () => {
    const item = makeItem({ riffleEnteredAt: NOW - 10 * HOUR, lastVisitedAt: null });
    expect(anchor(item)).toBe(NOW - 10 * HOUR);
  });
});

describe("remaining", () => {
  test("with no pauses, counts the full wall-clock time since the anchor", () => {
    const item = makeItem({ riffleEnteredAt: NOW - 1 * HOUR });
    expect(remaining(item, [], NOW)).toBe(23 * HOUR);
  });

  test("a running pause counts up to now", () => {
    const item = makeItem({ riffleEnteredAt: NOW - 5 * HOUR });
    const pauses = [makePause({ start: NOW - 3 * HOUR, end: null })];
    // 5h elapsed, 3h of it paused (running pause counts up to now) -> 2h active -> 22h remaining.
    expect(remaining(item, pauses, NOW)).toBe(22 * HOUR);
  });

  test("a closed past pause subtracts only its own range", () => {
    const item = makeItem({ riffleEnteredAt: NOW - 10 * HOUR });
    const pauses = [makePause({ start: NOW - 8 * HOUR, end: NOW - 6 * HOUR })];
    // 10h elapsed, 2h paused -> 8h active -> 16h remaining.
    expect(remaining(item, pauses, NOW)).toBe(16 * HOUR);
  });

  test("a retroactive pause saved after the item went overdue clears the overdue state", () => {
    const item = makeItem({ riffleEnteredAt: NOW - 30 * HOUR });
    expect(isOverdue(item, [], NOW)).toBe(true);

    const pauses = [makePause({ start: NOW - 20 * HOUR, end: NOW - 10 * HOUR })];
    // 30h elapsed, 10h paused -> 20h active -> 4h remaining, no longer overdue.
    expect(remaining(item, pauses, NOW)).toBe(4 * HOUR);
    expect(isOverdue(item, pauses, NOW)).toBe(false);
  });

  test("a scheduled future pause has no effect before its start", () => {
    const item = makeItem({ riffleEnteredAt: NOW - 5 * HOUR });
    const pauses = [makePause({ start: NOW + 2 * HOUR, end: NOW + 4 * HOUR })];
    expect(remaining(item, pauses, NOW)).toBe(remaining(item, [], NOW));
  });

  test("a scheduled pause counts only once now passes its start", () => {
    const item = makeItem({ riffleEnteredAt: NOW - 5 * HOUR });
    const pauses = [makePause({ start: NOW + 2 * HOUR, end: NOW + 4 * HOUR })];
    const later = NOW + 3 * HOUR;
    // 8h elapsed by `later`, 1h of it (since the pause started) paused -> 7h active -> 17h remaining.
    expect(remaining(item, pauses, later)).toBe(17 * HOUR);
    // Without the pause, the same instant would show only 16h remaining.
    expect(remaining(item, [], later)).toBe(16 * HOUR);
  });

  test("an item queued during a running pause keeps the full TTL while the pause runs", () => {
    const queuedAt = NOW - 1 * HOUR;
    const item = makeItem({ queuedAt, riffleEnteredAt: queuedAt });
    const pauses = [makePause({ start: queuedAt - 1 * HOUR, end: null })];
    const later = queuedAt + 2 * HOUR;
    expect(remaining(item, pauses, later)).toBe(24 * HOUR);
  });

  test("an item visited during a past pause only counts time after the pause ends", () => {
    const item = makeItem({
      riffleEnteredAt: NOW - 20 * HOUR,
      lastVisitedAt: NOW - 8 * HOUR,
    });
    const pauses = [makePause({ start: NOW - 10 * HOUR, end: NOW - 6 * HOUR })];
    // anchor is the visit (-8h); only the 6h since the pause ended counts -> 18h remaining.
    expect(remaining(item, pauses, NOW)).toBe(18 * HOUR);
  });

  test("stale items return null, even with a very old anchor", () => {
    const item = makeItem({ riffle: "stale", riffleEnteredAt: NOW - 1000 * DAY });
    expect(remaining(item, [], NOW)).toBeNull();
  });
});

describe("isOverdue", () => {
  test("is overdue when remaining is exactly 0", () => {
    const item = makeItem({ riffleEnteredAt: NOW - 24 * HOUR });
    expect(remaining(item, [], NOW)).toBe(0);
    expect(isOverdue(item, [], NOW)).toBe(true);
  });

  test("is not overdue when remaining is 1", () => {
    const item = makeItem({ riffleEnteredAt: NOW - 24 * HOUR + 1 });
    expect(remaining(item, [], NOW)).toBe(1);
    expect(isOverdue(item, [], NOW)).toBe(false);
  });

  test("stale items are never overdue, even with a very old anchor", () => {
    const item = makeItem({ riffle: "stale", riffleEnteredAt: NOW - 1000 * DAY });
    expect(isOverdue(item, [], NOW)).toBe(false);
  });
});

describe("timeInRiffle and totalAge", () => {
  test("are wall-clock values, unaffected by pauses", () => {
    const item = makeItem({
      queuedAt: NOW - 50 * HOUR,
      riffleEnteredAt: NOW - 5 * HOUR,
    });
    // No pauses parameter exists for either function: pauses can never change their result.
    expect(timeInRiffle(item, NOW)).toBe(5 * HOUR);
    expect(totalAge(item, NOW)).toBe(50 * HOUR);
  });
});

describe("overdueCounts", () => {
  test("includes every bucket, 0 where none are overdue, and a total equal to the sum", () => {
    const buckets: Bucket[] = [
      { id: "b1", name: "One", order: 0 },
      { id: "b2", name: "Two", order: 1 },
      { id: "b3", name: "Three", order: 2 },
    ];
    const overdueItem = (bucketId: string) =>
      makeItem({ id: `${bucketId}-overdue`, bucketId, riffleEnteredAt: NOW - 30 * HOUR });
    const freshItem = (bucketId: string) =>
      makeItem({ id: `${bucketId}-fresh`, bucketId, riffleEnteredAt: NOW - 1 * HOUR });

    const items: Item[] = [
      overdueItem("b1"),
      overdueItem("b1"),
      freshItem("b2"),
      overdueItem("b3"),
    ];

    expect(overdueCounts(buckets, items, [], NOW)).toEqual({
      total: 3,
      byBucket: { b1: 2, b2: 0, b3: 1 },
    });
  });
});
