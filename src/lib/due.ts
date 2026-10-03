import type { Bucket, Item, Pause } from "./model";
import { TTL } from "./model";

/** The point an item's TTL counts from: the later of entering its riffle or its last visit. */
export function anchor(item: Item): number {
  return Math.max(item.riffleEnteredAt, item.lastVisitedAt ?? 0);
}

/** Wall-clock time since the item's anchor, minus overlap with any pause. A running pause (`end === null`) counts up to `now`. */
export function activeElapsed(item: Item, pauses: Pause[], now: number): number {
  const from = anchor(item);
  let paused = 0;
  for (const p of pauses) {
    const s = Math.max(p.start, from);
    const e = Math.min(p.end ?? now, now);
    if (e > s) paused += e - s;
  }
  return now - from - paused;
}

/** Time left before the item's riffle TTL runs out, or null for "stale" items, which have no TTL. */
export function remaining(item: Item, pauses: Pause[], now: number): number | null {
  if (item.riffle === "stale") return null;
  return TTL[item.riffle] - activeElapsed(item, pauses, now);
}

/** An item is overdue once its remaining time runs out. Stale items, with no TTL, are never overdue. */
export function isOverdue(item: Item, pauses: Pause[], now: number): boolean {
  const r = remaining(item, pauses, now);
  return r !== null && r <= 0;
}

/** Wall-clock time in the item's current riffle, unaffected by pauses. */
export function timeInRiffle(item: Item, now: number): number {
  return now - item.riffleEnteredAt;
}

/** Wall-clock time since the item was first queued, unaffected by pauses. */
export function totalAge(item: Item, now: number): number {
  return now - item.queuedAt;
}

/** Overdue item counts per bucket, with every bucket represented, and their total. */
export function overdueCounts(
  buckets: Bucket[],
  items: Item[],
  pauses: Pause[],
  now: number,
): { total: number; byBucket: Record<string, number> } {
  const byBucket: Record<string, number> = {};
  for (const bucket of buckets) byBucket[bucket.id] = 0;

  let total = 0;
  for (const item of items) {
    if (isOverdue(item, pauses, now)) {
      byBucket[item.bucketId] = (byBucket[item.bucketId] ?? 0) + 1;
      total++;
    }
  }

  return { total, byBucket };
}
