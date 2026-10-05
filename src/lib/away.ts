import { isOverdue } from "./due";
import { HOUR } from "./model";
import type { Item, Pause } from "./model";
import { mergePauses } from "./pauses";

/** Firefox closed for longer than this makes a gap worth offering to pause (Open question 5). */
export const AWAY_GAP_THRESHOLD = 72 * HOUR;

/** A candidate range to offer as a pause, from the last recorded activity to now. */
export interface AwayGap {
  start: number;
  end: number;
}

/** Whether `pauses` (closed ranges, plus a running pause counted up to `end`) already cover all of `[start, end]`. */
function isFullyCovered(pauses: Pause[], start: number, end: number): boolean {
  const merged = mergePauses(pauses);
  let cursor = start;

  for (const p of merged) {
    const s = Math.max(p.start, start);
    const e = Math.min(p.end ?? end, end);
    if (e <= s) continue;
    if (s > cursor) return false;
    cursor = Math.max(cursor, e);
  }

  return cursor >= end;
}

/**
 * Offers a pause for the gap since `lastActiveAt` when it is non-null, longer than
 * `AWAY_GAP_THRESHOLD`, and not already fully covered by `pauses`. Otherwise null.
 */
export function detectAwayGap(lastActiveAt: number | null, now: number, pauses: Pause[]): AwayGap | null {
  if (lastActiveAt === null) return null;
  if (now - lastActiveAt <= AWAY_GAP_THRESHOLD) return null;
  if (isFullyCovered(pauses, lastActiveAt, now)) return null;
  return { start: lastActiveAt, end: now };
}

/** The number of items overdue now under `pauses` that would not be overdue with `gap` also paused. Stale items never count. */
export function itemsFreedByGap(items: Item[], pauses: Pause[], gap: AwayGap, now: number): number {
  const withGap = mergePauses([...pauses, { id: "away-gap", start: gap.start, end: gap.end }]);
  let freed = 0;

  for (const item of items) {
    if (isOverdue(item, pauses, now) && !isOverdue(item, withGap, now)) freed++;
  }

  return freed;
}
