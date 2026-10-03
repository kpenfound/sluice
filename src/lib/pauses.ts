import { anchor } from "./due";
import type { Item, Pause } from "./model";

/** False when `end` is non-null and `end <= start`; every other pause, including an open-ended one, is valid. */
export function validatePause(p: Pause): boolean {
  return p.end === null || p.end > p.start;
}

/** Sorts pauses by start and merges overlapping or touching ranges, including an open-ended pause absorbing any later-starting one. */
export function mergePauses(pauses: Pause[]): Pause[] {
  const sorted = [...pauses].sort((a, b) => a.start - b.start);
  const merged: Pause[] = [];

  for (const p of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && (last.end === null || p.start <= last.end)) {
      last.end = last.end === null || p.end === null ? null : Math.max(last.end, p.end);
      if (last.label === undefined) last.label = p.label;
    } else {
      merged.push({ ...p });
    }
  }

  return merged;
}

/** The pause with `start <= now` and (`end === null` or `end > now`), or undefined when none is running. */
export function runningPause(pauses: Pause[], now: number): Pause | undefined {
  return pauses.find((p) => p.start <= now && (p.end === null || p.end > now));
}

/** Pauses that can no longer affect any item: ended, `end <= now`, and `end` at or before the oldest anchor among non-"stale" items (every ended pause when there are none). */
export function prunablePauses(pauses: Pause[], items: Item[], now: number): Pause[] {
  const nonStaleAnchors = items.filter((item) => item.riffle !== "stale").map(anchor);
  const oldestAnchor = nonStaleAnchors.length > 0 ? Math.min(...nonStaleAnchors) : Infinity;

  return pauses.filter((p) => p.end !== null && p.end <= now && p.end <= oldestAnchor);
}

/** `pauses` with every pause selected by `prunablePauses` removed. */
export function prunePauses(pauses: Pause[], items: Item[], now: number): Pause[] {
  const prunable = new Set(prunablePauses(pauses, items, now).map((p) => p.id));
  return pauses.filter((p) => !prunable.has(p.id));
}
