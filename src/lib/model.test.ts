import { describe, expect, test } from "vitest";
import { isRiffleId, nextRiffle, RIFFLES } from "./model";

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

  test("covers every riffle in the ladder", () => {
    expect(RIFFLES).toEqual(["24h", "72h", "1w", "1mo", "stale"]);
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
