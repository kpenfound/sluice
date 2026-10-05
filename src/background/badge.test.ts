import { describe, expect, test } from "vitest";
import { badgeText } from "./badge";
import { HOUR } from "../lib/model";
import type { Bucket, Item, Pause } from "../lib/model";

const NOW = 1_700_000_000_000;

const BUCKETS: Bucket[] = [
  { id: "bucket-1", name: "Dagger", order: 0 },
  { id: "bucket-2", name: "Personal", order: 1 },
];

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

describe("badgeText", () => {
  test("is empty with no items", () => {
    expect(badgeText(BUCKETS, [], [], NOW)).toBe("");
  });

  test("totals overdue items across several buckets as a decimal string", () => {
    const items: Item[] = [
      makeItem({ id: "a", bucketId: "bucket-1", riffleEnteredAt: NOW - 24 * HOUR }),
      makeItem({ id: "b", bucketId: "bucket-2", riffleEnteredAt: NOW - 25 * HOUR }),
      makeItem({ id: "c", bucketId: "bucket-2", riffleEnteredAt: NOW - 1 * HOUR }),
    ];
    expect(badgeText(BUCKETS, items, [], NOW)).toBe("2");
  });

  test("an item with remaining === 0 counts as overdue", () => {
    const items = [makeItem({ riffleEnteredAt: NOW - 24 * HOUR })];
    expect(badgeText(BUCKETS, items, [], NOW)).toBe("1");
  });

  test("an item with remaining === 1 does not count as overdue", () => {
    const items = [makeItem({ riffleEnteredAt: NOW - 24 * HOUR + 1 })];
    expect(badgeText(BUCKETS, items, [], NOW)).toBe("");
  });

  test("a running pause shows the pause symbol even with overdue items", () => {
    const items = [makeItem({ riffleEnteredAt: NOW - 24 * HOUR })];
    const pauses = [makePause({ start: NOW - 1 * HOUR, end: null })];
    expect(badgeText(BUCKETS, items, pauses, NOW)).toBe("⏸");
  });

  test("a pause whose end has passed no longer hides the count", () => {
    const items = [makeItem({ riffleEnteredAt: NOW - 25 * HOUR })];
    const pauses = [makePause({ start: NOW - 2 * HOUR, end: NOW - 1 * HOUR })];
    expect(badgeText(BUCKETS, items, pauses, NOW)).toBe("1");
  });

  test("a scheduled pause shows the count before its start and the symbol after", () => {
    const items = [makeItem({ riffleEnteredAt: NOW - 24 * HOUR })];
    const pauses = [makePause({ start: NOW + 1 * HOUR, end: null })];
    expect(badgeText(BUCKETS, items, pauses, NOW)).toBe("1");
    expect(badgeText(BUCKETS, items, pauses, NOW + 1 * HOUR)).toBe("⏸");
  });
});
