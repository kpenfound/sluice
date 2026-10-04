import { DEFAULT_BUCKET_NAMES, isRiffleId, nextRiffle } from "./model";
import type { Bucket, Item, Pause, RiffleId } from "./model";
import { normalize } from "./normalize";
import { mergePauses, prunePauses as selectPrunablePauses, runningPause, validatePause } from "./pauses";

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
  subscribe(
    listener: (changes: Record<string, StorageChange>, areaName: string) => void,
  ): () => void;
}

type StorageKey = "buckets" | "items" | "pauses";
type PrefKey = "lastActiveAt" | "lastBucketId";

const WATCHED_KEYS: StorageKey[] = ["buckets", "items", "pauses"];

/**
 * Builds buckets, items and pauses as persisted in `storage.local`, backed by the
 * given `browser.storage` namespace. `now` and `newId` default to `Date.now` and
 * `crypto.randomUUID`, and are threaded through for the item and pause actions
 * built on top of the same read-modify-write primitive.
 */
export function createStore(storage: StorageNamespace, options: StoreOptions = {}): Store {
  const newId = options.newId ?? (() => crypto.randomUUID());
  const now = options.now ?? Date.now;

  // Serializes every read-modify-write made through this store instance, so
  // concurrent calls apply in order instead of racing each other's writes.
  let tail: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = tail.then(fn, fn);
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
      const stored = await storage.local.get(["buckets", "items"]);
      const buckets = (stored.buckets as Bucket[] | undefined) ?? [];
      if (!buckets.some((bucket) => bucket.id === input.bucketId)) {
        throw new Error(`Unknown bucket: ${input.bucketId}`);
      }
      const items = (stored.items as Item[] | undefined) ?? [];
      const normUrl = normalize(input.url);
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
        await storage.local.set({ items: [...items, item] });
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
      await storage.local.set({ items: nextItems });
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
    subscribe,
  };
}
