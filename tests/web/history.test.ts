import { describe, expect, it } from 'vitest';
import type { Changes, DomainEvent, Project } from '../../src/shared/model';
import { actorOptions, describeEvent } from '../../src/web/app/history';

// TI-032: the history is a story, not a dump of enum ids, order keys and JSON.
// Every case below is checked against the event alone — the formatter may not
// invent a neighbour, a column or a name it cannot see in `changes`.
const projects: Project[] = [
  {
    id: 'clients',
    area: 'agency',
    name: 'Клиенты',
    description: '',
    color: '#3763df',
    revision: 1,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
  },
];
const ctx = { projects };
function event(changes: Changes, command = 'task.update'): DomainEvent {
  return {
    seq: 7,
    generation: 'gen-1',
    at: '2026-09-09T09:00:00.000Z',
    actorId: 'owner',
    actorLabel: 'Дмитрий',
    operationId: 'op-1',
    entityKind: 'task',
    entityId: 'task-1',
    command,
    changes,
    recordRevision: 2,
    firstSeq: 7,
    lastSeq: 7,
  } as DomainEvent;
}
const texts = (changes: Changes, command?: string) =>
  describeEvent(event(changes, command), ctx).lines.map(
    (l) => `${l.label}: ${l.text}`,
  );
const step = (id: string, text: string, done = false) => ({ id, text, done });

describe('TI-032 the history speaks the words of the workspace', () => {
  it('names areas and statuses instead of their ids', () => {
    expect(
      texts({
        status: { from: 'todo', to: 'doing' },
        area: { from: 'agency', to: 'personal' },
      }),
    ).toEqual([
      'Состояние: «Очередь» → «В работе»',
      'Область: «Агентство» → «Личное»',
    ]);
  });
  it('hides the order key behind a move and never invents the neighbour', () => {
    // A move to another column: the column is in the event, the position is not.
    expect(
      texts(
        {
          status: { from: 'todo', to: 'done' },
          orderKey: { from: 'a0', to: 'a1' },
        },
        'task.move',
      ),
    ).toEqual(['Состояние: «Очередь» → «Готово»']);
    // A reorder inside one column: nothing in the event says where it landed.
    expect(texts({ orderKey: { from: 'a0', to: 'a2' } }, 'task.move')).toEqual([
      'Порядок: Изменён порядок',
    ]);
  });
  it('names a project, marks that the name comes from today and admits a deleted one', () => {
    const [line] = describeEvent(
      event({ projectId: { from: null, to: 'clients' } }),
      ctx,
    ).lines;
    expect(line).toMatchObject({
      label: 'Направление',
      text: 'без направления → «Клиенты»',
    });
    expect(line?.note).toBeTruthy();
    expect(texts({ projectId: { from: 'gone', to: null } })).toEqual([
      'Направление: направление, которого больше нет → без направления',
    ]);
  });
  it('tells checklist edits apart by item id, not by position', () => {
    const before = [step('a', 'Позвонить'), step('b', 'Написать письмо')];
    expect(
      texts({
        checklist: { from: before, to: [...before, step('c', 'Счёт')] },
      }),
    ).toEqual(['Шаги: Добавлен шаг «Счёт»']);
    expect(
      texts({ checklist: { from: before, to: [before[1]!, before[0]!] } }),
    ).toEqual(['Шаги: Порядок шагов изменён']);
    expect(
      texts({
        checklist: {
          from: before,
          to: [step('a', 'Позвонить', true), step('b', 'Написать письмо')],
        },
      }),
    ).toEqual(['Шаги: Шаг «Позвонить» отмечен выполненным']);
    expect(
      texts({
        checklist: {
          from: before,
          to: [step('a', 'Позвонить сегодня'), step('b', 'Написать письмо')],
        },
      }),
    ).toEqual(['Шаги: Шаг «Позвонить» переименован в «Позвонить сегодня»']);
    expect(texts({ checklist: { from: before, to: [before[0]!] } })).toEqual([
      'Шаги: Удалён шаг «Написать письмо»',
    ]);
    // Moving a step and checking another one in one save reads as both.
    expect(
      texts({
        checklist: {
          from: before,
          to: [step('b', 'Написать письмо', true), step('a', 'Позвонить')],
        },
      }),
    ).toEqual([
      'Шаги: Шаг «Написать письмо» отмечен выполненным; порядок шагов изменён',
    ]);
  });
  it('says what flags and dates mean', () => {
    expect(
      texts({
        focus: { from: false, to: true },
        archived: { from: true, to: false },
        due: { from: null, to: '2026-09-15' },
        waitingFor: { from: 'клиент', to: '' },
      }),
    ).toEqual([
      'Фокус: Задача в фокусе',
      'Архив: Задача возвращена из архива',
      'Срок: не задано → 15 сентября 2026 г.',
      'Чего ждём: «клиент» → пусто',
    ]);
  });
  it('keeps bookkeeping out of the story and admits an unknown field', () => {
    const story = describeEvent(
      event({
        title: { from: 'Старое', to: 'Новое' },
        revision: { from: 1, to: 2 },
        updatedAt: { from: 'a', to: 'b' },
        ownerFields: { from: [], to: ['title'] },
        mood: { from: 'ok', to: 'great' },
      }),
      ctx,
    );
    expect(story.lines.map((l) => `${l.label}: ${l.text}`)).toEqual([
      'Название: «Старое» → «Новое»',
      'Поле «mood»: изменено',
    ]);
    expect(story.technical.map(([field]) => field)).toEqual([
      'revision',
      'updatedAt',
      'ownerFields',
      'mood',
    ]);
  });
  it('tells a creation as the values it started with, without empty fields', () => {
    expect(
      texts(
        {
          id: { from: null, to: 'task-1' },
          title: { from: null, to: 'Собрать смету' },
          status: { from: null, to: 'todo' },
          area: { from: null, to: 'agency' },
          projectId: { from: null, to: null },
          note: { from: null, to: '' },
          checklist: { from: null, to: [] },
          focus: { from: null, to: false },
          orderKey: { from: null, to: 'a0' },
        },
        'task.create',
      ),
    ).toEqual([
      'Название: «Собрать смету»',
      'Состояние: «Очередь»',
      'Область: «Агентство»',
    ]);
  });
  it('never leaves a created task without a line and never prints raw JSON', () => {
    const created = describeEvent(
      event({ id: { from: undefined, to: 'task-1' } }, 'task.create'),
      ctx,
    );
    expect(created.lines).toEqual([{ label: 'Задача', text: 'Создана' }]);
    for (const changes of [
      { checklist: { from: 'сломано', to: 42 } },
      { note: { from: null, to: { weird: true } } },
    ] as Changes[])
      for (const line of describeEvent(event(changes), ctx).lines)
        expect(line.text).not.toMatch(/[{}[\]]/u);
  });
});

describe('TI-076 the author filter keeps every author selectable', () => {
  const agent = (id: string, label: string, disabledAt: string | null) => ({
    id,
    label,
    createdAt: '2026-09-01T10:00:00.000Z',
    disabledAt,
  });
  it('offers everyone, the owner and the known agents, marking a disabled one', () => {
    expect(
      actorOptions(
        [
          agent('worker', 'Рабочий', null),
          agent('old', 'Прежний', '2026-09-05T10:00:00.000Z'),
        ],
        [],
      ),
    ).toEqual([
      { value: '', label: 'Все авторы' },
      { value: 'owner', label: 'Владелец' },
      { value: 'agent:worker', label: 'Рабочий' },
      { value: 'agent:old', label: 'Прежний (отключён)' },
    ]);
  });
  it('keeps an author that only the journal remembers', () => {
    const options = actorOptions(
      [agent('worker', 'Рабочий', null)],
      [
        { actorId: 'agent:worker', actorLabel: 'Рабочий' },
        { actorId: 'agent:deleted', actorLabel: 'Удалённый' },
        { actorId: 'owner', actorLabel: 'Дмитрий' },
      ],
    );
    expect(options.map((o) => o.value)).toEqual([
      '',
      'owner',
      'agent:worker',
      'agent:deleted',
    ]);
    expect(options.at(-1)).toEqual({
      value: 'agent:deleted',
      label: 'Удалённый (нет в списке)',
    });
  });
  it('works without the directory, from the journal alone', () => {
    expect(
      actorOptions(null, [{ actorId: 'agent:worker', actorLabel: 'Рабочий' }]),
    ).toEqual([
      { value: '', label: 'Все авторы' },
      { value: 'owner', label: 'Владелец' },
      { value: 'agent:worker', label: 'Рабочий (нет в списке)' },
    ]);
  });
});
