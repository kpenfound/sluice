import { describe, expect, test } from "vitest";
import {
  DAY,
  DEFAULT_BUCKET_NAMES,
  ENQUEUE_RIFFLES,
  HOUR,
  isRiffleId,
  nextRiffle,
  RIFFLES,
  TTL,
} from "./model";

describe("HOUR and DAY", () => {
  test("HOUR is 3,600,000ms and DAY is 24 times that", () => {
    expect(HOUR).toBe(3_600_000);
    expect(DAY).toBe(86_400_000);
  });
});

describe("RIFFLES", () => {
  test("is the fixed ladder from 24h up to 1mo, ending in the untimed stale archive", () => {
    expect(RIFFLES).toEqual(["24h", "72h", "1w", "1mo", "stale"]);
  });
});

describe("ENQUEUE_RIFFLES", () => {
  test("is the timed ladder without stale, which is never an enqueue choice", () => {
    expect(ENQUEUE_RIFFLES).toEqual(["24h", "72h", "1w", "1mo"]);
  });
});

describe("TTL", () => {
  test("pins each timed riffle's time-to-live to the design's 24h/72h/7d/30d figures", () => {
    expect(TTL["24h"]).toBe(86_400_000);
    expect(TTL["72h"]).toBe(259_200_000);
    expect(TTL["1w"]).toBe(604_800_000);
    expect(TTL["1mo"]).toBe(2_592_000_000);
  });

  test("has no entry for stale, which has no TTL", () => {
    expect(Object.keys(TTL)).not.toContain("stale");
  });
});

describe("DEFAULT_BUCKET_NAMES", () => {
  test("is the three fresh-install buckets Dagger, Side projects and Personal, in that order", () => {
    expect(DEFAULT_BUCKET_NAMES).toEqual(["Dagger", "Side projects", "Personal"]);
  });
});

describe("nextRiffle", () => {
  test("steps down the ladder one riffle at a time", () => {
    expect(nextRiffle("24h")).toBe("72h");
    expect(nextRiffle("72h")).toBe("1w");
    expect(nextRiffle("1w")).toBe("1mo");
    expect(nextRiffle("1mo")).toBe("stale");
  });

  test("returns null for stale, the bottom of the ladder", () => {
    expect(nextRiffle("stale")).toBeNull();
  });
});

describe("isRiffleId", () => {
  test("accepts every riffle in the ladder", () => {
    for (const riffle of RIFFLES) {
      expect(isRiffleId(riffle)).toBe(true);
    }
  });

  test("rejects unknown strings", () => {
    expect(isRiffleId("2h")).toBe(false);
    expect(isRiffleId("")).toBe(false);
    expect(isRiffleId("STALE")).toBe(false);
  });
});
