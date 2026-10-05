import { overdueCounts } from "../lib/due";
import type { Bucket, Item, Pause } from "../lib/model";
import { runningPause } from "../lib/pauses";

/**
 * The toolbar badge text: the pause symbol while a pause is running, otherwise the
 * total overdue count as a decimal string, or "" when nothing is overdue.
 */
export function badgeText(buckets: Bucket[], items: Item[], pauses: Pause[], now: number): string {
  if (runningPause(pauses, now) !== undefined) return "⏸";
  const { total } = overdueCounts(buckets, items, pauses, now);
  return total === 0 ? "" : String(total);
}
