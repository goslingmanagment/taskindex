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
    id: 'otvet',
    name: 'ответ',
    color: '#bd811d',
    description:
      'Нужен ответ или решение владельца кому-то: человеку, подрядчику, кандидату',
  },
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
