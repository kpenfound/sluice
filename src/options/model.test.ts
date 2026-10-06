import { describe, expect, test } from "vitest";
import type { Bucket, Pause } from "../lib/model";
import {
  autoCloseMinutes,
  bucketList,
  parseAutoCloseMinutes,
  parsePauseForm,
  pauseRows,
  toDateTimeLocal,
  validBucketName,
} from "./model";

function bucket(id: string, name: string, order: number): Bucket {
  return { id, name, order };
}

function pause(id: string, start: number, end: number | null, label?: string): Pause {
  return { id, start, end, ...(label !== undefined ? { label } : {}) };
}

describe("bucketList", () => {
  test("sorts buckets by order, regardless of input order", () => {
    const buckets = [bucket("b", "Side projects", 1), bucket("a", "Dagger", 0), bucket("c", "Personal", 2)];
    expect(bucketList(buckets).map((b) => b.id)).toEqual(["a", "b", "c"]);
  });

  test("doesn't mutate the input array", () => {
    const buckets = [bucket("b", "B", 1), bucket("a", "A", 0)];
    const copy = [...buckets];
    bucketList(buckets);
    expect(buckets).toEqual(copy);
  });
});

describe("validBucketName", () => {
  test("rejects an empty name", () => {
    expect(validBucketName("")).toBe(false);
  });

  test("rejects a whitespace-only name", () => {
    expect(validBucketName("   \t  ")).toBe(false);
  });

  test("accepts a name with surrounding whitespace", () => {
    expect(validBucketName("  Reading  ")).toBe(true);
  });

  test("accepts a plain name", () => {
    expect(validBucketName("Reading")).toBe(true);
  });
});

describe("pauseRows", () => {
  test("sorts rows by start, regardless of input order", () => {
    const later = new Date(2024, 0, 10, 9, 0).getTime();
    const earlier = new Date(2024, 0, 5, 9, 0).getTime();
    const middle = new Date(2024, 0, 7, 9, 0).getTime();
    const pauses = [
      pause("p-later", later, later + 1000),
      pause("p-earlier", earlier, earlier + 1000),
      pause("p-middle", middle, middle + 1000),
    ];
    const now = new Date(2024, 0, 20, 0, 0).getTime();
    expect(pauseRows(pauses, now).map((r) => r.id)).toEqual(["p-earlier", "p-middle", "p-later"]);
  });

  test("shows a null end as 'until resumed'", () => {
    const start = new Date(2024, 0, 5, 9, 0).getTime();
    const now = new Date(2024, 0, 6, 9, 0).getTime();
    const rows = pauseRows([pause("p1", start, null)], now);
    expect(rows[0]!.end).toBe("until resumed");
  });

  test("shows a closed end as its own timestamp", () => {
    const start = new Date(2024, 0, 5, 9, 0).getTime();
    const end = new Date(2024, 0, 5, 12, 0).getTime();
    const now = new Date(2024, 0, 6, 9, 0).getTime();
    const rows = pauseRows([pause("p1", start, end)], now);
    expect(rows[0]!.end).toBe(end);
  });

  test("marks the running pause, and only that one", () => {
    const start = new Date(2024, 0, 5, 9, 0).getTime();
    const closedStart = new Date(2024, 0, 1, 9, 0).getTime();
    const closedEnd = new Date(2024, 0, 2, 9, 0).getTime();
    const now = new Date(2024, 0, 6, 9, 0).getTime();
    const rows = pauseRows(
      [pause("closed", closedStart, closedEnd), pause("running", start, null)],
      now,
    );
    expect(rows.find((r) => r.id === "running")!.running).toBe(true);
    expect(rows.find((r) => r.id === "closed")!.running).toBe(false);
  });

  test("has no running pause when none is active at now", () => {
    const start = new Date(2025, 5, 1, 9, 0).getTime();
    const end = new Date(2025, 5, 2, 9, 0).getTime();
    const now = new Date(2025, 5, 3, 9, 0).getTime();
    const rows = pauseRows([pause("p1", start, end)], now);
    expect(rows[0]!.running).toBe(false);
  });

  test("includes a label when one is set, and omits the field otherwise", () => {
    const start = new Date(2024, 0, 5, 9, 0).getTime();
    const now = new Date(2024, 0, 6, 9, 0).getTime();
    const rows = pauseRows(
      [pause("labeled", start, null, "Vacation"), pause("unlabeled", start - 1000, null)],
      now,
    );
    expect(rows.find((r) => r.id === "labeled")!.label).toBe("Vacation");
    expect(rows.find((r) => r.id === "unlabeled")!).not.toHaveProperty("label");
  });
});

describe("parsePauseForm", () => {
  const now = new Date(2024, 2, 15, 12, 0).getTime();

  test("'date' mode: a past range with a specific end", () => {
    const result = parsePauseForm(
      { start: "2024-03-01T09:00", endMode: "date", end: "2024-03-02T09:00", label: "" },
      now,
    );
    expect(result).toEqual({
      ok: true,
      input: {
        start: new Date(2024, 2, 1, 9, 0).getTime(),
        end: new Date(2024, 2, 2, 9, 0).getTime(),
      },
    });
  });

  test("'now' mode: a past start ends at now", () => {
    const result = parsePauseForm(
      { start: "2024-03-01T09:00", endMode: "now", end: "", label: "" },
      now,
    );
    expect(result).toEqual({
      ok: true,
      input: { start: new Date(2024, 2, 1, 9, 0).getTime(), end: now },
    });
  });

  test("'none' mode: an open-ended pause", () => {
    const result = parsePauseForm(
      { start: "2024-03-01T09:00", endMode: "none", end: "", label: "" },
      now,
    );
    expect(result).toEqual({
      ok: true,
      input: { start: new Date(2024, 2, 1, 9, 0).getTime(), end: null },
    });
  });

  test("a scheduled future range with a specific end", () => {
    const start = new Date(2024, 2, 20, 9, 0);
    const end = new Date(2024, 2, 22, 9, 0);
    const result = parsePauseForm(
      { start: "2024-03-20T09:00", endMode: "date", end: "2024-03-22T09:00", label: "" },
      now,
    );
    expect(result).toEqual({
      ok: true,
      input: { start: start.getTime(), end: end.getTime() },
    });
  });

  test("omits the label field when it's blank", () => {
    const result = parsePauseForm(
      { start: "2024-03-01T09:00", endMode: "none", end: "", label: "   " },
      now,
    );
    expect(result.ok).toBe(true);
    expect(result).toEqual({
      ok: true,
      input: { start: new Date(2024, 2, 1, 9, 0).getTime(), end: null },
    });
  });

  test("keeps a trimmed label when it's set", () => {
    const result = parsePauseForm(
      { start: "2024-03-01T09:00", endMode: "none", end: "", label: "  Vacation  " },
      now,
    );
    expect(result).toEqual({
      ok: true,
      input: { start: new Date(2024, 2, 1, 9, 0).getTime(), end: null, label: "Vacation" },
    });
  });

  test("error: a missing start", () => {
    const result = parsePauseForm({ start: "", endMode: "none", end: "", label: "" }, now);
    expect(result.ok).toBe(false);
  });

  test("error: an unparseable start", () => {
    const result = parsePauseForm(
      { start: "not a date", endMode: "none", end: "", label: "" },
      now,
    );
    expect(result.ok).toBe(false);
  });

  test("error: a missing end in 'date' mode", () => {
    const result = parsePauseForm(
      { start: "2024-03-01T09:00", endMode: "date", end: "", label: "" },
      now,
    );
    expect(result.ok).toBe(false);
  });

  test("error: an unparseable end in 'date' mode", () => {
    const result = parsePauseForm(
      { start: "2024-03-01T09:00", endMode: "date", end: "not a date", label: "" },
      now,
    );
    expect(result.ok).toBe(false);
  });

  test("error: an end not strictly after the start", () => {
    const result = parsePauseForm(
      { start: "2024-03-01T09:00", endMode: "date", end: "2024-03-01T09:00", label: "" },
      now,
    );
    expect(result.ok).toBe(false);
  });

  test("error: an end before the start", () => {
    const result = parsePauseForm(
      { start: "2024-03-01T09:00", endMode: "date", end: "2024-02-28T09:00", label: "" },
      now,
    );
    expect(result.ok).toBe(false);
  });

  test("error: 'now' mode with a future start", () => {
    const future = new Date(now + 60 * 60 * 1000);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const futureStr = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}`;
    const result = parsePauseForm({ start: futureStr, endMode: "now", end: "", label: "" }, now);
    expect(result.ok).toBe(false);
  });
});

describe("parseAutoCloseMinutes", () => {
  test("accepts '1'", () => {
    expect(parseAutoCloseMinutes("1")).toEqual({ ok: true, ms: 60 * 1000 });
  });

  test("accepts '120'", () => {
    expect(parseAutoCloseMinutes("120")).toEqual({ ok: true, ms: 120 * 60 * 1000 });
  });

  test("rejects '0'", () => {
    expect(parseAutoCloseMinutes("0").ok).toBe(false);
  });

  test("rejects '-5'", () => {
    expect(parseAutoCloseMinutes("-5").ok).toBe(false);
  });

  test("rejects '1.5'", () => {
    expect(parseAutoCloseMinutes("1.5").ok).toBe(false);
  });

  test("rejects 'abc'", () => {
    expect(parseAutoCloseMinutes("abc").ok).toBe(false);
  });

  test("rejects a blank input", () => {
    expect(parseAutoCloseMinutes("   ").ok).toBe(false);
  });
});

describe("autoCloseMinutes", () => {
  test("formats 2 hours as 120 minutes", () => {
    expect(autoCloseMinutes(2 * 60 * 60 * 1000)).toBe(120);
  });
});

describe("toDateTimeLocal", () => {
  test("round-trips through parsePauseForm's start parsing", () => {
    const ms = new Date(2024, 5, 18, 14, 37).getTime();
    const str = toDateTimeLocal(ms);
    const result = parsePauseForm({ start: str, endMode: "none", end: "", label: "" }, ms + 1);
    expect(result).toEqual({ ok: true, input: { start: ms, end: null } });
  });

  test("pads single-digit month, day, hour and minute", () => {
    const ms = new Date(2024, 0, 2, 3, 4).getTime();
    expect(toDateTimeLocal(ms)).toBe("2024-01-02T03:04");
  });
});
