/** Platform money: thousandths of a USD. */
export type Mills = bigint & {
    readonly __unit?: "mills";
};
/** AI-plane money: millionths of a USD (integer column, number in JS). */
export type MicroUsd = number & {
    readonly __unit?: "microUsd";
};
/** DB drivers hand mills back as bigint, number, or numeric-string. */
export type MillsLike = bigint | number | string;
/**
 * A value that is ALREADY mills — a DB column read (bigint / numeric-string)
 * or a mills-native platform integer (Fansly amounts are mills on the wire).
 * Numbers are truncated, strings parsed as integers — byte-identical to the
 * deleted `toMills`. (The spec sketched `millsFromDbBigint(bigint)`; pg
 * returns numeric columns as strings and adapters hand numbers, so ONE
 * honest already-mills constructor beats three near-duplicates.)
 */
export declare function millsFromInteger(value: MillsLike): Mills;
/**
 * Dollars (number or decimal string) → mills. Inherits `dollarsToMills`'s
 * parsing semantics byte-for-byte (fixed 3-place truncation of the fraction).
 */
export declare function millsFromDollars(value: number | string): Mills;
/** Whole cents → mills (the `total_tip_amount_cents` bridge: ×10 exactly). */
export declare function millsFromCents(value: number | bigint): Mills;
/**
 * Mills → whole cents, the way back over the same bridge (a reader of
 * `message_archive.tip_amount_mills` serving a `…Cents` field). Exact on
 * whole cents (the inverse of `millsFromCents`); a sub-cent rest rounds half
 * away from zero, as the legacy Fansly cents write rounds a mills amount.
 */
export declare function millsToWholeCents(value: MillsLike): number;
/** Dollars → micro-USD (AI plane). Rounded to the nearest integer micro-USD. */
export declare function microUsdFromDollars(value: number): MicroUsd;
/**
 * Cents as Anthropic's cost report writes them (decimal strings,
 * `"123.78912"` is $1.2378912) → micro-USD (1 cent = 10 000 micro-USD). The
 * amounts are added exactly and the total is rounded ONCE, half away from
 * zero, so a day of many fractional lines carries no per-line rounding.
 */
export declare function microUsdFromCents(amounts: readonly string[]): MicroUsd;
/** Dollars as the console's Cost CSV writes them ("6.10") → the same amount
 * in cents, a decimal string ("610"): the point moves, nothing is rounded. */
export declare function centsFromDollarsDecimal(value: string): string;
/** The exact sum of decimal cent strings, as a decimal string (several cost
 * lines that land on one stored line). */
export declare function sumCentsDecimals(amounts: readonly string[]): string;
/** An integer micro-USD value as stored (int column, number in JS). */
export declare function microUsdFromDbInt(value: number): MicroUsd;
/** Mills → micro-USD. Exact (×1000). */
export declare function millsToMicroUsd(value: Mills): MicroUsd;
/** Micro-USD → mills. LOSSY (truncates toward zero below the mill). */
export declare function microUsdToMills(value: MicroUsd): Mills;
/**
 * Micro-USD → a display string for the AI plane (the chatter's
 * own spend in `/account`). The AI ledger's unit is micro-USD, so the cabinet
 * must not divide by 1_000_000 by hand — it asks here, exactly as the platform
 * plane asks `formatUsdFromMills`. Sub-cent amounts round DOWN to `< $0.01`
 * rather than to `$0.00`, so a person who spent something never reads zero;
 * `approximate` prefixes the house `~` used by the owner's usage report.
 */
export declare function formatUsdFromMicroUsd(value: number, options?: {
    approximate?: boolean;
}): string;
export declare function millsToDecimalString(value: MillsLike): string;
export declare function formatUsdFromMills(value: MillsLike): string;
export declare function millsToNumber(value: MillsLike): number;
/** Mills → float dollars (wire fields that carry dollars, e.g. snapshot prices). */
export declare function millsToDollarsNumber(value: MillsLike): number;
/** Mills → whole dollars, rounded (telegram digest lines). */
export declare function millsToRoundedDollars(value: MillsLike): number;
/** A whole percent of an amount, rounded half away from zero (a chatter's part of a shared sale). */
export declare function millsPercentOf(value: MillsLike, percent: number): Mills;
/** An amount rounded half away from zero to whole cents or whole dollars (a payout-sheet cell). */
export declare function millsRoundedTo(value: MillsLike, unit: "cent" | "dollar"): Mills;
export declare function sumMills(values: Iterable<MillsLike>): Mills;
/**
 * Legacy name for the dollars constructor — same function, kept because the
 * name is honest (its ~80 call sites predate the codec). New code should
 * prefer `millsFromDollars`.
 */
export declare const dollarsToMills: typeof millsFromDollars;
export declare function calculateNetMillsFromGross(grossMills: MillsLike, commissionRate: number): Mills;
export declare function calculateGrossMillsFromNet(netMills: MillsLike, commissionRate: number): Mills;
