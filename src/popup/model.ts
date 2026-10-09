import type { Bucket, Item, Pause, RiffleId } from "../lib/model";
import { ENQUEUE_RIFFLES } from "../lib/model";
import type { TrackedTab } from "../lib/lifecycle";
import { normalize } from "../lib/normalize";
import { runningPause } from "../lib/pauses";
import type { Store } from "../lib/store";

/** The fields the popup reads off the active tab. */
export interface Tab {
  url: string;
  title: string;
  favIconUrl?: string;
}

/** The pause control's state, independent of whether the tab can be queued. */
export type PopupPauseState = { status: "idle" } | { status: "running"; end: number | null };

/** The keep-open control's state: whether the tab is tracked, and if so its flag. */
export type PopupKeepOpenState = { tracked: false } | { tracked: true; keepOpen: boolean };

/** The tab's URL isn't `http:` or `https:`, so it can't be queued. */
export interface UnqueueableState {
  kind: "unqueueable";
  pause: PopupPauseState;
  keepOpen: PopupKeepOpenState;
}

/** The tab isn't queued yet: the add form's fields. */
export interface AddState {
  kind: "add";
  title: string;
  buckets: Bucket[];
  riffles: RiffleId[];
  defaultRiffle: "72h";
  defaultBucketId: string;
  pause: PopupPauseState;
  keepOpen: PopupKeepOpenState;
}

/** The tab is already queued: the matched item and where it sits. */
export interface QueuedState {
  kind: "queued";
  item: Item;
  bucketName: string;
  riffle: RiffleId;
  pause: PopupPauseState;
  keepOpen: PopupKeepOpenState;
}

export type PopupState = UnqueueableState | AddState | QueuedState;

export interface PopupStateInput {
  tab: Tab;
  tabId: number;
  buckets: Bucket[];
  items: Item[];
  pauses: Pause[];
  trackedTabs: TrackedTab[];
  lastBucketId: string | null;
  now: number;
}

function isQueueableUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** `lastBucketId` when that bucket still exists, otherwise the bucket with the lowest `order`. */
function defaultBucketId(bucketsByOrder: Bucket[], lastBucketId: string | null): string {
  if (lastBucketId !== null && bucketsByOrder.some((bucket) => bucket.id === lastBucketId)) {
    return lastBucketId;
  }
  return bucketsByOrder[0]?.id ?? "";
}

/**
 * The popup's state for one tab: whether it can be queued, its add-form fields, or the
 * queued item it matches, plus the pause control's state.
 */
export function popupState(input: PopupStateInput): PopupState {
  const { tab, tabId, buckets, items, pauses, trackedTabs, lastBucketId, now } = input;
  const running = runningPause(pauses, now);
  const pause: PopupPauseState =
    running !== undefined ? { status: "running", end: running.end } : { status: "idle" };

  const tracked = trackedTabs.find((t) => t.tabId === tabId);
  const keepOpen: PopupKeepOpenState =
    tracked !== undefined ? { tracked: true, keepOpen: tracked.keepOpen } : { tracked: false };

  if (!isQueueableUrl(tab.url)) {
    return { kind: "unqueueable", pause, keepOpen };
  }

  const normUrl = normalize(tab.url);
  const matched = items.find((item) => item.normUrl === normUrl);
  if (matched !== undefined) {
    const bucket = buckets.find((b) => b.id === matched.bucketId);
    return {
      kind: "queued",
      item: matched,
      bucketName: bucket?.name ?? "",
      riffle: matched.riffle,
      pause,
      keepOpen,
    };
  }

  const bucketsByOrder = [...buckets].sort((a, b) => a.order - b.order);
  return {
    kind: "add",
    title: tab.title,
    buckets: bucketsByOrder,
    riffles: ENQUEUE_RIFFLES,
    defaultRiffle: "72h",
    defaultBucketId: defaultBucketId(bucketsByOrder, lastBucketId),
    pause,
    keepOpen,
  };
}

/** Queues the tab in the given bucket and riffle, and remembers the bucket as last used. */
export async function saveTab(
  store: Store,
  tab: Tab,
  bucketId: string,
  riffle: RiffleId,
): Promise<Item> {
  const item = await store.addItem({
    url: tab.url,
    title: tab.title,
    favIconUrl: tab.favIconUrl,
    bucketId,
    riffle,
  });
  return item;
}

/** Moves a queued item to the given riffle. */
export function move(store: Store, id: string, riffle: RiffleId): Promise<Item> {
  return store.moveItem(id, riffle);
}

/** Removes a queued item. */
export function resolve(store: Store, id: string): Promise<void> {
  return store.resolveItem(id);
}

export type PauseResult = { ok: true; pause: Pause } | { ok: false; error: string };

/** Starts a pause, refusing an end date that isn't after `now` without writing anything. */
export async function pause(
  store: Store,
  end: number | null,
  now: number,
): Promise<PauseResult> {
  if (end !== null && end <= now) {
    return { ok: false, error: "The end date must be after now." };
  }
  const started = await store.pauseNow(end ?? undefined);
  return { ok: true, pause: started };
}

/** Ends the running pause. */
export function resumePause(store: Store): Promise<Pause | null> {
  return store.resume();
}

/** Marks or unmarks the given tab as keep-open. */
export function setKeepOpen(store: Store, tabId: number, keepOpen: boolean): Promise<TrackedTab> {
  return store.setKeepOpen(tabId, keepOpen);
}
