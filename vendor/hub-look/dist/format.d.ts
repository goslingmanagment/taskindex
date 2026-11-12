/**
 * The one set of formats (ecosystem plan §4): money «$1,234.56» as Hub has always
 * printed it (packages/shared/src/money.ts underneath, a real minus on top),
 * counts and percents the Russian way («9 840», «2,5 %»), dates «12 нояб., 06:27»,
 * ranges «28 окт. – 3 нояб.», durations «5 ч 7 мин», all in Moscow time. Pure
 * functions without React: the console and Workboard read them through
 * `@agency_hub_core/ui/format`, the runtime and the vendored clients directly.
 */
import { type MillsLike } from "./shared/index.js";
/** «$11,183.60», «−$2,193.64»: always the cents. A sum made by `sumMills` goes in as is. */
export declare function formatMills(mills: MillsLike): string;
export declare function formatUsdFromCents(cents: number): string;
/** «+$880.00», «−$222.86», «$0.00». */
export declare function formatSignedMills(mills: MillsLike): string;
/**
 * «29 %», «< 1 %», «0 %». `precise`: one decimal below 10, for a share or a
 * conversion in a column: «2,5 %». Whole otherwise.
 */
export declare function formatPercent(value: number, options?: {
    precise?: boolean;
}): string;
/** «+64 %», «−4 %», «0 %». Always whole, no arrows. */
export declare function formatSignedPercent(value: number): string;
/**
 * The change against the last period: «+$4,104.21 (+64 %)», «−$222.86 (−4 %)». Growth
 * from zero has no percent: «+$880.00». Nothing to compare with: «—».
 */
export declare function formatChange(mills: MillsLike | null | undefined, pct: number | null | undefined): string;
/** Which way a change went, for its colour. */
export declare function changeDirection(mills: MillsLike | null | undefined): "up" | "down" | "flat";
/** «1 420», «9 840», a real zero «0», no data «—». */
export declare function formatCount(value: number | null | undefined): string;
/** The AI's money: «$39.88», «< $0.01», «$0.00», «−$1.20». */
export declare function formatAiUsd(microUsd: number): string;
/** The price of one AI call, only in the column «За вызов»: «$0.004». */
export declare function formatAiUnitPrice(microUsd: number): string;
export declare function formatDate(iso: string, options?: {
    includeYear?: boolean;
}): string;
/** "4 окт., 12:01". `yearUnlessCurrent`: an instant of another year carries it
 *  ("30 авг. 2025 г., 11:59") — a date without one reads as this year's. */
export declare function formatDateTime(iso: string, options?: {
    yearUnlessCurrent?: boolean;
}): string;
/** «только что», «5 мин назад», «2 ч назад», «3 дня назад»: only next to the exact time. */
export declare function formatAgo(at: string | number | Date, now?: number): string;
export declare function formatRelativeTime(iso: string): string;
export declare function transactionTypeLabel(type: string): string;
export declare function daysRemaining(expiresIso: string): number;
export declare function formatBusinessDateShort(bd: string): string;
export declare function formatBusinessDateMonth(bd: string): string;
export type UsagePeriod = "day" | "week" | "month";
/** Get Monday of the ISO week containing the given business date. */
export declare function weekStart(date: string): string;
/** Get Sunday of the ISO week containing the given business date. */
export declare function weekEnd(date: string): string;
/** First day of the month containing the given business date. */
export declare function monthStart(date: string): string;
/** Last day of the month containing the given business date. */
export declare function monthEnd(date: string): string;
/** Compute the {from, to} range for the given period around the anchor date. */
export declare function usageRange(anchor: string, mode: UsagePeriod): {
    from: string;
    to: string;
};
/** Shift anchor date by one period step. */
export declare function shiftAnchor(anchor: string, mode: UsagePeriod, direction: -1 | 1): string;
/** Human-readable label for the current date/range based on period mode. */
export declare function usageDateLabel(anchor: string, mode: UsagePeriod): string;
/** «3 нояб.» */
export declare function formatDay(value: string | number | Date): string;
/** «вт, 3 нояб.»: shifts, charts, a day in a schedule. */
export declare function formatWeekdayDay(value: string | number | Date): string;
/** «21–27 окт.», «28 окт. – 3 нояб.», «3 нояб.». `to` is the last day included. */
export declare function formatDayRange(from: string | number | Date, to: string | number | Date): string;
/** The same for a window whose end is exclusive: a report's `[from, to)`, Moscow days. */
export declare function formatWindowRange(from: string, toExclusive: string): string;
/**
 * «5 ч 7 мин», «3 ч», «40 мин». Hours of work are never days: «669 ч 30 мин».
 * `days`, for how long something has been so: «2 дня 4 ч».
 */
export declare function formatDuration(minutes: number, options?: {
    days?: boolean;
}): string;
/** «40 с», on technical screens only; from a minute on as `formatDuration`. */
export declare function formatSeconds(seconds: number): string;
/** «23:41» по Москве. */
export declare function formatTimeOfDay(at: string | number | Date): string;
/**
 * How a time says it is Moscow's where the reader may live in another zone (the
 * extension, a message): «по Москве». Hub's own screens are all Moscow and say it
 * once, not on every time.
 */
export declare const MOSCOW_LABEL = "\u043F\u043E \u041C\u043E\u0441\u043A\u0432\u0435";
/** «06:27 по Москве». */
export declare function formatTimeMsk(at: string | number | Date): string;
/** «12 нояб., 06:27 по Москве»; another year carries it. */
export declare function formatDateTimeMsk(at: string | number | Date): string;
/** «Обновлено в 23:41, 5 мин назад». */
export declare function formatUpdated(at: string | number | Date, now?: number): string;
/** «Проверено в 23:41, 5 мин назад»: when Hub was read, on data that no longer changes. */
export declare function formatChecked(at: string | number | Date, now?: number): string;
/** «3 нояб., 14:05, 2 ч назад»; a moment of today: «14:05, 5 мин назад». */
export declare function formatMomentAgo(at: string | number | Date, now?: number): string;
/**
 * A short phrase that must not break across lines: «2 из 3», «39 с», «7 ч 28 мин».
 * Every ordinary space becomes a no-break one. For the screen only (a copied
 * text, a payout sheet keep their own spaces).
 */
export declare function unbreakable(text: string): string;
/** «2 из 3» that never breaks: a part of a whole, in counts («1 420 из 9 840»). */
export declare function formatOf(part: number, whole: number): string;
