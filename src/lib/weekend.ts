/** A weekend's range, Saturday 00:00 (inclusive) to the following Monday 00:00 (exclusive), both local midnights. */
export interface WeekendRange {
  start: number;
  end: number;
}

/** Local midnight on the given date, via the local `Date` constructor so daylight saving is handled automatically. */
function midnight(year: number, month: number, date: number): number {
  return new Date(year, month, date).getTime();
}

/** The most recent Saturday 00:00 at or before `ms`, local time. */
function saturdayOnOrBefore(ms: number): number {
  const date = new Date(ms);
  const daysSinceSaturday = (date.getDay() - 6 + 7) % 7;
  return midnight(date.getFullYear(), date.getMonth(), date.getDate() - daysSinceSaturday);
}

/** The next Saturday 00:00 at or after `ms`, local time. */
function saturdayOnOrAfter(ms: number): number {
  const date = new Date(ms);
  const daysUntilSaturday = (6 - date.getDay() + 7) % 7;
  return midnight(date.getFullYear(), date.getMonth(), date.getDate() + daysUntilSaturday);
}

/** The weekend range starting at the given Saturday 00:00. */
function weekendFrom(saturdayStart: number): WeekendRange {
  const date = new Date(saturdayStart);
  return { start: saturdayStart, end: midnight(date.getFullYear(), date.getMonth(), date.getDate() + 2) };
}

/** The weekend range containing `ms`, or null when `ms` falls on a weekday. */
export function weekendAt(ms: number): WeekendRange | null {
  const range = weekendFrom(saturdayOnOrBefore(ms));
  return ms >= range.start && ms < range.end ? range : null;
}

/** The start of weekend coverage when the setting is turned on at `now`: that weekend's Saturday 00:00 if `now` falls inside one, otherwise `now` itself. */
export function coverageStartAt(now: number): number {
  return weekendAt(now)?.start ?? now;
}

/** Every weekend whose Saturday 00:00 is at or after `since` and at or before `now`, oldest first. */
export function weekendsDue(since: number, now: number): WeekendRange[] {
  const due: WeekendRange[] = [];
  let saturdayStart = saturdayOnOrAfter(since);
  while (saturdayStart <= now) {
    due.push(weekendFrom(saturdayStart));
    const date = new Date(saturdayStart);
    saturdayStart = midnight(date.getFullYear(), date.getMonth(), date.getDate() + 7);
  }
  return due;
}
