/**
 * The design token VALUES of Hub's look, as data: one source for every place
 * that draws with them. A sheet of paper and ink (design-language 2026-11-03):
 * a warm grey ground, a white sheet with hairlines, black exact numbers, blue
 * ink only where something is current or waits for a person. Colour is an event.
 *
 * Two copies exist in Hub and both are GENERATED from here (`node --import tsx/esm
 * packages/look/generate.ts`; CI checks they are fresh):
 *   - packages/ui/src/styles/tokens.css   `--ui-*`, Workboard and the shared components;
 *   - apps/dashboard/src/styles/tokens.css `--color-*` and the type scale under
 *     Tailwind's `@theme static`, the console.
 * Other repositories take the values through `scripts/vendor-look.mjs` (the
 * extension keeps its own dock palette; ContentOps and TaskIndex keep their
 * component names and take the values).
 *
 * A colour is written for both themes: `[light, dark]`. Text clears 4.5:1 on its
 * own ground in both themes (the console's checked values). A token names its
 * place in each copy: `ui` (`--ui-<name>`), `console` (`--color-<name>`); a token
 * without a name in a copy is not in it. Changing a value here changes every copy;
 * renaming changes nothing anyone sees and breaks the apps that read the name.
 */
/** `[light, dark]`, or one value for both themes. */
export type ThemeValue = readonly [light: string, dark: string] | string;
export interface ColorToken {
    value: ThemeValue;
    /** The name after `--ui-` in Workboard's copy; absent: not in that copy. */
    ui?: string;
    /** The name after `--color-` in the console's copy; absent: not in that copy. */
    console?: string;
    /** What the colour is for. */
    note: string;
}
/**
 * The colours, in the order the copies list them. Grouped by what they mean;
 * the console's few legacy names sit at the end until its last old screen moves.
 */
export declare const COLORS: {
    readonly bg: {
        readonly value: ThemeValue;
        readonly ui: "bg";
        readonly console: "bg";
        readonly note: "The ground.";
    };
    readonly surface: {
        readonly value: ThemeValue;
        readonly ui: "surface";
        readonly console: "card";
        readonly note: "The sheet: a card, a table.";
    };
    readonly raised: {
        readonly value: ThemeValue;
        readonly ui: "raised";
        readonly console: "raised";
        readonly note: "A menu, a window, a tooltip: raised over the sheet.";
    };
    readonly hover: {
        readonly value: ThemeValue;
        readonly ui: "hover";
        readonly console: "hover";
        readonly note: "A control under the pointer.";
    };
    readonly hoverSoft: {
        readonly value: ThemeValue;
        readonly ui: "hover-soft";
        readonly console: "hover-alt";
        readonly note: "A row under the pointer: quieter than a button's hover.";
    };
    readonly active: {
        readonly value: ThemeValue;
        readonly ui: "active";
        readonly console: "active-bg";
        readonly note: "The current item of the menu, the avatar.";
    };
    readonly track: {
        readonly value: ThemeValue;
        readonly ui: "track";
        readonly console: "track";
        readonly note: "The track of a segmented control.";
    };
    readonly picked: {
        readonly value: ThemeValue;
        readonly ui: "picked";
        readonly console: "picked";
        readonly note: "The picked segment on its track.";
    };
    readonly line: {
        readonly value: ThemeValue;
        readonly ui: "line";
        readonly console: "border";
        readonly note: "A hairline.";
    };
    readonly lineSoft: {
        readonly value: ThemeValue;
        readonly ui: "line-soft";
        readonly console: "border-light";
        readonly note: "A hairline inside a sheet.";
    };
    readonly lineStrong: {
        readonly value: ThemeValue;
        readonly ui: "line-strong";
        readonly console: "border-strong";
        readonly note: "A field's border.";
    };
    readonly text: {
        readonly value: ThemeValue;
        readonly ui: "text";
        readonly console: "text-primary";
        readonly note: "Text, numbers.";
    };
    readonly text2: {
        readonly value: ThemeValue;
        readonly ui: "text-2";
        readonly console: "text-secondary";
        readonly note: "Secondary text.";
    };
    readonly text3: {
        readonly value: ThemeValue;
        readonly ui: "text-3";
        readonly console: "text-muted";
        readonly note: "Quiet text: a hint, a header of a column.";
    };
    readonly backdrop: {
        readonly value: ThemeValue;
        readonly ui: "backdrop";
        readonly console: "backdrop";
        readonly note: "Under a window.";
    };
    readonly veil: {
        readonly value: ThemeValue;
        readonly ui: "veil";
        readonly note: "Under a side panel: lighter than a window's, the page stays readable.";
    };
    readonly accent: {
        readonly value: ThemeValue;
        readonly ui: "accent";
        readonly console: "accent";
        readonly note: "Ink: the current place, a link, focus.";
    };
    readonly accentHover: {
        readonly value: ThemeValue;
        readonly console: "accent-hover";
        readonly note: "Ink under the pointer (the console's links).";
    };
    readonly accentFill: {
        readonly value: ThemeValue;
        readonly ui: "accent-fill";
        readonly console: "accent-fill";
        readonly note: "The main button.";
    };
    readonly accentFillHover: {
        readonly value: ThemeValue;
        readonly ui: "accent-fill-hover";
        readonly console: "accent-fill-hover";
        readonly note: "The main button under the pointer.";
    };
    readonly accentSoft: {
        readonly value: ThemeValue;
        readonly ui: "accent-soft";
        readonly console: "accent-soft";
        readonly note: "The ground of a selected row.";
    };
    readonly accentLine: {
        readonly value: ThemeValue;
        readonly ui: "accent-line";
        readonly console: "accent-border";
        readonly note: "The line around what is selected.";
    };
    readonly onFill: {
        readonly value: "#ffffff";
        readonly ui: "on-fill";
        readonly console: "on-fill";
        readonly note: "Text on a filled button.";
    };
    readonly good: {
        readonly value: ThemeValue;
        readonly ui: "good";
        readonly console: "green";
        readonly note: "Good: a small green dot.";
    };
    readonly goodText: {
        readonly value: ThemeValue;
        readonly ui: "good-text";
        readonly console: "success-text";
        readonly note: "Good: a dark-green word.";
    };
    readonly goodSoft: {
        readonly value: ThemeValue;
        readonly ui: "good-soft";
        readonly console: "success-soft";
        readonly note: "Good: a soft ground.";
    };
    readonly goodLine: {
        readonly value: ThemeValue;
        readonly ui: "good-line";
        readonly console: "success-border";
        readonly note: "Good: its line.";
    };
    readonly warn: {
        readonly value: ThemeValue;
        readonly ui: "warn";
        readonly console: "warning";
        readonly note: "Attention: not broken, worth a look.";
    };
    readonly warnText: {
        readonly value: ThemeValue;
        readonly ui: "warn-text";
        readonly console: "warning-text";
        readonly note: "Attention: its word.";
    };
    readonly warnSoft: {
        readonly value: ThemeValue;
        readonly ui: "warn-soft";
        readonly console: "warning-soft";
        readonly note: "Attention: a soft ground.";
    };
    readonly warnLine: {
        readonly value: ThemeValue;
        readonly ui: "warn-line";
        readonly console: "warning-border";
        readonly note: "Attention: its line.";
    };
    readonly bad: {
        readonly value: ThemeValue;
        readonly ui: "bad";
        readonly console: "danger";
        readonly note: "Error: broken, a person must act.";
    };
    readonly badText: {
        readonly value: ThemeValue;
        readonly ui: "bad-text";
        readonly console: "danger-text";
        readonly note: "Error: its word.";
    };
    readonly badSoft: {
        readonly value: ThemeValue;
        readonly ui: "bad-soft";
        readonly console: "danger-soft";
        readonly note: "Error: a soft ground.";
    };
    readonly badLine: {
        readonly value: ThemeValue;
        readonly ui: "bad-line";
        readonly console: "danger-border";
        readonly note: "Error: its line.";
    };
    readonly dangerFill: {
        readonly value: ThemeValue;
        readonly ui: "danger-fill";
        readonly console: "danger-fill";
        readonly note: "A button that deletes or ends something.";
    };
    readonly dangerFillHover: {
        readonly value: ThemeValue;
        readonly ui: "danger-fill-hover";
        readonly console: "danger-fill-hover";
        readonly note: "That button under the pointer.";
    };
    readonly up: {
        readonly value: ThemeValue;
        readonly ui: "up";
        readonly console: "up";
        readonly note: "Better than the period before.";
    };
    readonly down: {
        readonly value: ThemeValue;
        readonly ui: "down";
        readonly console: "down";
        readonly note: "Worse than the period before.";
    };
    readonly markSoft: {
        readonly value: ThemeValue;
        readonly ui: "mark-soft";
        readonly note: "An outlier: its ground.";
    };
    readonly markText: {
        readonly value: ThemeValue;
        readonly ui: "mark-text";
        readonly note: "An outlier: its word.";
    };
    readonly markBar: {
        readonly value: ThemeValue;
        readonly ui: "mark-bar";
        readonly note: "A bar worse than the team: the same warmth, never a bright gold in the dark.";
    };
    readonly series1: {
        readonly value: ThemeValue;
        readonly ui: "series-1";
        readonly console: "chart-blue";
        readonly note: "Series 1.";
    };
    readonly series2: {
        readonly value: ThemeValue;
        readonly ui: "series-2";
        readonly console: "chart-orange";
        readonly note: "Series 2.";
    };
    readonly series3: {
        readonly value: ThemeValue;
        readonly ui: "series-3";
        readonly console: "chart-aqua";
        readonly note: "Series 3.";
    };
    readonly series4: {
        readonly value: ThemeValue;
        readonly ui: "series-4";
        readonly console: "chart-violet";
        readonly note: "Series 4.";
    };
    readonly series5: {
        readonly value: ThemeValue;
        readonly ui: "series-5";
        readonly console: "chart-magenta";
        readonly note: "Series 5.";
    };
    readonly series6: {
        readonly value: ThemeValue;
        readonly ui: "series-6";
        readonly console: "chart-lime";
        readonly note: "Series 6.";
    };
    readonly seriesGreen: {
        readonly value: ThemeValue;
        readonly console: "chart-green";
        readonly note: "The console's seventh series.";
    };
    readonly seriesCompare: {
        readonly value: ThemeValue;
        readonly ui: "series-compare";
        readonly console: "chart-compare";
        readonly note: "The last period's line, the team's mark on a bar.";
    };
    readonly fansly: {
        readonly value: ThemeValue;
        readonly console: "fansly";
        readonly note: "Legacy: Fansly's tint.";
    };
    readonly fanslySoft: {
        readonly value: ThemeValue;
        readonly console: "fansly-soft";
        readonly note: "Legacy: Fansly's soft tint.";
    };
    readonly onlyfans: {
        readonly value: ThemeValue;
        readonly console: "onlyfans";
        readonly note: "Legacy: OnlyFans's tint.";
    };
    readonly onlyfansSoft: {
        readonly value: ThemeValue;
        readonly console: "onlyfans-soft";
        readonly note: "Legacy: OnlyFans's soft tint.";
    };
    readonly telegram: {
        readonly value: ThemeValue;
        readonly console: "telegram";
        readonly note: "Legacy: Telegram's tint.";
    };
    readonly telegramSoft: {
        readonly value: ThemeValue;
        readonly console: "telegram-soft";
        readonly note: "Legacy: Telegram's soft tint.";
    };
    readonly warningDark: {
        readonly value: ThemeValue;
        readonly console: "warning-dark";
        readonly note: "Legacy: the same as warnText.";
    };
    readonly onAccent: {
        readonly value: ThemeValue;
        readonly console: "on-accent";
        readonly note: "Legacy: text on `bg-accent`.";
    };
    readonly onDanger: {
        readonly value: ThemeValue;
        readonly console: "on-danger";
        readonly note: "Legacy: text on a danger fill.";
    };
    readonly dangerHover: {
        readonly value: ThemeValue;
        readonly console: "danger-hover";
        readonly note: "Legacy: danger under the pointer.";
    };
};
export type ColorName = keyof typeof COLORS;
/** Inter 400/500/600, the system's sans after it. */
export declare const FONT: {
    readonly family: "\"Inter\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif";
    readonly weightBold: 600;
};
/**
 * The one type scale: size → line height, in px. Nothing below 13 px; 13 only for
 * axes, heat maps and keys.
 */
export declare const TYPE_SCALE: {
    readonly 13: 18;
    readonly 14: 20;
    readonly 15: 22;
    readonly 16: 24;
    readonly 17: 24;
    readonly 20: 28;
    readonly 24: 32;
    readonly 28: 36;
    readonly 32: 40;
    readonly 40: 48;
};
export type TypeSize = keyof typeof TYPE_SCALE;
/** The sizes Workboard names `--ui-fs-<size>` / `--ui-lh-<size>`. */
export declare const UI_TYPE_SIZES: readonly TypeSize[];
/** The console's Tailwind names (`text-<name>`) and the size each one is. */
export declare const CONSOLE_TYPE_SIZES: Readonly<Record<string, TypeSize>>;
/** Long reading (a conversation): 16 on 26; a line of reading never wider than 72ch. */
export declare const READING: {
    readonly lineHeight: 26;
    readonly measure: "72ch";
};
/** Space: 4 8 12 16 24 32 48 64, nothing else. The key is the step (`--ui-space-<step>`). */
export declare const SPACE: {
    readonly 1: 4;
    readonly 2: 8;
    readonly 3: 12;
    readonly 4: 16;
    readonly 6: 24;
    readonly 8: 32;
    readonly 12: 48;
    readonly 16: 64;
};
/** Corners, px: inner (a badge, a field's part), a control, a card. */
export declare const RADIUS: {
    readonly inner: 6;
    readonly control: 8;
    readonly card: 12;
};
/** Heights of a control, px. */
export declare const CONTROL: {
    readonly sm: 32;
    readonly md: 36;
    readonly lg: 44;
};
/** Almost no shadows: a sheet has none. `floatRing` is Workboard's hairline around a float. */
export declare const SHADOW: {
    readonly raised: "0 1px 2px light-dark(rgb(28 25 23 / 0.1), rgb(0 0 0 / 0.4))";
    readonly float: "0 8px 24px light-dark(rgb(28 25 23 / 0.12), rgb(0 0 0 / 0.5))";
    readonly floatRing: "0 0 0 1px light-dark(rgb(28 25 23 / 0.04), rgb(255 255 255 / 0.04))";
};
/** Keyboard focus: 2 px of ink, 2 px away. */
export declare const FOCUS: {
    readonly width: 2;
    readonly offset: 2;
};
/** Motion: a colour change, a panel sliding in. Nothing else moves. */
export declare const MOTION: {
    readonly fast: "150ms";
    readonly slide: "200ms";
};
/** Layers. */
export declare const LAYERS: {
    readonly sticky: 4;
    readonly header: 5;
    readonly drawer: 10;
    readonly menu: 20;
    readonly modal: 30;
    readonly toast: 40;
    readonly tooltip: 50;
};
/** Every value above in one object: what `tokens.json` of a vendored copy holds. */
export declare const TOKENS: {
    readonly colors: {
        readonly bg: {
            readonly value: ThemeValue;
            readonly ui: "bg";
            readonly console: "bg";
            readonly note: "The ground.";
        };
        readonly surface: {
            readonly value: ThemeValue;
            readonly ui: "surface";
            readonly console: "card";
            readonly note: "The sheet: a card, a table.";
        };
        readonly raised: {
            readonly value: ThemeValue;
            readonly ui: "raised";
            readonly console: "raised";
            readonly note: "A menu, a window, a tooltip: raised over the sheet.";
        };
        readonly hover: {
            readonly value: ThemeValue;
            readonly ui: "hover";
            readonly console: "hover";
            readonly note: "A control under the pointer.";
        };
        readonly hoverSoft: {
            readonly value: ThemeValue;
            readonly ui: "hover-soft";
            readonly console: "hover-alt";
            readonly note: "A row under the pointer: quieter than a button's hover.";
        };
        readonly active: {
            readonly value: ThemeValue;
            readonly ui: "active";
            readonly console: "active-bg";
            readonly note: "The current item of the menu, the avatar.";
        };
        readonly track: {
            readonly value: ThemeValue;
            readonly ui: "track";
            readonly console: "track";
            readonly note: "The track of a segmented control.";
        };
        readonly picked: {
            readonly value: ThemeValue;
            readonly ui: "picked";
            readonly console: "picked";
            readonly note: "The picked segment on its track.";
        };
        readonly line: {
            readonly value: ThemeValue;
            readonly ui: "line";
            readonly console: "border";
            readonly note: "A hairline.";
        };
        readonly lineSoft: {
            readonly value: ThemeValue;
            readonly ui: "line-soft";
            readonly console: "border-light";
            readonly note: "A hairline inside a sheet.";
        };
        readonly lineStrong: {
            readonly value: ThemeValue;
            readonly ui: "line-strong";
            readonly console: "border-strong";
            readonly note: "A field's border.";
        };
        readonly text: {
            readonly value: ThemeValue;
            readonly ui: "text";
            readonly console: "text-primary";
            readonly note: "Text, numbers.";
        };
        readonly text2: {
            readonly value: ThemeValue;
            readonly ui: "text-2";
            readonly console: "text-secondary";
            readonly note: "Secondary text.";
        };
        readonly text3: {
            readonly value: ThemeValue;
            readonly ui: "text-3";
            readonly console: "text-muted";
            readonly note: "Quiet text: a hint, a header of a column.";
        };
        readonly backdrop: {
            readonly value: ThemeValue;
            readonly ui: "backdrop";
            readonly console: "backdrop";
            readonly note: "Under a window.";
        };
        readonly veil: {
            readonly value: ThemeValue;
            readonly ui: "veil";
            readonly note: "Under a side panel: lighter than a window's, the page stays readable.";
        };
        readonly accent: {
            readonly value: ThemeValue;
            readonly ui: "accent";
            readonly console: "accent";
            readonly note: "Ink: the current place, a link, focus.";
        };
        readonly accentHover: {
            readonly value: ThemeValue;
            readonly console: "accent-hover";
            readonly note: "Ink under the pointer (the console's links).";
        };
        readonly accentFill: {
            readonly value: ThemeValue;
            readonly ui: "accent-fill";
            readonly console: "accent-fill";
            readonly note: "The main button.";
        };
        readonly accentFillHover: {
            readonly value: ThemeValue;
            readonly ui: "accent-fill-hover";
            readonly console: "accent-fill-hover";
            readonly note: "The main button under the pointer.";
        };
        readonly accentSoft: {
            readonly value: ThemeValue;
            readonly ui: "accent-soft";
            readonly console: "accent-soft";
            readonly note: "The ground of a selected row.";
        };
        readonly accentLine: {
            readonly value: ThemeValue;
            readonly ui: "accent-line";
            readonly console: "accent-border";
            readonly note: "The line around what is selected.";
        };
        readonly onFill: {
            readonly value: "#ffffff";
            readonly ui: "on-fill";
            readonly console: "on-fill";
            readonly note: "Text on a filled button.";
        };
        readonly good: {
            readonly value: ThemeValue;
            readonly ui: "good";
            readonly console: "green";
            readonly note: "Good: a small green dot.";
        };
        readonly goodText: {
            readonly value: ThemeValue;
            readonly ui: "good-text";
            readonly console: "success-text";
            readonly note: "Good: a dark-green word.";
        };
        readonly goodSoft: {
            readonly value: ThemeValue;
            readonly ui: "good-soft";
            readonly console: "success-soft";
            readonly note: "Good: a soft ground.";
        };
        readonly goodLine: {
            readonly value: ThemeValue;
            readonly ui: "good-line";
            readonly console: "success-border";
            readonly note: "Good: its line.";
        };
        readonly warn: {
            readonly value: ThemeValue;
            readonly ui: "warn";
            readonly console: "warning";
            readonly note: "Attention: not broken, worth a look.";
        };
        readonly warnText: {
            readonly value: ThemeValue;
            readonly ui: "warn-text";
            readonly console: "warning-text";
            readonly note: "Attention: its word.";
        };
        readonly warnSoft: {
            readonly value: ThemeValue;
            readonly ui: "warn-soft";
            readonly console: "warning-soft";
            readonly note: "Attention: a soft ground.";
        };
        readonly warnLine: {
            readonly value: ThemeValue;
            readonly ui: "warn-line";
            readonly console: "warning-border";
            readonly note: "Attention: its line.";
        };
        readonly bad: {
            readonly value: ThemeValue;
            readonly ui: "bad";
            readonly console: "danger";
            readonly note: "Error: broken, a person must act.";
        };
        readonly badText: {
            readonly value: ThemeValue;
            readonly ui: "bad-text";
            readonly console: "danger-text";
            readonly note: "Error: its word.";
        };
        readonly badSoft: {
            readonly value: ThemeValue;
            readonly ui: "bad-soft";
            readonly console: "danger-soft";
            readonly note: "Error: a soft ground.";
        };
        readonly badLine: {
            readonly value: ThemeValue;
            readonly ui: "bad-line";
            readonly console: "danger-border";
            readonly note: "Error: its line.";
        };
        readonly dangerFill: {
            readonly value: ThemeValue;
            readonly ui: "danger-fill";
            readonly console: "danger-fill";
            readonly note: "A button that deletes or ends something.";
        };
        readonly dangerFillHover: {
            readonly value: ThemeValue;
            readonly ui: "danger-fill-hover";
            readonly console: "danger-fill-hover";
            readonly note: "That button under the pointer.";
        };
        readonly up: {
            readonly value: ThemeValue;
            readonly ui: "up";
            readonly console: "up";
            readonly note: "Better than the period before.";
        };
        readonly down: {
            readonly value: ThemeValue;
            readonly ui: "down";
            readonly console: "down";
            readonly note: "Worse than the period before.";
        };
        readonly markSoft: {
            readonly value: ThemeValue;
            readonly ui: "mark-soft";
            readonly note: "An outlier: its ground.";
        };
        readonly markText: {
            readonly value: ThemeValue;
            readonly ui: "mark-text";
            readonly note: "An outlier: its word.";
        };
        readonly markBar: {
            readonly value: ThemeValue;
            readonly ui: "mark-bar";
            readonly note: "A bar worse than the team: the same warmth, never a bright gold in the dark.";
        };
        readonly series1: {
            readonly value: ThemeValue;
            readonly ui: "series-1";
            readonly console: "chart-blue";
            readonly note: "Series 1.";
        };
        readonly series2: {
            readonly value: ThemeValue;
            readonly ui: "series-2";
            readonly console: "chart-orange";
            readonly note: "Series 2.";
        };
        readonly series3: {
            readonly value: ThemeValue;
            readonly ui: "series-3";
            readonly console: "chart-aqua";
            readonly note: "Series 3.";
        };
        readonly series4: {
            readonly value: ThemeValue;
            readonly ui: "series-4";
            readonly console: "chart-violet";
            readonly note: "Series 4.";
        };
        readonly series5: {
            readonly value: ThemeValue;
            readonly ui: "series-5";
            readonly console: "chart-magenta";
            readonly note: "Series 5.";
        };
        readonly series6: {
            readonly value: ThemeValue;
            readonly ui: "series-6";
            readonly console: "chart-lime";
            readonly note: "Series 6.";
        };
        readonly seriesGreen: {
            readonly value: ThemeValue;
            readonly console: "chart-green";
            readonly note: "The console's seventh series.";
        };
        readonly seriesCompare: {
            readonly value: ThemeValue;
            readonly ui: "series-compare";
            readonly console: "chart-compare";
            readonly note: "The last period's line, the team's mark on a bar.";
        };
        readonly fansly: {
            readonly value: ThemeValue;
            readonly console: "fansly";
            readonly note: "Legacy: Fansly's tint.";
        };
        readonly fanslySoft: {
            readonly value: ThemeValue;
            readonly console: "fansly-soft";
            readonly note: "Legacy: Fansly's soft tint.";
        };
        readonly onlyfans: {
            readonly value: ThemeValue;
            readonly console: "onlyfans";
            readonly note: "Legacy: OnlyFans's tint.";
        };
        readonly onlyfansSoft: {
            readonly value: ThemeValue;
            readonly console: "onlyfans-soft";
            readonly note: "Legacy: OnlyFans's soft tint.";
        };
        readonly telegram: {
            readonly value: ThemeValue;
            readonly console: "telegram";
            readonly note: "Legacy: Telegram's tint.";
        };
        readonly telegramSoft: {
            readonly value: ThemeValue;
            readonly console: "telegram-soft";
            readonly note: "Legacy: Telegram's soft tint.";
        };
        readonly warningDark: {
            readonly value: ThemeValue;
            readonly console: "warning-dark";
            readonly note: "Legacy: the same as warnText.";
        };
        readonly onAccent: {
            readonly value: ThemeValue;
            readonly console: "on-accent";
            readonly note: "Legacy: text on `bg-accent`.";
        };
        readonly onDanger: {
            readonly value: ThemeValue;
            readonly console: "on-danger";
            readonly note: "Legacy: text on a danger fill.";
        };
        readonly dangerHover: {
            readonly value: ThemeValue;
            readonly console: "danger-hover";
            readonly note: "Legacy: danger under the pointer.";
        };
    };
    readonly font: {
        readonly family: "\"Inter\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif";
        readonly weightBold: 600;
    };
    readonly typeScale: {
        readonly 13: 18;
        readonly 14: 20;
        readonly 15: 22;
        readonly 16: 24;
        readonly 17: 24;
        readonly 20: 28;
        readonly 24: 32;
        readonly 28: 36;
        readonly 32: 40;
        readonly 40: 48;
    };
    readonly uiTypeSizes: readonly (20 | 24 | 28 | 32 | 40 | 13 | 14 | 15 | 16 | 17)[];
    readonly consoleTypeSizes: Readonly<Record<string, 20 | 24 | 28 | 32 | 40 | 13 | 14 | 15 | 16 | 17>>;
    readonly reading: {
        readonly lineHeight: 26;
        readonly measure: "72ch";
    };
    readonly space: {
        readonly 1: 4;
        readonly 2: 8;
        readonly 3: 12;
        readonly 4: 16;
        readonly 6: 24;
        readonly 8: 32;
        readonly 12: 48;
        readonly 16: 64;
    };
    readonly radius: {
        readonly inner: 6;
        readonly control: 8;
        readonly card: 12;
    };
    readonly control: {
        readonly sm: 32;
        readonly md: 36;
        readonly lg: 44;
    };
    readonly shadow: {
        readonly raised: "0 1px 2px light-dark(rgb(28 25 23 / 0.1), rgb(0 0 0 / 0.4))";
        readonly float: "0 8px 24px light-dark(rgb(28 25 23 / 0.12), rgb(0 0 0 / 0.5))";
        readonly floatRing: "0 0 0 1px light-dark(rgb(28 25 23 / 0.04), rgb(255 255 255 / 0.04))";
    };
    readonly focus: {
        readonly width: 2;
        readonly offset: 2;
    };
    readonly motion: {
        readonly fast: "150ms";
        readonly slide: "200ms";
    };
    readonly layers: {
        readonly sticky: 4;
        readonly header: 5;
        readonly drawer: 10;
        readonly menu: 20;
        readonly modal: 30;
        readonly toast: 40;
        readonly tooltip: 50;
    };
};
