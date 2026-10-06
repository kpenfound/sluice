import { isClosable, isQueuedUrl } from "./lifecycle";
import type { TrackedTab } from "./lifecycle";
import type { Item } from "./model";

export const WASH_COMMAND = "wash";

/** The triage view's path, relative to the extension root. */
export const WASH_PAGE = "newtab.html?wash=1";

export const WASH_MESSAGE_TYPE = "sluice-wash";

/** The runtime message that asks the background to run a wash. */
export interface WashMessage {
  type: typeof WASH_MESSAGE_TYPE;
}

export function isWashMessage(value: unknown): value is WashMessage {
  if (typeof value !== "object" || value === null) return false;
  return (value as Record<string, unknown>).type === WASH_MESSAGE_TYPE;
}

/** The fields a wash's tab selection needs about a tab's current, live Firefox state. */
export interface WashTab {
  id?: number;
  windowId?: number;
  index?: number;
  url?: string;
  title?: string;
  favIconUrl?: string;
  audible?: boolean;
  incognito?: boolean;
}

/** True when a wash never closes `tab`: it is audible, or its tracked record has `keepOpen: true`. */
export function isWashExempt(tab: WashTab, trackedTabs: TrackedTab[]): boolean {
  if (tab.audible) return true;
  const tracked = trackedTabs.find((t) => t.tabId === tab.id);
  return tracked?.keepOpen === true;
}

/** The ids of every tab a wash closes: not incognito, not the kept tab, not exempt. */
export function tabsToWash(
  tabs: WashTab[],
  trackedTabs: TrackedTab[],
  keptTabId: number | null,
): number[] {
  const result: number[] = [];

  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    if (tab.incognito) continue;
    if (tab.id === keptTabId) continue;
    if (isWashExempt(tab, trackedTabs)) continue;
    result.push(tab.id);
  }

  return result;
}

/**
 * The tabs a wash would close whose URL is closable (http(s)) and not already queued, for the
 * triage view. Ordered by `windowId`, then `index`, then `id`.
 */
export function triageTabs(
  tabs: WashTab[],
  trackedTabs: TrackedTab[],
  items: Item[],
  keptTabId: number | null,
): WashTab[] {
  const washIds = new Set(tabsToWash(tabs, trackedTabs, keptTabId));

  return tabs
    .filter((tab) => tab.id !== undefined && washIds.has(tab.id))
    .filter((tab) => tab.url !== undefined && isClosable(tab.url) && !isQueuedUrl(tab.url, items))
    .sort((a, b) => {
      const windowDiff = (a.windowId ?? 0) - (b.windowId ?? 0);
      if (windowDiff !== 0) return windowDiff;
      const indexDiff = (a.index ?? 0) - (b.index ?? 0);
      if (indexDiff !== 0) return indexDiff;
      return (a.id ?? 0) - (b.id ?? 0);
    });
}
