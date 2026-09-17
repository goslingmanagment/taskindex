// Older export formats become the current one here: each rule mirrors the SQL
// migration that brought an existing database to the same shape. See
// drizzle/v2/README.md (data rule TI-014, variant b).
import { FORMAT_VERSION } from '../shared/model.js';
import type { ExportData } from '../shared/model.js';
import { SEEDED_LABELS } from '../shared/labels.js';
import { z } from '../shared/schemas.js';
import { compareStrings } from '../shared/queries.js';
import {
  defaultAppearance,
  exportSchema,
  exportSchemaV1,
  exportSchemaV2,
  exportSchemaV3,
  exportSchemaV4,
  exportSchemaV5,
  exportSchemaV6,
} from '../shared/domain-schemas.js';

// Reads formats 1-7. Older formats lack the label catalogue (6), may carry
// the retired label otvet (5), lack task fields (4), desk keys (3),
// appearance (2) or operationSeq (1). Defaults match their SQL migrations;
// operation positions use (createdAt, id). See drizzle/v2/README.md.
export function upgradeExport(raw: unknown): ExportData {
  const version = z
    .object({ formatVersion: z.unknown() })
    .loose()
    .parse(raw).formatVersion;
  if (version === FORMAT_VERSION) return exportSchema.parse(raw);
  return withCatalogueLabels(upgradeLegacy(raw, version));
}
// Formats 1-6: the catalogue is the seeded one 0007_labels.sql inserts into
// an existing database, and a task keeps only its labels (0006 dropped the
// retired one the same way). Events and stored results stay as written
// (applyEvent replays them to these rows).
type Legacy = Omit<ExportData, 'labels'>;
function withCatalogueLabels(data: Legacy): ExportData {
  const seeded = new Set(SEEDED_LABELS.map((l) => l.id));
  return {
    ...data,
    labels: structuredClone(SEEDED_LABELS),
    tasks: data.tasks.map((t) => ({
      ...t,
      labels: t.labels.filter((id) => seeded.has(id)),
    })),
  };
}
function upgradeLegacy(raw: unknown, version: unknown): Legacy {
  if (version === 6)
    return { ...exportSchemaV6.parse(raw), formatVersion: FORMAT_VERSION };
  if (version === 5)
    return { ...exportSchemaV5.parse(raw), formatVersion: FORMAT_VERSION };
  // Record schemas fill the defaults that 0005 wrote into existing rows.
  if (version === 4)
    return { ...exportSchemaV4.parse(raw), formatVersion: FORMAT_VERSION };
  if (version === 3) {
    const legacy = exportSchemaV3.parse(raw);
    return {
      ...legacy,
      formatVersion: FORMAT_VERSION,
      tasks: withFocusKeys(legacy.tasks),
    };
  }
  const legacy =
    version === 2
      ? exportSchemaV2.parse(raw)
      : withPositions(exportSchemaV1.parse(raw));
  return {
    ...legacy,
    formatVersion: FORMAT_VERSION,
    appearance: [defaultAppearance()],
    tasks: withFocusKeys(legacy.tasks),
  };
}
// Format 1: positions in (createdAt, id) order (0002_operation_seq.sql).
function withPositions(data: z.infer<typeof exportSchemaV1>) {
  const ordered = data.operations.toSorted(
    (a, b) =>
      compareStrings(a.createdAt, b.createdAt) || compareStrings(a.id, b.id),
  );
  const positions = new Map(ordered.map((o, i) => [o.id, i + 1]));
  return {
    ...data,
    operations: data.operations.map((o) => ({
      ...o,
      operationSeq: positions.get(o.id)!,
    })),
  };
}
// Formats 1-3: focused tasks get desk keys in (area, status, orderKey, id)
// order, the same keys 0004_focus_desk.sql assigns to an existing database.
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const backfillFocusKey = (n: number) =>
  `a0${BASE62[Math.floor(n / 3844) % 62]}${BASE62[Math.floor(n / 62) % 62]}${BASE62[n % 62]}V`;
function withFocusKeys<
  T extends {
    id: string;
    area: string;
    status: string;
    orderKey: string;
    focus: boolean;
  },
>(tasks: T[]): (T & { focusKey: string | null; focusLeftAt: null })[] {
  const focused = tasks
    .filter((t) => t.focus)
    .toSorted(
      (a, b) =>
        compareStrings(a.area, b.area) ||
        compareStrings(a.status, b.status) ||
        compareStrings(a.orderKey, b.orderKey) ||
        compareStrings(a.id, b.id),
    );
  const keys = new Map(focused.map((t, n) => [t.id, backfillFocusKey(n)]));
  return tasks.map((t) => ({
    ...t,
    focusKey: keys.get(t.id) ?? null,
    focusLeftAt: null,
  }));
}
