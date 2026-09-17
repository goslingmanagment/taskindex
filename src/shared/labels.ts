// The owner's fixed catalogues (TI-086): commands validate their ids and
// /api/context explains their meaning. Adding a label requires a release.
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
export const LABELS = [
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
] as const;
export type LabelId = (typeof LABELS)[number]['id'];
export const LABEL_IDS = LABELS.map((l) => l.id) as [LabelId, ...LabelId[]];
// Labels the owner retired. Commands no longer accept them; a migration drops
// them from the tables and replay drops them from the journal, but stored
// results of old operations still carry them, so records read them as known
// ids and the history still names them. otvet («ответ», 2026-09-17): the title
// already says who waits for an answer, and unanswered chats live in Telegram.
export const RETIRED_LABELS = [
  { id: 'otvet', name: 'ответ', retiredAt: '2026-09-17' },
] as const;
export type StoredLabelId = LabelId | (typeof RETIRED_LABELS)[number]['id'];
export const STORED_LABEL_IDS = [
  ...LABEL_IDS,
  ...RETIRED_LABELS.map((l) => l.id),
] as [StoredLabelId, ...StoredLabelId[]];
export const isCatalogueLabel = (id: string): id is LabelId =>
  (LABEL_IDS as readonly string[]).includes(id);
