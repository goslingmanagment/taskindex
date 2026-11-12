/**
 * The dictionary: one word for one thing in every product (ecosystem plan §4
 * «Слова»). A screen, a message or a vendored client that names one of these
 * things takes the word from here; a new word for an old thing is a change of
 * this file, not of one screen.
 *
 * The forms that go with the words (plan §4): money «$1,234.56», dates
 * «12 нояб., 06:27», time is Moscow's and says so where the reader may be in
 * another zone («по Москве», see format.ts), the reader is addressed as «вы»
 * on every screen (Генгар in a chat speaks as he speaks), no long dash and no
 * arrows in what people read.
 */
/** The things of the agency's work, as a person reads them (capitalised; lower-case them inside a sentence). */
export declare const WORDS: {
    /** Money of the pages after the platform's commission, a Moscow day at a time. */
    readonly income: "Доход";
    /** One operation of a platform (a fan's purchase). */
    readonly sale: "Продажа";
    readonly sales: "Продажи";
    /** Money a fan spent: before the commission, always said so. */
    readonly fanSpend: "Траты фана";
    /** A chatter's work: from 2 h and 50 messages. */
    readonly shift: "Смена";
    readonly shifts: "Смены";
    /** Work shorter than a shift. */
    readonly visit: "Заход";
    /** What a chatter hands in after a shift, and the action of handing it in. */
    readonly shiftReport: "Отчёт смены";
    readonly submitShift: "Сдать смену";
    /** Money of a person. */
    readonly accrued: "Начислено";
    readonly toPay: "К выплате";
    readonly paid: "Выплачено";
    /** A fan's order for a shoot, and who leads it to delivery. */
    readonly custom: "Кастом";
    readonly customs: "Кастомы";
    readonly customsLead: "Ведущий кастомы";
    /** What waits for the person reading (in code: a matter). */
    readonly waitingForYou: "Ждут вас";
    /** Monday to Sunday, Moscow. */
    readonly week: "Неделя";
};
/** The places, by their own names. */
export declare const PLACES: {
    /** The owner's place. */
    readonly hub: "Hub";
    /** The team's place. */
    readonly workboard: "Workboard";
    /** The extension. */
    readonly chatgoose: "ChatGoose";
    /** The team's agent in Telegram. */
    readonly gengar: "Генгар";
};
/** The AI buttons: proper names, the same everywhere, never translated. */
export declare const AI_BUTTONS: readonly ["Reply", "Fix", "Hi", "Ping", "Recap", "Coach"];
export type AiButton = (typeof AI_BUTTONS)[number];
