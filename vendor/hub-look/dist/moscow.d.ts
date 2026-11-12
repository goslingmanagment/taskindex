/**
 * Moscow days. The agency's day is Moscow midnight to midnight: the shifts, the
 * payout sheet and every money-by-day number in Hub are cut on it. A day here is
 * a calendar date, `YYYY-MM-DD`, and its arithmetic never goes through the
 * browser's own time zone.
 */
import { MOSCOW_TIME_ZONE } from "./shared/index.js";
export { MOSCOW_TIME_ZONE };
/** A calendar date in Moscow: `YYYY-MM-DD`. */
export type MoscowDay = string;
export declare function isMoscowDay(value: string | null | undefined): value is MoscowDay;
/** Today in Moscow. */
export declare function moscowToday(now?: Date): MoscowDay;
/** The Moscow day an instant falls on. */
export declare function moscowDayOf(at: string | number | Date): MoscowDay;
/** The day `days` after (or before, negative) a day. */
export declare function addDays(day: MoscowDay, days: number): MoscowDay;
/**
 * Days from `from` to `to`, both counted: 2 → 8 Nov is 7. With `until` (today),
 * `to` stops there: a week going on, on its Saturday, is 6 days so far; a range
 * that has not begun by `until` is 0.
 */
export declare function daysInRange(from: MoscowDay, to: MoscowDay, until?: MoscowDay): number;
/** 0 for Monday … 6 for Sunday: a Moscow week starts on Monday. */
export declare function weekdayIndex(day: MoscowDay): number;
/** The Monday of the week a day belongs to. */
export declare function mondayOf(day: MoscowDay): MoscowDay;
/** The instant a Moscow day starts at, as ISO: `2026-11-02` → `2026-11-01T21:00:00.000Z`. */
export declare function moscowDayStart(day: MoscowDay): string;
/** The instant a Moscow day ends at (the next day's start, excluded). */
export declare function moscowDayEnd(day: MoscowDay): string;
