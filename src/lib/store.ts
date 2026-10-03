import { DEFAULT_BUCKET_NAMES } from "./model";
import type { Bucket, Item, Pause } from "./model";

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

export interface Store {
  getBuckets(): Promise<Bucket[]>;
  getItems(): Promise<Item[]>;
  getPauses(): Promise<Pause[]>;
  addBucket(name: string): Promise<Bucket>;
  renameBucket(id: string, name: string): Promise<Bucket>;
  subscribe(
    listener: (changes: Record<string, StorageChange>, areaName: string) => void,
  ): () => void;
}

type StorageKey = "buckets" | "items" | "pauses";

const WATCHED_KEYS: StorageKey[] = ["buckets", "items", "pauses"];

/**
 * Builds buckets, items and pauses as persisted in `storage.local`, backed by the
 * given `browser.storage` namespace. `now` and `newId` default to `Date.now` and
 * `crypto.randomUUID`, and are threaded through for the item and pause actions
 * built on top of the same read-modify-write primitive.
 */
export function createStore(storage: StorageNamespace, options: StoreOptions = {}): Store {
  const newId = options.newId ?? (() => crypto.randomUUID());

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

  return { getBuckets, getItems, getPauses, addBucket, renameBucket, subscribe };
}
