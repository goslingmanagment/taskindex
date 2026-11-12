/**
 * Moscow days. The agency's day is Moscow midnight to midnight: the shifts, the
 * payout sheet and every money-by-day number in Hub are cut on it. A day here is
 * a calendar date, `YYYY-MM-DD`, and its arithmetic never goes through the
 * browser's own time zone.
 */
import { MOSCOW_TIME_ZONE, businessDateToUtcStart, isValidBusinessDateString, parseBusinessDate, toBusinessDate, } from "./shared/index.js";
export { MOSCOW_TIME_ZONE };
export function isMoscowDay(value) {
    return typeof value === "string" && isValidBusinessDateString(value);
}
/** Today in Moscow. */
export function moscowToday(now = new Date()) {
    return toBusinessDate(now, MOSCOW_TIME_ZONE);
}
/** The Moscow day an instant falls on. */
export function moscowDayOf(at) {
    return toBusinessDate(new Date(at), MOSCOW_TIME_ZONE);
}
/** The day `days` after (or before, negative) a day. */
export function addDays(day, days) {
    const { year, month, day: date } = parseBusinessDate(day);
    const shifted = new Date(Date.UTC(year, month - 1, date + days));
    return shifted.toISOString().slice(0, 10);
}
/**
 * Days from `from` to `to`, both counted: 2 → 8 Nov is 7. With `until` (today),
 * `to` stops there: a week going on, on its Saturday, is 6 days so far; a range
 * that has not begun by `until` is 0.
 */
export function daysInRange(from, to, until) {
    const last = until !== undefined && to > until ? until : to;
    if (until !== undefined && from > last)
        return 0;
    const start = parseBusinessDate(from);
    const end = parseBusinessDate(last);
    const span = Date.UTC(end.year, end.month - 1, end.day) - Date.UTC(start.year, start.month - 1, start.day);
    return Math.round(span / 86_400_000) + 1;
}
/** 0 for Monday … 6 for Sunday: a Moscow week starts on Monday. */
export function weekdayIndex(day) {
    const { year, month, day: date } = parseBusinessDate(day);
    return (new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 6) % 7;
}
/** The Monday of the week a day belongs to. */
export function mondayOf(day) {
    return addDays(day, -weekdayIndex(day));
}
/** The instant a Moscow day starts at, as ISO: `2026-11-02` → `2026-11-01T21:00:00.000Z`. */
export function moscowDayStart(day) {
    return businessDateToUtcStart(day, MOSCOW_TIME_ZONE).toISOString();
}
/** The instant a Moscow day ends at (the next day's start, excluded). */
export function moscowDayEnd(day) {
    return moscowDayStart(addDays(day, 1));
}
