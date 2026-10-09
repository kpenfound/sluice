import { DEFAULT_BUCKET_NAMES, isRiffleId, nextRiffle } from "./model";
import type { Bucket, Item, Pause, RiffleId } from "./model";
import { normalize } from "./normalize";
import { mergePauses, prunePauses as selectPrunablePauses, runningPause, validatePause } from "./pauses";
import { detectAwayGap } from "./away";
import type { AwayGap } from "./away";
import { DEFAULT_AUTO_CLOSE_AFTER, addClosed, isClosable, isQueuedUrl, isValidAutoCloseAfter, pruneClosed } from "./lifecycle";
import type { ClosedTab, TrackedTab } from "./lifecycle";
import { coverageStartAt, weekendsDue } from "./weekend";

/** A changed item in a `storage.onChanged` event, matching `browser.storage.StorageChange`. */
export interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

/** The subset of the `browser.storage` namespace the store reads and writes. */
export interface StorageNamespace {
  local: {
    get(keys: string | string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  onChanged: {
    addListener(
      listener: (changes: Record<string, StorageChange>, areaName: string) => void,
    ): void;
    removeListener(
      listener: (changes: Record<string, StorageChange>, areaName: string) => void,
    ): void;
  };
}

export interface StoreOptions {
  now?: () => number;
  newId?: () => string;
  /** Runs a transaction exclusively across extension pages and the background. */
  withLock?: <T>(operation: () => Promise<T>) => Promise<T>;
}

/** Input to `addItem`, the fields a caller supplies for a newly queued or re-queued URL. */
export interface AddItemInput {
  url: string;
  title: string;
  favIconUrl?: string;
  bucketId: string;
  riffle: RiffleId;
}

/** Input to `addPause`, a past range (with an explicit end or "until now") or a future-scheduled one. */
export interface AddPauseInput {
  start: number;
  end: number | null;
  label?: string;
}

/** Fields `editPause` may change on an existing pause. */
export type EditPauseInput = Partial<Pick<Pause, "start" | "end" | "label">>;

/** Fields `updateTrackedTab` may change on a tracked tab. */
export type UpdateTrackedTabInput = Partial<Pick<TrackedTab, "url" | "title" | "favIconUrl" | "windowId">>;

export interface Store {
  getBuckets(): Promise<Bucket[]>;
  getItems(): Promise<Item[]>;
  getPauses(): Promise<Pause[]>;
  addBucket(name: string): Promise<Bucket>;
  renameBucket(id: string, name: string): Promise<Bucket>;
  addItem(input: AddItemInput): Promise<Item>;
  deferItem(id: string): Promise<Item>;
  moveItem(id: string, riffle: RiffleId): Promise<Item>;
  changeBucket(id: string, bucketId: string): Promise<Item>;
  resolveItem(id: string): Promise<void>;
  recordVisit(url: string): Promise<Item | null>;
  pauseNow(end?: number | null): Promise<Pause>;
  resume(): Promise<Pause | null>;
  addPause(input: AddPauseInput): Promise<Pause>;
  editPause(id: string, patch: EditPauseInput): Promise<Pause>;
  deletePause(id: string): Promise<void>;
  prunePauses(): Promise<Pause[]>;
  getLastActiveAt(): Promise<number | null>;
  touchActive(): Promise<number>;
  getLastBucketId(): Promise<string | null>;
  setLastBucketId(id: string): Promise<void>;
  getAwayGap(): Promise<AwayGap | null>;
  recordAwayGap(): Promise<AwayGap | null>;
  acceptAwayGap(): Promise<Pause | null>;
  dismissAwayGap(): Promise<void>;
  getTrackedTabs(): Promise<TrackedTab[]>;
  replaceTrackedTabs(list: TrackedTab[]): Promise<void>;
  trackTab(record: TrackedTab): Promise<TrackedTab>;
  updateTrackedTab(tabId: number, patch: UpdateTrackedTabInput): Promise<TrackedTab | null>;
  activateTab(tabId: number, windowId: number): Promise<void>;
  setKeepOpen(tabId: number, keepOpen: boolean): Promise<TrackedTab>;
  recordTabClosed(tabId: number): Promise<TrackedTab | null>;
  getRecentlyClosed(): Promise<ClosedTab[]>;
  removeClosed(id: string): Promise<ClosedTab | null>;
  removeClosedByTrackIds(trackIds: string[]): Promise<void>;
  pruneRecentlyClosed(): Promise<ClosedTab[]>;
  getAutoCloseAfter(): Promise<number>;
  setAutoCloseAfter(ms: number): Promise<void>;
  getWeekendPauseEnabled(): Promise<boolean>;
  setWeekendPauseEnabled(enabled: boolean): Promise<void>;
  recordDueWeekendPauses(): Promise<Pause[]>;
  subscribe(
    listener: (changes: Record<string, StorageChange>, areaName: string) => void,
  ): () => void;
}

type StorageKey = "buckets" | "items" | "pauses" | "trackedTabs" | "recentlyClosed";
type PrefKey = "lastActiveAt" | "lastBucketId" | "weekendsRecordedThrough";
type WatchedKey = StorageKey | "awayGap" | "autoCloseAfter" | "weekendPauseEnabled";

const WATCHED_KEYS: WatchedKey[] = [
  "buckets",
  "items",
  "pauses",
  "awayGap",
  "trackedTabs",
  "recentlyClosed",
  "autoCloseAfter",
  "weekendPauseEnabled",
];

/** The label a recorded weekend pause gets, unless it merges into a pause that already has one. */
const WEEKEND_PAUSE_LABEL = "Weekend";

/**
 * Builds buckets, items and pauses as persisted in `storage.local`, backed by the
 * given `browser.storage` namespace. `now` and `newId` default to `Date.now` and
 * `crypto.randomUUID`, and are threaded through for the item and pause actions
 * built on top of the same read-modify-write primitive.
 */
export function createStore(storage: StorageNamespace, options: StoreOptions = {}): Store {
  const newId = options.newId ?? (() => crypto.randomUUID());
  const now = options.now ?? Date.now;

  // Web Locks coordinate every extension context; the local queue also preserves call order.
  const withLock = options.withLock ?? (<T>(operation: () => Promise<T>): Promise<T> => {
    const locks = globalThis.navigator?.locks;
    return locks ? locks.request("sluice-storage", operation) : operation();
  });
  let tail: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = () => withLock(fn);
    const result = tail.then(run, run);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // Reads the current value of `key`, lets `fn` decide the next value and the
  // result to return, and writes `next` back when `fn` provides one. `fn` sees
  // `undefined` when the key is absent, and can throw to reject without writing.
  function update<T, R>(
    key: StorageKey,
    fn: (current: T[] | undefined) => { next?: T[]; result: R },
  ): Promise<R> {
    return enqueue(async () => {
      const stored = await storage.local.get(key);
      const current = stored[key] as T[] | undefined;
      const { next, result } = fn(current);
      if (next !== undefined) await storage.local.set({ [key]: next });
      return result;
    });
  }

  function getBuckets(): Promise<Bucket[]> {
    return update<Bucket, Bucket[]>("buckets", (current) => {
      if (current !== undefined) return { result: current };
      const defaults = DEFAULT_BUCKET_NAMES.map((name, order) => ({
        id: newId(),
        name,
        order,
      }));
      return { next: defaults, result: defaults };
    });
  }

  function getItems(): Promise<Item[]> {
    return update<Item, Item[]>("items", (current) => ({ result: current ?? [] }));
  }

  function getPauses(): Promise<Pause[]> {
    return update<Pause, Pause[]>("pauses", (current) => ({ result: current ?? [] }));
  }

  function addBucket(name: string): Promise<Bucket> {
    const trimmed = name.trim();
    if (!trimmed) return Promise.reject(new Error("Bucket name must not be empty."));
    return update<Bucket, Bucket>("buckets", (current) => {
      const buckets = current ?? [];
      const order = buckets.reduce((max, bucket) => Math.max(max, bucket.order), -1) + 1;
      const bucket: Bucket = { id: newId(), name: trimmed, order };
      return { next: [...buckets, bucket], result: bucket };
    });
  }

  function renameBucket(id: string, name: string): Promise<Bucket> {
    const trimmed = name.trim();
    if (!trimmed) return Promise.reject(new Error("Bucket name must not be empty."));
    return update<Bucket, Bucket>("buckets", (current) => {
      const buckets = current ?? [];
      const index = buckets.findIndex((bucket) => bucket.id === id);
      const existing = buckets[index];
      if (existing === undefined) throw new Error(`Unknown bucket: ${id}`);
      const renamed = { ...existing, name: trimmed };
      const next = buckets.slice();
      next[index] = renamed;
      return { next, result: renamed };
    });
  }

  /**
   * Queues a URL. With no queued item sharing its `normUrl`, creates one. With a match in any
   * bucket, moves that item to the given bucket and riffle instead of creating a duplicate,
   * keeping its id, `queuedAt`, `lastVisitedAt`, `url`, `title` and `favIconUrl`.
   */
  function addItem(input: AddItemInput): Promise<Item> {
    if (!isRiffleId(input.riffle)) {
      return Promise.reject(new Error(`Unknown riffle: ${input.riffle}`));
    }
    return enqueue(async () => {
      const stored = await storage.local.get(["buckets", "items", "recentlyClosed"]);
      const buckets = (stored.buckets as Bucket[] | undefined) ?? [];
      if (!buckets.some((bucket) => bucket.id === input.bucketId)) {
        throw new Error(`Unknown bucket: ${input.bucketId}`);
      }
      const items = (stored.items as Item[] | undefined) ?? [];
      const normUrl = normalize(input.url);
      const recentlyClosed = (stored.recentlyClosed as ClosedTab[] | undefined) ?? [];
      const unqueuedClosed = recentlyClosed.filter((entry) => entry.normUrl !== normUrl);
      const capture = {
        lastBucketId: input.bucketId,
        ...(unqueuedClosed.length !== recentlyClosed.length ? { recentlyClosed: unqueuedClosed } : {}),
      };
      const index = items.findIndex((item) => item.normUrl === normUrl);
      const whenNow = now();

      if (index === -1) {
        const item: Item = {
          id: newId(),
          url: input.url,
          normUrl,
          title: input.title,
          bucketId: input.bucketId,
          riffle: input.riffle,
          queuedAt: whenNow,
          riffleEnteredAt: whenNow,
          lastVisitedAt: null,
          ...(input.favIconUrl !== undefined ? { favIconUrl: input.favIconUrl } : {}),
        };
        await storage.local.set({ items: [...items, item], ...capture });
        return item;
      }

      const existing = items[index]!;
      const moved: Item = {
        ...existing,
        bucketId: input.bucketId,
        riffle: input.riffle,
        riffleEnteredAt: whenNow,
      };
      const nextItems = items.slice();
      nextItems[index] = moved;
      await storage.local.set({ items: nextItems, ...capture });
      return moved;
    });
  }

  /** Moves an item one step down the riffle ladder. A no-op on a Stale item, which has no step below it. */
  function deferItem(id: string): Promise<Item> {
    return update<Item, Item>("items", (current) => {
      const items = current ?? [];
      const index = items.findIndex((item) => item.id === id);
      const existing = items[index];
      if (existing === undefined) throw new Error(`Unknown item: ${id}`);
      const stepped = nextRiffle(existing.riffle);
      if (stepped === null) return { result: existing };
      const deferred: Item = { ...existing, riffle: stepped, riffleEnteredAt: now() };
      const nextItems = items.slice();
      nextItems[index] = deferred;
      return { next: nextItems, result: deferred };
    });
  }

  /** Puts an item in any riffle, up or down the ladder, including out of Stale. */
  function moveItem(id: string, riffle: RiffleId): Promise<Item> {
    if (!isRiffleId(riffle)) return Promise.reject(new Error(`Unknown riffle: ${riffle}`));
    return update<Item, Item>("items", (current) => {
      const items = current ?? [];
      const index = items.findIndex((item) => item.id === id);
      const existing = items[index];
      if (existing === undefined) throw new Error(`Unknown item: ${id}`);
      const moved: Item = { ...existing, riffle, riffleEnteredAt: now() };
      const nextItems = items.slice();
      nextItems[index] = moved;
      return { next: nextItems, result: moved };
    });
  }

  /** Moves an item to another bucket, leaving its riffle and timestamps unchanged. */
  function changeBucket(id: string, bucketId: string): Promise<Item> {
    return enqueue(async () => {
      const stored = await storage.local.get(["buckets", "items"]);
      const buckets = (stored.buckets as Bucket[] | undefined) ?? [];
      if (!buckets.some((bucket) => bucket.id === bucketId)) {
        throw new Error(`Unknown bucket: ${bucketId}`);
      }
      const items = (stored.items as Item[] | undefined) ?? [];
      const index = items.findIndex((item) => item.id === id);
      const existing = items[index];
      if (existing === undefined) throw new Error(`Unknown item: ${id}`);
      const changed: Item = { ...existing, bucketId };
      const nextItems = items.slice();
      nextItems[index] = changed;
      await storage.local.set({ items: nextItems });
      return changed;
    });
  }

  /** Deletes an item entirely. Nothing about it is kept. */
  function resolveItem(id: string): Promise<void> {
    return update<Item, void>("items", (current) => {
      const items = current ?? [];
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) throw new Error(`Unknown item: ${id}`);
      const nextItems = items.slice();
      nextItems.splice(index, 1);
      return { next: nextItems, result: undefined };
    });
  }

  /**
   * Normalizes `url` and looks it up among queued items. On a match, sets `lastVisitedAt = now`
   * and returns the item, leaving it in its riffle. With no match, writes nothing and returns null.
   */
  function recordVisit(url: string): Promise<Item | null> {
    return update<Item, Item | null>("items", (current) => {
      const items = current ?? [];
      const normUrl = normalize(url);
      const index = items.findIndex((item) => item.normUrl === normUrl);
      if (index === -1) return { result: null };
      const existing = items[index]!;
      const visited: Item = { ...existing, lastVisitedAt: now() };
      const nextItems = items.slice();
      nextItems[index] = visited;
      return { next: nextItems, result: visited };
    });
  }

  /** The merged pause whose range covers `start`, after `mergePauses` has made ranges disjoint and non-touching. */
  function findPauseAt(merged: Pause[], start: number): Pause {
    return merged.find((p) => p.start <= start && (p.end === null || p.end > start))!;
  }

  /** Validates `candidate`, merges it into `pauses` (replacing `replaceId` if given) and returns the write. Rejects with no write when invalid. */
  function mergeWrite(
    pauses: Pause[],
    candidate: Pause,
    replaceId?: string,
  ): { next: Pause[]; result: Pause } {
    if (!validatePause(candidate)) {
      throw new Error("Invalid pause: end must be null or after start.");
    }
    const others = replaceId !== undefined ? pauses.filter((p) => p.id !== replaceId) : pauses;
    const next = mergePauses([...others, candidate]);
    return { next, result: findPauseAt(next, candidate.start) };
  }

  /** Starts a pause with `start = now` and `end = null`, or the given later end that schedules the resume. */
  function pauseNow(end: number | null = null): Promise<Pause> {
    return update<Pause, Pause>("pauses", (current) => {
      const whenNow = now();
      return mergeWrite(current ?? [], { id: newId(), start: whenNow, end });
    });
  }

  /** Sets `end = now` on the running pause. Does nothing when no pause is running. */
  function resume(): Promise<Pause | null> {
    return update<Pause, Pause | null>("pauses", (current) => {
      const pauses = current ?? [];
      const whenNow = now();
      const running = runningPause(pauses, whenNow);
      if (running === undefined) return { result: null };
      return mergeWrite(pauses, { ...running, end: whenNow }, running.id);
    });
  }

  /** Saves a pause over a past range (an explicit end, or "until now" when the caller passes `now`) or a future-scheduled one. */
  function addPause(input: AddPauseInput): Promise<Pause> {
    return update<Pause, Pause>("pauses", (current) => {
      const pause: Pause = {
        id: newId(),
        start: input.start,
        end: input.end,
        ...(input.label !== undefined ? { label: input.label } : {}),
      };
      return mergeWrite(current ?? [], pause);
    });
  }

  /** Changes a pause's start, end or label by id. Merging is reapplied on the result. */
  function editPause(id: string, patch: EditPauseInput): Promise<Pause> {
    return update<Pause, Pause>("pauses", (current) => {
      const pauses = current ?? [];
      const existing = pauses.find((p) => p.id === id);
      if (existing === undefined) throw new Error(`Unknown pause: ${id}`);
      const updated: Pause = { ...existing, ...patch };
      return mergeWrite(pauses, updated, id);
    });
  }

  /** Deletes a pause by id. */
  function deletePause(id: string): Promise<void> {
    return update<Pause, void>("pauses", (current) => {
      const pauses = current ?? [];
      const index = pauses.findIndex((p) => p.id === id);
      if (index === -1) throw new Error(`Unknown pause: ${id}`);
      const remaining = pauses.filter((p) => p.id !== id);
      return { next: mergePauses(remaining), result: undefined };
    });
  }

  /** Removes every pause `pauses.ts`'s `prunePauses` selects as no longer able to affect any item. */
  function prunePauses(): Promise<Pause[]> {
    return enqueue(async () => {
      const stored = await storage.local.get(["pauses", "items"]);
      const pauses = (stored.pauses as Pause[] | undefined) ?? [];
      const items = (stored.items as Item[] | undefined) ?? [];
      const pruned = selectPrunablePauses(pauses, items, now());
      await storage.local.set({ pauses: pruned });
      return pruned;
    });
  }

  /** Reads a scalar preference key, or null when it is absent. Makes no write. */
  function getPref<T>(key: PrefKey): Promise<T | null> {
    return enqueue(async () => {
      const stored = await storage.local.get(key);
      return (stored[key] as T | undefined) ?? null;
    });
  }

  /** Writes `lastActiveAt = now` and returns it. */
  function touchActive(): Promise<number> {
    return enqueue(async () => {
      const whenNow = now();
      await storage.local.set({ lastActiveAt: whenNow });
      return whenNow;
    });
  }

  /** Records the bucket last used when adding an item. */
  function setLastBucketId(id: string): Promise<void> {
    return enqueue(async () => {
      await storage.local.set({ lastBucketId: id });
    });
  }

  /** Reads the pending away-gap offer, or null when absent or null. Makes no write. */
  function getAwayGap(): Promise<AwayGap | null> {
    return enqueue(async () => {
      const stored = await storage.local.get("awayGap");
      return (stored.awayGap as AwayGap | null | undefined) ?? null;
    });
  }

  /**
   * Reads `lastActiveAt` and `pauses` and runs `detectAwayGap` against the given `now`. Writes
   * `awayGap` only when a gap is found, replacing any older pending one. Never writes `lastActiveAt`.
   */
  function recordAwayGap(): Promise<AwayGap | null> {
    return enqueue(async () => {
      const stored = await storage.local.get(["lastActiveAt", "pauses"]);
      const lastActiveAt = (stored.lastActiveAt as number | undefined) ?? null;
      const pauses = (stored.pauses as Pause[] | undefined) ?? [];
      const gap = detectAwayGap(lastActiveAt, now(), pauses);
      if (gap !== null) await storage.local.set({ awayGap: gap });
      return gap;
    });
  }

  /**
   * With a pending gap, adds it as a pause through the same validate/merge-on-write path `addPause`
   * uses, clears `awayGap`, and returns the merged pause. With nothing pending, makes no write.
   */
  function acceptAwayGap(): Promise<Pause | null> {
    return enqueue(async () => {
      const stored = await storage.local.get(["awayGap", "pauses"]);
      const gap = (stored.awayGap as AwayGap | null | undefined) ?? null;
      if (gap === null) return null;
      const pauses = (stored.pauses as Pause[] | undefined) ?? [];
      const { next, result } = mergeWrite(pauses, { id: newId(), start: gap.start, end: gap.end });
      await storage.local.set({ pauses: next, awayGap: null });
      return result;
    });
  }

  /** Clears the pending away-gap offer. */
  function dismissAwayGap(): Promise<void> {
    return enqueue(async () => {
      await storage.local.set({ awayGap: null });
    });
  }

  /** Reads the tracked tabs, or [] when the key is absent. Makes no write. */
  function getTrackedTabs(): Promise<TrackedTab[]> {
    return update<TrackedTab, TrackedTab[]>("trackedTabs", (current) => ({ result: current ?? [] }));
  }

  /** Replaces the whole tracked-tabs array, for reconciliation (startup restore, install). */
  function replaceTrackedTabs(list: TrackedTab[]): Promise<void> {
    return enqueue(async () => {
      await storage.local.set({ trackedTabs: list });
    });
  }

  /** Upserts a tracked tab by `tabId`. */
  function trackTab(record: TrackedTab): Promise<TrackedTab> {
    return update<TrackedTab, TrackedTab>("trackedTabs", (current) => {
      const tabs = current ?? [];
      const index = tabs.findIndex((tab) => tab.tabId === record.tabId);
      const next = tabs.slice();
      if (index === -1) next.push(record);
      else next[index] = record;
      return { next, result: record };
    });
  }

  /**
   * Patches a tracked tab's url/title/favIconUrl/windowId. Returns null with no write for an
   * unknown tab or when the patch changes nothing.
   */
  function updateTrackedTab(tabId: number, patch: UpdateTrackedTabInput): Promise<TrackedTab | null> {
    return update<TrackedTab, TrackedTab | null>("trackedTabs", (current) => {
      const tabs = current ?? [];
      const index = tabs.findIndex((tab) => tab.tabId === tabId);
      const existing = tabs[index];
      if (existing === undefined) return { result: null };

      const updated: TrackedTab = {
        ...existing,
        ...(patch.url !== undefined ? { url: patch.url } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.favIconUrl !== undefined ? { favIconUrl: patch.favIconUrl } : {}),
        ...(patch.windowId !== undefined ? { windowId: patch.windowId } : {}),
      };
      if (
        updated.url === existing.url &&
        updated.title === existing.title &&
        updated.favIconUrl === existing.favIconUrl &&
        updated.windowId === existing.windowId
      ) {
        return { result: null };
      }

      const next = tabs.slice();
      next[index] = updated;
      return { next, result: updated };
    });
  }

  /**
   * Marks `tabId` active: its own `inactiveSince` becomes null, and every other record in the
   * same `windowId` whose `inactiveSince` is null (the previously active tab) starts its timer.
   */
  function activateTab(tabId: number, windowId: number): Promise<void> {
    return update<TrackedTab, void>("trackedTabs", (current) => {
      const tabs = current ?? [];
      const whenNow = now();
      const next = tabs.map((tab) => {
        if (tab.tabId === tabId) {
          return tab.inactiveSince === null ? tab : { ...tab, inactiveSince: null };
        }
        if (tab.windowId === windowId && tab.inactiveSince === null) {
          return { ...tab, inactiveSince: whenNow };
        }
        return tab;
      });
      return { next, result: undefined };
    });
  }

  /**
   * Sets a tracked tab's keep-open flag. Rejects an unknown tab. Unmarking (`keepOpen: false`) a
   * tab whose `inactiveSince` is non-null resets it to now, restarting its timer.
   */
  function setKeepOpen(tabId: number, keepOpen: boolean): Promise<TrackedTab> {
    return update<TrackedTab, TrackedTab>("trackedTabs", (current) => {
      const tabs = current ?? [];
      const index = tabs.findIndex((tab) => tab.tabId === tabId);
      const existing = tabs[index];
      if (existing === undefined) throw new Error(`Unknown tab: ${tabId}`);
      const inactiveSince = !keepOpen && existing.inactiveSince !== null ? now() : existing.inactiveSince;
      const updated: TrackedTab = { ...existing, keepOpen, inactiveSince };
      const next = tabs.slice();
      next[index] = updated;
      return { next, result: updated };
    });
  }

  /**
   * Removes a tab's tracking record. When its URL is closable and not queued, also adds a
   * "Recently closed" entry, writing both keys in one `storage.local.set` call. Returns the
   * removed record, or null with no write when the tab is unknown.
   */
  function recordTabClosed(tabId: number): Promise<TrackedTab | null> {
    return enqueue(async () => {
      const stored = await storage.local.get(["trackedTabs", "items", "recentlyClosed"]);
      const tracked = (stored.trackedTabs as TrackedTab[] | undefined) ?? [];
      const index = tracked.findIndex((tab) => tab.tabId === tabId);
      const existing = tracked[index];
      if (existing === undefined) return null;

      const nextTracked = tracked.slice();
      nextTracked.splice(index, 1);

      const items = (stored.items as Item[] | undefined) ?? [];
      const recentlyClosed = (stored.recentlyClosed as ClosedTab[] | undefined) ?? [];
      const whenNow = now();
      let nextClosed = recentlyClosed;
      if (isClosable(existing.url) && !isQueuedUrl(existing.url, items)) {
        const entry: ClosedTab = {
          id: newId(),
          trackId: existing.trackId,
          url: existing.url,
          normUrl: normalize(existing.url),
          title: existing.title,
          ...(existing.favIconUrl !== undefined ? { favIconUrl: existing.favIconUrl } : {}),
          closedAt: whenNow,
        };
        nextClosed = addClosed(recentlyClosed, entry, whenNow);
      }

      await storage.local.set({ trackedTabs: nextTracked, recentlyClosed: nextClosed });
      return existing;
    });
  }

  /** Reads "Recently closed", or [] when the key is absent. Makes no write. */
  function getRecentlyClosed(): Promise<ClosedTab[]> {
    return update<ClosedTab, ClosedTab[]>("recentlyClosed", (current) => ({ result: current ?? [] }));
  }

  /** Removes a "Recently closed" entry by id. Returns null with no write for an unknown id. */
  function removeClosed(id: string): Promise<ClosedTab | null> {
    return update<ClosedTab, ClosedTab | null>("recentlyClosed", (current) => {
      const list = current ?? [];
      const index = list.findIndex((entry) => entry.id === id);
      const existing = list[index];
      if (existing === undefined) return { result: null };
      const next = list.slice();
      next.splice(index, 1);
      return { next, result: existing };
    });
  }

  /** Removes every "Recently closed" entry whose trackId is in `trackIds`. No write when none match. */
  function removeClosedByTrackIds(trackIds: string[]): Promise<void> {
    return update<ClosedTab, void>("recentlyClosed", (current) => {
      const list = current ?? [];
      const ids = new Set(trackIds);
      const next = list.filter((entry) => !ids.has(entry.trackId));
      if (next.length === list.length) return { result: undefined };
      return { next, result: undefined };
    });
  }

  /** Prunes "Recently closed" by age and count. Makes no write when nothing is pruned. */
  function pruneRecentlyClosed(): Promise<ClosedTab[]> {
    return enqueue(async () => {
      const stored = await storage.local.get("recentlyClosed");
      const list = (stored.recentlyClosed as ClosedTab[] | undefined) ?? [];
      const pruned = pruneClosed(list, now());
      if (pruned !== list) await storage.local.set({ recentlyClosed: pruned });
      return pruned;
    });
  }

  /** Reads the auto-close timeout, defaulting to `DEFAULT_AUTO_CLOSE_AFTER` when absent. */
  function getAutoCloseAfter(): Promise<number> {
    return enqueue(async () => {
      const stored = await storage.local.get("autoCloseAfter");
      return (stored.autoCloseAfter as number | undefined) ?? DEFAULT_AUTO_CLOSE_AFTER;
    });
  }

  /** Sets the auto-close timeout. Rejects with no write when `isValidAutoCloseAfter` fails. */
  function setAutoCloseAfter(ms: number): Promise<void> {
    if (!isValidAutoCloseAfter(ms)) {
      return Promise.reject(new Error(`Invalid auto-close timeout: ${ms}`));
    }
    return enqueue(async () => {
      await storage.local.set({ autoCloseAfter: ms });
    });
  }

  /** Reads the weekend-pause setting, defaulting to off (false) when absent. */
  function getWeekendPauseEnabled(): Promise<boolean> {
    return enqueue(async () => {
      const stored = await storage.local.get("weekendPauseEnabled");
      return (stored.weekendPauseEnabled as boolean | undefined) ?? false;
    });
  }

  /**
   * Turns the weekend-pause setting on or off. Turning it on advances the "recorded through"
   * marker no further back than where it already stood, and no further forward than the start
   * of the weekend covering `now` (its Saturday 00:00) when `now` falls inside one, so a weekend
   * that ended before this call is never recorded and a weekend already recorded is never
   * recorded again.
   */
  function setWeekendPauseEnabled(enabled: boolean): Promise<void> {
    return enqueue(async () => {
      if (!enabled) {
        await storage.local.set({ weekendPauseEnabled: false });
        return;
      }
      const stored = await storage.local.get("weekendsRecordedThrough");
      const existing = (stored.weekendsRecordedThrough as number | undefined) ?? -Infinity;
      const marker = Math.max(existing, coverageStartAt(now()));
      await storage.local.set({ weekendPauseEnabled: true, weekendsRecordedThrough: marker });
    });
  }

  /**
   * With the setting on, records every weekend due since the "recorded through" marker, up to
   * now, as a pause labelled "Weekend" through the same validate/merge-on-write path `addPause`
   * uses, and advances the marker past the last one recorded. With the setting off, or nothing
   * due, makes no write.
   */
  function recordDueWeekendPauses(): Promise<Pause[]> {
    return enqueue(async () => {
      const stored = await storage.local.get(["weekendPauseEnabled", "weekendsRecordedThrough", "pauses"]);
      const enabled = (stored.weekendPauseEnabled as boolean | undefined) ?? false;
      const pauses = (stored.pauses as Pause[] | undefined) ?? [];
      if (!enabled) return pauses;

      const whenNow = now();
      const marker = (stored.weekendsRecordedThrough as number | undefined) ?? whenNow;
      const due = weekendsDue(marker, whenNow);
      if (due.length === 0) return pauses;

      let next = pauses;
      for (const range of due) {
        next = mergeWrite(next, { id: newId(), start: range.start, end: range.end, label: WEEKEND_PAUSE_LABEL }).next;
      }
      await storage.local.set({ pauses: next, weekendsRecordedThrough: due[due.length - 1]!.end });
      return next;
    });
  }

  function subscribe(
    listener: (changes: Record<string, StorageChange>, areaName: string) => void,
  ): () => void {
    function handleChange(changes: Record<string, StorageChange>, areaName: string): void {
      if (areaName !== "local") return;
      if (!Object.keys(changes).some((key) => (WATCHED_KEYS as string[]).includes(key))) return;
      listener(changes, areaName);
    }
    storage.onChanged.addListener(handleChange);
    return () => storage.onChanged.removeListener(handleChange);
  }

  return {
    getBuckets,
    getItems,
    getPauses,
    addBucket,
    renameBucket,
    addItem,
    deferItem,
    moveItem,
    changeBucket,
    resolveItem,
    recordVisit,
    pauseNow,
    resume,
    addPause,
    editPause,
    deletePause,
    prunePauses,
    getLastActiveAt: () => getPref<number>("lastActiveAt"),
    touchActive,
    getLastBucketId: () => getPref<string>("lastBucketId"),
    setLastBucketId,
    getAwayGap,
    recordAwayGap,
    acceptAwayGap,
    dismissAwayGap,
    getTrackedTabs,
    replaceTrackedTabs,
    trackTab,
    updateTrackedTab,
    activateTab,
    setKeepOpen,
    recordTabClosed,
    getRecentlyClosed,
    removeClosed,
    removeClosedByTrackIds,
    pruneRecentlyClosed,
    getAutoCloseAfter,
    setAutoCloseAfter,
    getWeekendPauseEnabled,
    setWeekendPauseEnabled,
    recordDueWeekendPauses,
    subscribe,
  };
}
