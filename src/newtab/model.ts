import type { AwayGap } from "../lib/away";
import { itemsFreedByGap } from "../lib/away";
import { isOverdue, overdueCounts, remaining, timeInRiffle, totalAge } from "../lib/due";
import type { Bucket, Item, Pause, RiffleId } from "../lib/model";
import { DAY, HOUR, RIFFLES } from "../lib/model";
import { runningPause } from "../lib/pauses";

/** One entry in the bucket switcher: a bucket's name, its overdue count and whether it's the one being shown. */
export interface BucketSwitcherEntry {
  id: string;
  name: string;
  overdueCount: number;
  selected: boolean;
}

/** One item as the launcher displays it, independent of which column it's drawn into. */
export interface ItemView {
  id: string;
  url: string;
  title: string;
  favIconUrl: string | undefined;
  domain: string;
  timeInRiffle: number;
  totalAge: number;
  remaining: number | null;
  overdue: boolean;
  bucketName: string;
}

/** One riffle column, with its items already ordered per the column ordering rules. */
export interface Column {
  riffle: RiffleId;
  items: ItemView[];
}

/** The running pause's start, shown in the pause banner. */
export interface PauseBanner {
  start: number;
}

/** The pending away gap's range and how many items it would free from being overdue. */
export interface AwayGapBanner {
  start: number;
  end: number;
  freed: number;
}

export interface LauncherViewInput {
  buckets: Bucket[];
  items: Item[];
  pauses: Pause[];
  awayGap: AwayGap | null;
  selectedBucketId: string | null;
  query: string;
  now: number;
}

export interface LauncherView {
  buckets: BucketSwitcherEntry[];
  selectedBucketId: string;
  columns: Column[];
  staleExpanded: boolean;
  pauseBanner: PauseBanner | null;
  awayGapBanner: AwayGapBanner | null;
  actionsEnabled: boolean;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function toItemView(item: Item, bucketName: string, pauses: Pause[], now: number): ItemView {
  return {
    id: item.id,
    url: item.url,
    title: item.title,
    favIconUrl: item.favIconUrl,
    domain: domainOf(item.url),
    timeInRiffle: timeInRiffle(item, now),
    totalAge: totalAge(item, now),
    remaining: remaining(item, pauses, now),
    overdue: isOverdue(item, pauses, now),
    bucketName,
  };
}

function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Orders a column's entries: non-Stale riffles by ascending `remaining` (which puts overdue
 * items, with `remaining <= 0`, first and most-overdue-first automatically), Stale by
 * `riffleEnteredAt` descending; ties break by `queuedAt` ascending then `id`.
 */
function sortColumn(riffle: RiffleId, entries: { item: Item; view: ItemView }[]): ItemView[] {
  const sorted = [...entries].sort((a, b) => {
    if (riffle === "stale") {
      if (a.item.riffleEnteredAt !== b.item.riffleEnteredAt) {
        return b.item.riffleEnteredAt - a.item.riffleEnteredAt;
      }
    } else {
      const ar = a.view.remaining as number;
      const br = b.view.remaining as number;
      if (ar !== br) return ar - br;
    }
    if (a.item.queuedAt !== b.item.queuedAt) return a.item.queuedAt - b.item.queuedAt;
    return compareIds(a.item.id, b.item.id);
  });
  return sorted.map((e) => e.view);
}

function matchesQuery(item: Item, needle: string): boolean {
  return item.title.toLowerCase().includes(needle) || item.url.toLowerCase().includes(needle);
}

/**
 * The launcher's full view: the bucket switcher, the five ladder columns for the effective
 * selected bucket (or, with an active search, matches across every bucket), the pause and
 * away-gap banners, and whether item actions are currently allowed.
 */
export function launcherView(input: LauncherViewInput): LauncherView {
  const { buckets, items, pauses, awayGap, selectedBucketId, query, now } = input;

  const bucketsByOrder = [...buckets].sort((a, b) => a.order - b.order);
  const counts = overdueCounts(buckets, items, pauses, now);

  const effectiveSelectedBucketId =
    selectedBucketId !== null && buckets.some((b) => b.id === selectedBucketId)
      ? selectedBucketId
      : (bucketsByOrder[0]?.id ?? "");

  const bucketSwitcher: BucketSwitcherEntry[] = bucketsByOrder.map((bucket) => ({
    id: bucket.id,
    name: bucket.name,
    overdueCount: counts.byBucket[bucket.id] ?? 0,
    selected: bucket.id === effectiveSelectedBucketId,
  }));

  const bucketNameById = new Map(buckets.map((b) => [b.id, b.name]));
  const trimmedQuery = query.trim().toLowerCase();
  const searching = trimmedQuery !== "";

  const matching = searching
    ? items.filter((item) => matchesQuery(item, trimmedQuery))
    : items.filter((item) => item.bucketId === effectiveSelectedBucketId);

  const byRiffle = new Map<RiffleId, { item: Item; view: ItemView }[]>();
  for (const riffle of RIFFLES) byRiffle.set(riffle, []);
  for (const item of matching) {
    const bucketName = bucketNameById.get(item.bucketId) ?? "";
    const view = toItemView(item, bucketName, pauses, now);
    byRiffle.get(item.riffle)?.push({ item, view });
  }

  const columns: Column[] = RIFFLES.map((riffle) => ({
    riffle,
    items: sortColumn(riffle, byRiffle.get(riffle) ?? []),
  }));

  const running = runningPause(pauses, now);
  const pauseBanner: PauseBanner | null = running !== undefined ? { start: running.start } : null;

  const awayGapBanner: AwayGapBanner | null =
    awayGap !== null
      ? { start: awayGap.start, end: awayGap.end, freed: itemsFreedByGap(items, pauses, awayGap, now) }
      : null;

  return {
    buckets: bucketSwitcher,
    selectedBucketId: effectiveSelectedBucketId,
    columns,
    staleExpanded: searching,
    pauseBanner,
    awayGapBanner,
    actionsEnabled: awayGap === null,
  };
}

/** A short human label for a duration: minutes under an hour, hours under a day, days otherwise. */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < HOUR) return `${Math.round(abs / (60 * 1000))}m`;
  if (abs < DAY) return `${Math.round(abs / HOUR)}h`;
  return `${Math.round(abs / DAY)}d`;
}

/** "due in X" for a positive `remaining`, "overdue by X" at or past the boundary, "" for Stale's null. */
export function dueLabel(remaining: number | null): string {
  if (remaining === null) return "";
  if (remaining <= 0) return `overdue by ${formatDuration(remaining)}`;
  return `due in ${formatDuration(remaining)}`;
}

export type KeyAction =
  | "nextItem"
  | "prevItem"
  | "nextColumn"
  | "prevColumn"
  | "open"
  | "defer"
  | "move"
  | "changeBucket"
  | "resolve"
  | "focusSearch"
  | "prevBucket"
  | "nextBucket"
  | "clearSearch";

const KEY_ACTIONS: Record<string, KeyAction> = {
  ArrowDown: "nextItem",
  j: "nextItem",
  ArrowUp: "prevItem",
  k: "prevItem",
  ArrowRight: "nextColumn",
  l: "nextColumn",
  ArrowLeft: "prevColumn",
  h: "prevColumn",
  Enter: "open",
  o: "open",
  d: "defer",
  m: "move",
  b: "changeBucket",
  x: "resolve",
  Delete: "resolve",
  "/": "focusSearch",
  "[": "prevBucket",
  "]": "nextBucket",
  Escape: "clearSearch",
};

/** The keymap's action for `key`, or null when it has none. Every key but Escape is ignored while focus is in a text input. */
export function keyAction(key: string, inTextInput: boolean): KeyAction | null {
  if (inTextInput) return key === "Escape" ? "clearSearch" : null;
  return KEY_ACTIONS[key] ?? null;
}
