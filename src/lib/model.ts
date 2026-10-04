/** A fixed queue inside a bucket, ordered from shortest to longest TTL, with "stale" holding no TTL. */
export type RiffleId = "24h" | "72h" | "1w" | "1mo" | "stale";

/** A workspace for one area of life. Each bucket has its own set of riffles. */
export interface Bucket {
  id: string;
  name: string;
  order: number;
}

/** A queued URL that lives in exactly one bucket and one riffle. */
export interface Item {
  id: string;
  /** The original URL, used to open the item. */
  url: string;
  /** The normalized URL, used for matching. */
  normUrl: string;
  title: string;
  favIconUrl?: string;
  bucketId: string;
  riffle: RiffleId;
  /** When the item was first queued. Never changes. */
  queuedAt: number;
  /** Set whenever the item moves riffles. */
  riffleEnteredAt: number;
  lastVisitedAt: number | null;
}

/** A time range that doesn't count toward any item's TTL. Pauses are global. */
export interface Pause {
  id: string;
  start: number;
  /** Null while the pause is running. */
  end: number | null;
  label?: string;
}

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

/** The riffle ladder, from shortest to longest TTL, ending in the untimed "stale" archive. */
export const RIFFLES: RiffleId[] = ["24h", "72h", "1w", "1mo", "stale"];

/** Time to live for each timed riffle. "stale" has no TTL and no entry here. */
export const TTL: Record<"24h" | "72h" | "1w" | "1mo", number> = {
  "24h": 24 * HOUR,
  "72h": 72 * HOUR,
  "1w": 7 * DAY,
  "1mo": 30 * DAY,
};

/** Narrows an arbitrary string to RiffleId. */
export function isRiffleId(value: string): value is RiffleId {
  return (RIFFLES as string[]).includes(value);
}

/** The riffle one step down the ladder from the given one, or null for "stale". */
export function nextRiffle(riffle: RiffleId): RiffleId | null {
  const index = RIFFLES.indexOf(riffle);
  const next = RIFFLES[index + 1];
  return next ?? null;
}

export const DEFAULT_BUCKET_NAMES = ["Dagger", "Side projects", "Personal"];
