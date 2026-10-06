import type { Bucket, Pause } from "../lib/model";
import { runningPause } from "../lib/pauses";

/** Buckets ordered by `order`, for the options page's bucket list. */
export function bucketList(buckets: Bucket[]): Bucket[] {
  return [...buckets].sort((a, b) => a.order - b.order);
}

/** True only for a non-blank trimmed name, mirroring `store.ts`'s own empty-name rejection. */
export function validBucketName(name: string): boolean {
  return name.trim().length > 0;
}

/** One pause as the options page's pause list shows it. */
export interface PauseRow {
  id: string;
  start: number;
  /** The pause's end, or `"until resumed"` when it's still running. */
  end: number | "until resumed";
  label?: string;
  /** True for the pause `runningPause` returns for the given `now`. */
  running: boolean;
}

/** Every pause sorted by `start`, with a display-ready `end` and a `running` marker. */
export function pauseRows(pauses: Pause[], now: number): PauseRow[] {
  const running = runningPause(pauses, now);
  return [...pauses]
    .sort((a, b) => a.start - b.start)
    .map((p) => ({
      id: p.id,
      start: p.start,
      end: p.end === null ? ("until resumed" as const) : p.end,
      ...(p.label !== undefined ? { label: p.label } : {}),
      running: running !== undefined && p.id === running.id,
    }));
}

/** The add/edit pause form's raw fields, as read off `datetime-local` inputs. */
export interface PauseFormInput {
  start: string;
  endMode: "date" | "now" | "none";
  /** Only read when `endMode` is `"date"`. */
  end: string;
  label: string;
}

export type ParsePauseFormResult =
  | { ok: true; input: { start: number; end: number | null; label?: string } }
  | { ok: false; error: string };

/** Parses a `datetime-local` string to its epoch milliseconds, or null when it's blank or unparseable. */
function parseDateTimeLocal(value: string): number | null {
  if (value.trim() === "") return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Turns the pause form's fields into `store.addPause`/`store.editPause`'s input, or an inline
 * error with no write: a missing or unparseable start, a missing or unparseable end in `"date"`
 * mode, or an end that isn't strictly after the start (including `"now"` with a future start).
 */
export function parsePauseForm(form: PauseFormInput, now: number): ParsePauseFormResult {
  const start = parseDateTimeLocal(form.start);
  if (start === null) return { ok: false, error: "Enter a valid start date and time." };

  let end: number | null;
  if (form.endMode === "now") {
    end = now;
  } else if (form.endMode === "none") {
    end = null;
  } else {
    end = parseDateTimeLocal(form.end);
    if (end === null) return { ok: false, error: "Enter a valid end date and time." };
  }

  if (end !== null && end <= start) {
    return { ok: false, error: "The end must be after the start." };
  }

  const label = form.label.trim();
  return { ok: true, input: { start, end, ...(label !== "" ? { label } : {}) } };
}

/** Formats an epoch millisecond timestamp as a `datetime-local` input value, for pre-filling an edit form. */
export function toDateTimeLocal(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}
