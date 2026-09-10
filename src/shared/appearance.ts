import { z } from 'zod';

// TI-025, TI-026: the owner's appearance preference. Two independent notions:
// `mode` is what the owner chose (`system` is not a third palette, the device
// resolves it), `skinId` selects a palette from the registry below. The record
// is a single row of the workspace, so it goes through the same command,
// event, undo and export paths as tasks and projects.
export const DEFAULT_APPEARANCE_ID = 'owner';

export const APPEARANCE_MODES = ['system', 'light', 'dark'] as const;
export type AppearanceMode = (typeof APPEARANCE_MODES)[number];

export const appearanceModeSchema = z
  .enum(APPEARANCE_MODES)
  .describe('Режим оформления: как в системе, светлый или тёмный');

// A few colour tokens per skin: enough for a preview card, not the palette
// itself. The full palette lives in the web tokens file (plan 08, phase A).
export type SkinPreview = {
  background: string;
  surface: string;
  foreground: string;
  accent: string;
};

export type SkinDefinition = {
  id: string;
  label: string;
  description: string;
  preview: SkinPreview;
};

export const SKINS = [
  {
    id: 'classic',
    label: 'Классический',
    description: 'Привычный вид доски: холодная серая бумага и синий акцент',
    preview: {
      background: '#f1f4f9',
      surface: '#ffffff',
      foreground: '#24324a',
      accent: '#3763df',
    },
  },
  {
    id: 'focus',
    label: 'Фокус',
    description:
      'Тёплая бумага, тёмно-зелёные чернила и один терракотовый акцент',
    preview: {
      background: '#f4f3ed',
      surface: '#fffef9',
      foreground: '#243b39',
      accent: '#ac5738',
    },
  },
] as const satisfies readonly SkinDefinition[];

export type SkinId = (typeof SKINS)[number]['id'];

export const skinIds = SKINS.map((skin) => skin.id) as [SkinId, ...SkinId[]];

// Write validation is strict: only an id of the current catalogue is accepted.
// Reads stay lenient (`z.string()` in `appearanceSchema`) so that a client of
// an older build shows Classic instead of failing to parse the whole snapshot
// (astra-26).
export const skinIdSchema = z
  .enum(skinIds)
  .describe(`Идентификатор скина: ${skinIds.join(', ')}`);

export const DEFAULT_APPEARANCE_MODE: AppearanceMode = 'system';
export const DEFAULT_SKIN_ID: SkinId = 'classic';
