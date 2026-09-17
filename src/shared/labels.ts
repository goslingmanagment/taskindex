// The owner's fixed priorities (TI-086) and the labels a workspace starts
// with. Since 0007 (owner decision 2026-09-17) labels are records of the
// `labels` table: the owner creates, renames and archives them in the
// interface, agents read the catalogue from /api/context. This list only seeds
// a new or migrated database and upgrades exports of older formats.
export const PRIORITIES = [
  { id: 'p1', name: 'P1', hint: 'Горит: делать первым' },
  { id: 'p2', name: 'P2', hint: 'Обычная задача' },
  { id: 'p3', name: 'P3', hint: 'Когда-нибудь: не сейчас' },
] as const;
export type Priority = (typeof PRIORITIES)[number]['id'];
export const PRIORITY_IDS = PRIORITIES.map((p) => p.id) as [
  Priority,
  ...Priority[],
];
export const DEFAULT_PRIORITY: Priority = 'p2';
// The instant 0007_labels.sql stamps on the seeded rows; upgradeExport writes
// the same records, so an old export and a migrated database converge.
const SEEDED_LABELS_AT = '2026-09-17T21:00:00.000Z';
const seeded = <T extends { id: string }>(rows: readonly T[]) =>
  rows.map((row, index) => ({
    ...row,
    position: index + 1,
    archivedAt: null,
    revision: 1,
    createdAt: SEEDED_LABELS_AT,
    updatedAt: SEEDED_LABELS_AT,
  }));
export const SEEDED_LABELS = seeded([
  {
    id: 'dengi',
    name: 'деньги',
    color: '#298467',
    description:
      'Платёж, долг, приз, финансовое решение; при оплате строка в ledger',
  },
  {
    id: '5-min',
    name: '5 мин',
    color: '#8290a4',
    description: 'Делается за несколько минут, годится в просвет',
  },
  {
    id: 'lora',
    name: 'Lora',
    color: '#9661bf',
    description: 'Касается модели Lora',
  },
  {
    id: 'lily',
    name: 'Lily',
    color: '#397faf',
    description: 'Касается модели Lily',
  },
  {
    id: 'ari',
    name: 'Ari',
    color: '#a97928',
    description: 'Касается модели Ari',
  },
]);
