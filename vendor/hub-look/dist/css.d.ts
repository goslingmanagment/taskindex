/**
 * The token values written out as CSS: the two copies Hub keeps (Workboard's
 * `--ui-*`, the console's `--color-*` under Tailwind's `@theme static`), and the
 * small helpers another repository needs to take the same values into its own
 * names. Pure functions over `tokens.ts`; `packages/look/generate.ts` writes the two
 * Hub copies with them, `scripts/vendor-look.mjs` ships them compiled.
 */
import { type ThemeValue } from "./tokens.js";
/** `light-dark(light, dark)`, or the one value both themes share. */
export declare function themeValue(value: ThemeValue): string;
/** One theme's side of a value. */
export declare function sideOf(value: ThemeValue, theme: "light" | "dark"): string;
/**
 * «52 70 123» for `#34467b`: the channels a closed shadow root takes
 * (`rgb(var(--x) / 0.5)`), as the extension keeps its values.
 */
export declare function rgbChannels(hex: string): string;
/** Workboard's copy (`packages/ui/src/styles/tokens.css`): every token as `--ui-*`, in `@layer ui`. */
export declare function renderUiTokensCss(): string;
/**
 * The console's copy (`apps/dashboard/src/styles/tokens.css`): the colours as
 * `--color-*` and the type scale, radii and bold weight under Tailwind's
 * `@theme static` (so its utilities and `var()` read them), the two shadows on `:root`.
 */
export declare function renderConsoleTokensCss(): string;
