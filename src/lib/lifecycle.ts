import { DAY, HOUR } from "./model";
import type { Item } from "./model";
import { normalize } from "./normalize";

const MINUTE = 60 * 1000;

/** A tab Sluice is tracking in a normal (non-private) window. */
export interface TrackedTab {
  tabId: number;
  windowId: number;
  trackId: string;
  url: string;
  title: string;
  favIconUrl?: string;
  keepOpen: boolean;
  /** When the tab's auto-close timer started, or null while no timer runs. */
  inactiveSince: number | null;
}

/** A tab that closed without being queued, held for possible reopen or filing. */
export interface ClosedTab {
  id: string;
  trackId: string;
  url: string;
  normUrl: string;
  title: string;
  favIconUrl?: string;
  closedAt: number;
}

/** The fields `tabsToClose` needs about a tab's current, live Firefox state. */
export interface LiveTab {
  id: number;
  active: boolean;
  audible: boolean;
  incognito: boolean;
  url: string;
}

/** The fields `buildTrackedTab` needs about a tab being newly tracked. */
export interface LifecycleTabInput {
  id: number;
  windowId: number;
  active: boolean;
  url: string;
  title: string;
  favIconUrl?: string;
}

/** The tracking id and keep-open flag mirrored into a tab's Sluice `sessions` value. */
export interface SessionValue {
  trackId: string;
  keepOpen: boolean;
}

export const DEFAULT_AUTO_CLOSE_AFTER = 2 * HOUR;
export const RECENTLY_CLOSED_MAX_AGE = 7 * DAY;
export const RECENTLY_CLOSED_MAX = 100;
export const MIN_AUTO_CLOSE_AFTER = MINUTE;

/** The `sessions` tab-value key Sluice uses to carry tracking state across a restart. */
export const SESSION_KEY = "sluice";

/** True only for a URL that parses and whose scheme is `http:` or `https:`. */
export function isClosable(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** True only for a finite value that is a whole number of minutes and at least one minute. */
export function isValidAutoCloseAfter(ms: number): boolean {
  return Number.isFinite(ms) && ms >= MIN_AUTO_CLOSE_AFTER && ms % MINUTE === 0;
}

/** Time left before `tab`'s auto-close timeout, or null while no timer runs. May be zero or negative. */
export function remainingTime(tab: TrackedTab, timeout: number, now: number): number | null {
  if (tab.keepOpen || tab.inactiveSince === null) return null;
  return timeout - (now - tab.inactiveSince);
}

/**
 * The tab ids among `tracked` that are expired and eligible for auto-close: present in `live`,
 * not active, audible or incognito, and with a closable URL.
 */
export function tabsToClose(
  tracked: TrackedTab[],
  live: LiveTab[],
  timeout: number,
  now: number,
): number[] {
  const liveById = new Map(live.map((tab) => [tab.id, tab]));
  const result: number[] = [];

  for (const tab of tracked) {
    const liveTab = liveById.get(tab.tabId);
    if (!liveTab) continue;
    if (liveTab.active || liveTab.audible || liveTab.incognito) continue;
    if (!isClosable(liveTab.url)) continue;

    const remaining = remainingTime(tab, timeout, now);
    if (remaining !== null && remaining <= 0) result.push(tab.tabId);
  }

  return result;
}

/** Whether `url`'s normalized form matches a queued item. */
export function isQueuedUrl(url: string, items: Item[]): boolean {
  const normUrl = normalize(url);
  return items.some((item) => item.normUrl === normUrl);
}

/** Adds `entry` to `list`, replacing any existing entry with the same `normUrl`, newest first, then prunes. */
export function addClosed(list: ClosedTab[], entry: ClosedTab, now: number): ClosedTab[] {
  const withoutDuplicate = list.filter((existing) => existing.normUrl !== entry.normUrl);
  return pruneClosed([entry, ...withoutDuplicate], now);
}

/**
 * Drops entries older than `RECENTLY_CLOSED_MAX_AGE` and, assuming `list` is newest first, keeps
 * only the newest `RECENTLY_CLOSED_MAX`. Returns `list` itself when nothing was dropped.
 */
export function pruneClosed(list: ClosedTab[], now: number): ClosedTab[] {
  const kept = list.filter((entry) => now - entry.closedAt <= RECENTLY_CLOSED_MAX_AGE);
  const capped = kept.length > RECENTLY_CLOSED_MAX ? kept.slice(0, RECENTLY_CLOSED_MAX) : kept;
  return capped.length === list.length ? list : capped;
}

/** Parses an unknown `sessions` tab value into a `SessionValue`, or null when it doesn't match. */
export function parseSessionValue(raw: unknown): SessionValue | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.trackId !== "string" || value.trackId === "") return null;
  if (typeof value.keepOpen !== "boolean") return null;
  return { trackId: value.trackId, keepOpen: value.keepOpen };
}

/**
 * Builds the tracking record for a tab being tracked for the first time. Adopts `sessionValue`'s
 * trackId and keepOpen when it is non-null and its trackId is not already in `takenTrackIds`;
 * otherwise uses `freshTrackId` with `keepOpen: false`. `inactiveSince` is null for the active tab
 * of its window, otherwise `now`.
 */
export function buildTrackedTab(
  tab: LifecycleTabInput,
  sessionValue: SessionValue | null,
  takenTrackIds: Set<string>,
  freshTrackId: string,
  now: number,
): TrackedTab {
  const adopt = sessionValue !== null && !takenTrackIds.has(sessionValue.trackId);

  return {
    tabId: tab.id,
    windowId: tab.windowId,
    trackId: adopt ? sessionValue.trackId : freshTrackId,
    url: tab.url,
    title: tab.title,
    favIconUrl: tab.favIconUrl,
    keepOpen: adopt ? sessionValue.keepOpen : false,
    inactiveSince: tab.active ? null : now,
  };
}
