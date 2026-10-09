import type { AwayGap } from "../lib/away";
import { itemsFreedByGap } from "../lib/away";
import { isOverdue, overdueCounts, remaining, timeInRiffle, totalAge } from "../lib/due";
import type { ClosedTab, TrackedTab } from "../lib/lifecycle";
import { isClosable, isQueuedUrl, remainingTime } from "../lib/lifecycle";
import type { Bucket, Item, Pause, RiffleId } from "../lib/model";
import { DAY, ENQUEUE_RIFFLES, HOUR } from "../lib/model";
import { runningPause } from "../lib/pauses";
import type { WashTab } from "../lib/wash";
import { tabsToWash, triageTabs } from "../lib/wash";

/** One item as the launcher displays it. */
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
  bucketId: string;
}

/**
 * The selection value that asks for the Stale view instead of a bucket's queue. Kept out of
 * the bucket id space so it never collides with a real bucket id.
 */
export const STALE_SELECTION_ID = "sluice:stale-view";

/** One entry in the single queue, the Stale view or search results: an item plus its riffle and due label. */
export interface QueueEntry extends ItemView {
  riffle: RiffleId;
  dueLabel: string;
}

/** One entry in the bucket row: a real bucket, or the Stale archive entry that always comes last. */
export interface SwitcherEntry {
  id: string;
  name: string;
  /** An overdue count for a bucket entry, or the total Stale item count for the Stale entry. */
  count: number;
  selected: boolean;
  isStale: boolean;
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
  selectedBucketId: string;
  pauseBanner: PauseBanner | null;
  awayGapBanner: AwayGapBanner | null;
  actionsEnabled: boolean;
  /**
   * The bucket row, including the Stale entry after the real buckets. `switcher`'s selected
   * entry reflects whether `selectedBucketId` named a real bucket or `STALE_SELECTION_ID`.
   */
  switcher: SwitcherEntry[];
  /** True when `STALE_SELECTION_ID` is the input's selection. */
  staleSelected: boolean;
  /**
   * The selected bucket's single queue: its 24h/72h/1w/1mo items, soonest due first. Always
   * computed for `selectedBucketId`; render it only when neither Stale nor search is active.
   */
  queue: QueueEntry[];
  /** Every Stale item across every bucket, newest into Stale first. Always computed, regardless of selection. */
  staleItems: QueueEntry[];
  /** Matches across every bucket and riffle: timed items by soonest due, then Stale newest first. Empty with no query. */
  searchResults: QueueEntry[];
}

function domainOf(url: string): string {
  try {
    return isClosable(url) ? new URL(url).hostname : "";
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
    bucketId: item.bucketId,
  };
}

function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function matchesQuery(item: Item, needle: string): boolean {
  return item.title.toLowerCase().includes(needle) || item.url.toLowerCase().includes(needle);
}

function toQueueEntry(item: Item, bucketName: string, pauses: Pause[], now: number): QueueEntry {
  const view = toItemView(item, bucketName, pauses, now);
  return { ...view, riffle: item.riffle, dueLabel: dueLabel(view.remaining) };
}

/** Ascending `remaining`, then `queuedAt` ascending, then id: soonest due first, most overdue first. */
function compareSoonestDue(a: Item, b: Item, aRemaining: number, bRemaining: number): number {
  if (aRemaining !== bRemaining) return aRemaining - bRemaining;
  if (a.queuedAt !== b.queuedAt) return a.queuedAt - b.queuedAt;
  return compareIds(a.id, b.id);
}

/** Descending `riffleEnteredAt`, then `queuedAt` ascending, then id: newest into Stale first. */
function compareNewestIntoStale(a: Item, b: Item): number {
  if (a.riffleEnteredAt !== b.riffleEnteredAt) return b.riffleEnteredAt - a.riffleEnteredAt;
  if (a.queuedAt !== b.queuedAt) return a.queuedAt - b.queuedAt;
  return compareIds(a.id, b.id);
}

/**
 * The selected bucket's single queue: its 24h/72h/1w/1mo items (never Stale), ordered by
 * ascending `remaining`, then `queuedAt`, then id.
 */
function buildQueue(
  items: Item[],
  bucketId: string,
  bucketNameById: Map<string, string>,
  pauses: Pause[],
  now: number,
): QueueEntry[] {
  const entries = items
    .filter((item) => item.bucketId === bucketId && item.riffle !== "stale")
    .map((item) => ({ item, entry: toQueueEntry(item, bucketNameById.get(item.bucketId) ?? "", pauses, now) }));
  entries.sort((a, b) => compareSoonestDue(a.item, b.item, a.entry.remaining as number, b.entry.remaining as number));
  return entries.map((e) => e.entry);
}

/** Every Stale item across every bucket, newest into Stale first, each carrying its bucket name. */
function buildStaleItems(
  items: Item[],
  bucketNameById: Map<string, string>,
  pauses: Pause[],
  now: number,
): QueueEntry[] {
  const entries = items
    .filter((item) => item.riffle === "stale")
    .map((item) => ({ item, entry: toQueueEntry(item, bucketNameById.get(item.bucketId) ?? "", pauses, now) }));
  entries.sort((a, b) => compareNewestIntoStale(a.item, b.item));
  return entries.map((e) => e.entry);
}

/**
 * Search results across every bucket and riffle, as one list: timed items first by soonest
 * due, then Stale items newest into Stale first. Empty for a blank query.
 */
function buildSearchResults(
  items: Item[],
  trimmedQuery: string,
  bucketNameById: Map<string, string>,
  pauses: Pause[],
  now: number,
): QueueEntry[] {
  if (trimmedQuery === "") return [];
  const matches = items.filter((item) => matchesQuery(item, trimmedQuery));

  const timed = matches
    .filter((item) => item.riffle !== "stale")
    .map((item) => ({ item, entry: toQueueEntry(item, bucketNameById.get(item.bucketId) ?? "", pauses, now) }));
  timed.sort((a, b) => compareSoonestDue(a.item, b.item, a.entry.remaining as number, b.entry.remaining as number));

  const stale = matches
    .filter((item) => item.riffle === "stale")
    .map((item) => ({ item, entry: toQueueEntry(item, bucketNameById.get(item.bucketId) ?? "", pauses, now) }));
  stale.sort((a, b) => compareNewestIntoStale(a.item, b.item));

  return [...timed.map((e) => e.entry), ...stale.map((e) => e.entry)];
}

/**
 * The launcher's full view: the bucket row (real buckets plus the Stale entry), the selected
 * bucket's single queue, the cross-bucket Stale view, search results, the pause and away-gap
 * banners, and whether item actions are currently allowed.
 */
export function launcherView(input: LauncherViewInput): LauncherView {
  const { buckets, items, pauses, awayGap, selectedBucketId, query, now } = input;

  const bucketsByOrder = [...buckets].sort((a, b) => a.order - b.order);
  const counts = overdueCounts(buckets, items, pauses, now);

  const effectiveSelectedBucketId =
    selectedBucketId !== null && buckets.some((b) => b.id === selectedBucketId)
      ? selectedBucketId
      : (bucketsByOrder[0]?.id ?? "");

  const bucketNameById = new Map(buckets.map((b) => [b.id, b.name]));
  const trimmedQuery = query.trim().toLowerCase();

  const running = runningPause(pauses, now);
  const pauseBanner: PauseBanner | null = running !== undefined ? { start: running.start } : null;

  const awayGapBanner: AwayGapBanner | null =
    awayGap !== null
      ? { start: awayGap.start, end: awayGap.end, freed: itemsFreedByGap(items, pauses, awayGap, now) }
      : null;

  const staleSelected = selectedBucketId === STALE_SELECTION_ID;
  const staleItems = buildStaleItems(items, bucketNameById, pauses, now);

  const switcher: SwitcherEntry[] = [
    ...bucketsByOrder.map((bucket) => ({
      id: bucket.id,
      name: bucket.name,
      count: counts.byBucket[bucket.id] ?? 0,
      selected: !staleSelected && bucket.id === effectiveSelectedBucketId,
      isStale: false,
    })),
    {
      id: STALE_SELECTION_ID,
      name: "Stale",
      count: staleItems.length,
      selected: staleSelected,
      isStale: true,
    },
  ];

  const queue = buildQueue(items, effectiveSelectedBucketId, bucketNameById, pauses, now);
  const searchResults = buildSearchResults(items, trimmedQuery, bucketNameById, pauses, now);

  return {
    selectedBucketId: effectiveSelectedBucketId,
    pauseBanner,
    awayGapBanner,
    actionsEnabled: awayGap === null,
    switcher,
    staleSelected,
    queue,
    staleItems,
    searchResults,
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

/** A tracked tab's remaining-time cue, shown on Sluice's own pages rather than on the tab itself. */
export type TabCue =
  | { kind: "notTimed" }
  | { kind: "active" }
  | { kind: "keptOpen" }
  | { kind: "closing" }
  | { kind: "remaining"; ms: number; label: string };

/** One row of the new tab page's "Open tabs" list. */
export interface OpenTabRow {
  tabId: number;
  title: string;
  url: string;
  domain: string;
  favIconUrl: string | undefined;
  keepOpen: boolean;
  cue: TabCue;
}

export interface OpenTabsViewInput {
  trackedTabs: TrackedTab[];
  autoCloseAfter: number;
  now: number;
}

/**
 * `tab`'s cue and the value rows are sorted by: a running timer's actual remaining ms (so
 * `"closing"` rows, always `<= 0`, sort ahead of positive `"remaining"` rows), or `Infinity` for
 * `"active"`/`"keptOpen"` rows, which have no running timer and sort after every running one.
 */
function tabCue(tab: TrackedTab, autoCloseAfter: number, now: number): { cue: TabCue; sortKey: number } {
  if (!isClosable(tab.url)) return { cue: { kind: "notTimed" }, sortKey: Infinity };
  if (tab.inactiveSince === null) return { cue: { kind: "active" }, sortKey: Infinity };
  if (tab.keepOpen) return { cue: { kind: "keptOpen" }, sortKey: Infinity };
  const ms = remainingTime(tab, autoCloseAfter, now) as number;
  if (ms <= 0) return { cue: { kind: "closing" }, sortKey: ms };
  return { cue: { kind: "remaining", ms, label: `closes in ${formatDuration(ms)}` }, sortKey: ms };
}

/**
 * The "Open tabs" list: each tracked tab with its remaining-time cue. Rows with a running timer
 * come first, ascending by remaining time (so a `"closing"` row sorts ahead of a `"remaining"`
 * one); `tabId` breaks ties.
 */
export function openTabsView(input: OpenTabsViewInput): OpenTabRow[] {
  const { trackedTabs, autoCloseAfter, now } = input;

  const rows = trackedTabs.map((tab) => {
    const { cue, sortKey } = tabCue(tab, autoCloseAfter, now);
    const row: OpenTabRow = {
      tabId: tab.tabId,
      title: tab.title,
      url: tab.url,
      domain: domainOf(tab.url),
      favIconUrl: tab.favIconUrl,
      keepOpen: tab.keepOpen,
      cue,
    };
    return { row, sortKey };
  });

  rows.sort((a, b) => {
    if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
    return a.row.tabId - b.row.tabId;
  });

  return rows.map((r) => r.row);
}

export interface RecentlyClosedViewInput {
  recentlyClosed: ClosedTab[];
  items: Item[];
}

/** The "Recently closed" list: newest first, hiding any entry whose URL has since been queued. */
export function recentlyClosedView(input: RecentlyClosedViewInput): ClosedTab[] {
  const { recentlyClosed, items } = input;
  return recentlyClosed
    .filter((entry) => !isQueuedUrl(entry.url, items))
    .sort((a, b) => b.closedAt - a.closedAt);
}

/** What the "Recently closed" panel renders: the entry count always, and the rows only when expanded. */
export interface RecentlyClosedPanelView {
  count: number;
  entries: ClosedTab[];
}

/**
 * Collapses `entries` (already filtered and ordered by `recentlyClosedView`) to nothing but a
 * count while the panel is collapsed, so no entry title, domain, URL, favicon or close time is
 * ever handed to the renderer until the panel is expanded.
 */
export function recentlyClosedPanelView(entries: ClosedTab[], expanded: boolean): RecentlyClosedPanelView {
  return { count: entries.length, entries: expanded ? entries : [] };
}

/** One row of the triage view's tab list. */
export interface TriageRow {
  tabId: number;
  title: string;
  url: string;
  domain: string;
  favIconUrl: string | undefined;
}

export interface TriageViewInput {
  tabs: WashTab[];
  trackedTabs: TrackedTab[];
  items: Item[];
  buckets: Bucket[];
  lastBucketId: string | null;
  selfTabId: number | null;
}

export interface TriageView {
  rows: TriageRow[];
  buckets: Bucket[];
  defaultBucketId: string | null;
  riffles: RiffleId[];
  closeCount: number;
}

/**
 * The triage view: one row per triage-list tab (selection delegated to `lib/wash.ts`'s
 * `triageTabs`), the buckets in order, the bucket a row's selector defaults to, the riffle
 * ladder, and how many tabs a wash would close.
 */
export function triageView(input: TriageViewInput): TriageView {
  const { tabs, trackedTabs, items, buckets, lastBucketId, selfTabId } = input;

  const rows: TriageRow[] = triageTabs(tabs, trackedTabs, items, selfTabId).map((tab) => ({
    tabId: tab.id as number,
    title: tab.title ?? "",
    url: tab.url ?? "",
    domain: domainOf(tab.url ?? ""),
    favIconUrl: tab.favIconUrl,
  }));

  const bucketsByOrder = [...buckets].sort((a, b) => a.order - b.order);

  const defaultBucketId =
    lastBucketId !== null && buckets.some((b) => b.id === lastBucketId)
      ? lastBucketId
      : bucketsByOrder[0]?.id ?? null;

  const closeCount = tabsToWash(tabs, trackedTabs, selfTabId).length;

  return {
    rows,
    buckets: bucketsByOrder,
    defaultBucketId,
    riffles: ENQUEUE_RIFFLES,
    closeCount,
  };
}
