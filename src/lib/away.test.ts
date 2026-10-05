import { describe, expect, test } from "vitest";
import { AWAY_GAP_THRESHOLD, detectAwayGap, itemsFreedByGap } from "./away";
import { HOUR } from "./model";
import type { Item, Pause } from "./model";

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

describe("detectAwayGap", () => {
  test("returns null at exactly the threshold", () => {
    const lastActiveAt = NOW - AWAY_GAP_THRESHOLD;
    expect(detectAwayGap(lastActiveAt, NOW, [])).toBeNull();
  });

  test("returns a gap just past the threshold", () => {
    const lastActiveAt = NOW - AWAY_GAP_THRESHOLD - 1;
    expect(detectAwayGap(lastActiveAt, NOW, [])).toEqual({ start: lastActiveAt, end: NOW });
  });

  test("returns null when lastActiveAt is null", () => {
    expect(detectAwayGap(null, NOW, [])).toBeNull();
  });

  test("returns null when a single closed pause fully covers the gap", () => {
    const lastActiveAt = NOW - AWAY_GAP_THRESHOLD - HOUR;
    const pause = makePause({ id: "p1", start: lastActiveAt, end: NOW });
    expect(detectAwayGap(lastActiveAt, NOW, [pause])).toBeNull();
  });

  test("returns null when touching pauses merge to fully cover the gap", () => {
    const lastActiveAt = NOW - AWAY_GAP_THRESHOLD - HOUR;
    const mid = lastActiveAt + 10 * HOUR;
    const pauses = [
      makePause({ id: "p1", start: lastActiveAt, end: mid }),
      makePause({ id: "p2", start: mid, end: NOW }),
    ];
    expect(detectAwayGap(lastActiveAt, NOW, pauses)).toBeNull();
  });

  test("returns null when a running pause started before the gap covers it up to now", () => {
    const lastActiveAt = NOW - AWAY_GAP_THRESHOLD - HOUR;
    const pause = makePause({ id: "p1", start: lastActiveAt - HOUR, end: null });
    expect(detectAwayGap(lastActiveAt, NOW, [pause])).toBeNull();
  });

  test("still offers a gap only partially covered by a pause", () => {
    const lastActiveAt = NOW - AWAY_GAP_THRESHOLD - HOUR;
    const pause = makePause({ id: "p1", start: lastActiveAt, end: lastActiveAt + HOUR });
    expect(detectAwayGap(lastActiveAt, NOW, [pause])).toEqual({ start: lastActiveAt, end: NOW });
  });
});

describe("itemsFreedByGap", () => {
  const gap = { start: NOW - 10 * HOUR, end: NOW };

  test("counts an item that went overdue inside the gap", () => {
    const item = makeItem({ riffle: "24h", riffleEnteredAt: NOW - 30 * HOUR });
    expect(itemsFreedByGap([item], [], gap, NOW)).toBe(1);
  });

  test("doesn't count an item still overdue even with the gap paused", () => {
    const item = makeItem({ riffle: "24h", riffleEnteredAt: NOW - 100 * HOUR });
    expect(itemsFreedByGap([item], [], gap, NOW)).toBe(0);
  });

  test("doesn't count an item that isn't overdue", () => {
    const item = makeItem({ riffle: "1mo", riffleEnteredAt: NOW - HOUR });
    expect(itemsFreedByGap([item], [], gap, NOW)).toBe(0);
  });

  test("never counts a Stale item", () => {
    const item = makeItem({ riffle: "stale", riffleEnteredAt: NOW - 1000 * HOUR });
    expect(itemsFreedByGap([item], [], gap, NOW)).toBe(0);
  });
});
