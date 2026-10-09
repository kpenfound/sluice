import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { coverageStartAt, weekendAt, weekendsDue } from "./weekend";

const HOUR = 60 * 60 * 1000;

describe("weekendAt", () => {
  test("includes Saturday 00:00, the weekend's start", () => {
    const saturday = new Date(2024, 0, 6, 0, 0).getTime();
    expect(weekendAt(saturday)).toEqual({
      start: new Date(2024, 0, 6).getTime(),
      end: new Date(2024, 0, 8).getTime(),
    });
  });

  test("excludes Monday 00:00, the weekend's end", () => {
    const monday = new Date(2024, 0, 8, 0, 0).getTime();
    expect(weekendAt(monday)).toBeNull();
  });

  test("includes a late-Sunday-night instant, just before the weekend ends", () => {
    const sundayNight = new Date(2024, 0, 7, 23, 59).getTime();
    expect(weekendAt(sundayNight)).not.toBeNull();
  });

  test("returns null for a mid-week instant", () => {
    const wednesday = new Date(2024, 0, 10, 12, 0).getTime();
    expect(weekendAt(wednesday)).toBeNull();
  });

  test("returns null for a Friday just before the weekend starts", () => {
    const fridayNight = new Date(2024, 0, 5, 23, 59).getTime();
    expect(weekendAt(fridayNight)).toBeNull();
  });

  describe("across a daylight-saving change", () => {
    const originalTz = process.env.TZ;

    beforeEach(() => {
      process.env.TZ = "America/New_York";
    });

    afterEach(() => {
      process.env.TZ = originalTz;
    });

    test("is 47 hours long over the spring-forward weekend", () => {
      const saturday = new Date(2024, 2, 9, 0, 0).getTime();
      const range = weekendAt(saturday)!;
      expect(range.end - range.start).toBe(47 * HOUR);
    });

    test("is 49 hours long over the fall-back weekend", () => {
      const saturday = new Date(2024, 10, 2, 0, 0).getTime();
      const range = weekendAt(saturday)!;
      expect(range.end - range.start).toBe(49 * HOUR);
    });
  });
});

describe("coverageStartAt", () => {
  test("returns the current weekend's Saturday 00:00 when now falls inside one", () => {
    const sundayAfternoon = new Date(2024, 0, 7, 15, 0).getTime();
    expect(coverageStartAt(sundayAfternoon)).toBe(new Date(2024, 0, 6).getTime());
  });

  test("returns now itself on a weekday", () => {
    const wednesday = new Date(2024, 0, 10, 12, 0).getTime();
    expect(coverageStartAt(wednesday)).toBe(wednesday);
  });
});

describe("weekendsDue", () => {
  test("returns the single weekend covering now, when since is its own Saturday", () => {
    const saturday = new Date(2024, 0, 6).getTime();
    const now = new Date(2024, 0, 7, 10, 0).getTime();
    expect(weekendsDue(saturday, now)).toEqual([
      { start: saturday, end: new Date(2024, 0, 8).getTime() },
    ]);
  });

  test("returns both weekends missed while Firefox was closed for weeks", () => {
    const since = new Date(2024, 0, 1, 0, 0).getTime();
    const now = new Date(2024, 0, 22, 0, 0).getTime();
    expect(weekendsDue(since, now)).toEqual([
      { start: new Date(2024, 0, 6).getTime(), end: new Date(2024, 0, 8).getTime() },
      { start: new Date(2024, 0, 13).getTime(), end: new Date(2024, 0, 15).getTime() },
      { start: new Date(2024, 0, 20).getTime(), end: new Date(2024, 0, 22).getTime() },
    ]);
  });

  test("returns nothing when since is after the next Saturday's start", () => {
    const since = new Date(2024, 0, 10, 0, 0).getTime();
    const now = new Date(2024, 0, 12, 0, 0).getTime();
    expect(weekendsDue(since, now)).toEqual([]);
  });

  test("returns nothing when the only candidate weekend hasn't started yet", () => {
    const since = new Date(2024, 0, 1, 0, 0).getTime();
    const now = new Date(2024, 0, 5, 23, 0).getTime();
    expect(weekendsDue(since, now)).toEqual([]);
  });
});
