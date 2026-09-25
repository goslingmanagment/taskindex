import { describe, expect, it } from 'vitest';
import type {
  Changes,
  DomainEvent,
  Label,
  Project,
} from '../../src/shared/model';
import { SEEDED_LABELS } from '../../src/shared/labels';
import { actorOptions, describeEvent } from '../../src/web/app/history';
import {
  commandLabel,
  HIDDEN_ACTIVITY_COMMANDS,
} from '../../src/web/app/labels';

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
// An archived label keeps its record, so the story still names it.
const labels: Label[] = [
  ...SEEDED_LABELS,
  {
    id: 'otvet',
    name: 'ответ',
    color: '#bd811d',
    description: '',
    position: 6,
    archivedAt: '2026-09-17T19:00:00.000Z',
    revision: 2,
    createdAt: '2026-09-13T10:00:00.000Z',
    updatedAt: '2026-09-17T19:00:00.000Z',
  },
];
const ctx = { projects, labels };
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
  it('0007 tells label catalogue events: creation, renaming and the archive', () => {
    const labelEvent = (changes: Changes, command: string) =>
      describeEvent(
        {
          ...event(changes, command),
          entityKind: 'label',
          entityId: 'srochno',
        },
        ctx,
      ).lines.map((l) => `${l.label}: ${l.text}`);
    expect(
      labelEvent(
        {
          name: { from: null, to: 'Срочно' },
          color: { from: null, to: '#bc3c45' },
          description: { from: null, to: 'Ждёт сегодня' },
          position: { from: null, to: 6 },
          archivedAt: { from: null, to: null },
          createdAt: { from: null, to: '2026-09-17T21:00:00.000Z' },
        },
        'label.create',
      ),
    ).toEqual([
      'Название: «Срочно»',
      'Описание: «Ждёт сегодня»',
      'Цвет: «#bc3c45»',
    ]);
    expect(
      labelEvent({ name: { from: 'Срочно', to: 'Горит' } }, 'label.update'),
    ).toEqual(['Название: «Срочно» → «Горит»']);
    expect(
      labelEvent(
        { archivedAt: { from: null, to: '2026-09-17T22:00:00.000Z' } },
        'label.archive',
      ),
    ).toEqual(['Архив: Метка в архиве']);
    expect(
      labelEvent(
        { archivedAt: { from: '2026-09-17T22:00:00.000Z', to: null } },
        'label.restore',
      ),
    ).toEqual(['Архив: Метка возвращена из архива']);
  });
  it('TI-086 tells priority, labels and closes changes in words', () => {
    expect(
      texts({
        priority: { from: 'p2', to: 'p1' },
        labels: { from: ['otvet'], to: ['dengi', 'lora'] },
        closes: { from: null, to: 'lora-km-of-vacancy' },
      }),
    ).toEqual([
      'Приоритет: P2 → P1',
      'Метки: +деньги, +Lora, −ответ',
      'Закрывает: не задано → проблема «lora-km-of-vacancy»',
    ]);
    expect(texts({ labels: { from: ['otvet'], to: [] } })).toEqual([
      'Метки: −ответ',
    ]);
    expect(texts({ closes: { from: 'lora-km-of-vacancy', to: null } })).toEqual(
      ['Закрывает: проблема «lora-km-of-vacancy» → не задано'],
    );
    expect(
      texts(
        {
          createdAt: { from: null, to: '2026-09-09T09:00:00.000Z' },
          title: { from: null, to: 'Новая' },
          priority: { from: null, to: 'p1' },
          labels: { from: null, to: ['otvet'] },
        },
        'task.create',
      ),
    ).toEqual(['Название: «Новая»', 'Приоритет: P1', 'Метки: +ответ']);
  });
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

describe('TI-095 the history tells step events', () => {
  type Kind = DomainEvent['entityKind'];
  const directory = {
    ...ctx,
    tasks: [{ id: 'child', title: 'Настроить мониторинг' }],
    steps: [{ id: 's1', text: 'Поднять контейнер' }],
  };
  const stepEvent = (changes: Changes, command: string, kind: Kind = 'step') =>
    describeEvent(
      { ...event(changes, command), entityKind: kind, entityId: 's1' },
      directory,
    );
  const lines = (changes: Changes, command: string, kind?: Kind) =>
    stepEvent(changes, command, kind).lines.map((l) => `${l.label}: ${l.text}`);
  it('tells a new step by its text alone and hides its bookkeeping', () => {
    const story = stepEvent(
      {
        id: { from: null, to: 's1' },
        taskId: { from: null, to: 'task-1' },
        text: { from: null, to: 'Поднять контейнер' },
        orderKey: { from: null, to: 'a0' },
        done: { from: null, to: false },
        doneAt: { from: null, to: null },
        doneBy: { from: null, to: null },
        doneByLabel: { from: null, to: null },
        result: { from: null, to: '' },
        linkedTaskId: { from: null, to: null },
        removedAt: { from: null, to: null },
        createdBy: { from: null, to: 'owner' },
        createdByLabel: { from: null, to: 'Дмитрий' },
        ownerTouchedAt: { from: null, to: null },
        ownerFields: { from: null, to: [] },
        createdAt: { from: null, to: '2026-09-09T09:00:00.000Z' },
      },
      'checklist.add',
    );
    expect(story.lines.map((l) => `${l.label}: ${l.text}`)).toEqual([
      'Шаг: Добавлен шаг «Поднять контейнер»',
    ]);
    expect(story.technical.map(([field]) => field)).toContain('doneBy');
  });
  it('tells the tick, the outcome, the removal and the promotion in words, naming the step from today', () => {
    expect(
      lines(
        {
          done: { from: false, to: true },
          doneAt: { from: null, to: '2026-09-09T09:00:00.000Z' },
          doneBy: { from: null, to: 'agent:claude' },
          doneByLabel: { from: null, to: 'Claude Mac' },
          result: { from: '', to: 'PR #12' },
        },
        'checklist.update',
      ),
    ).toEqual([
      'Отметка: Шаг «Поднять контейнер» отмечен выполненным',
      'Итог: пусто → «PR #12»',
    ]);
    expect(
      lines({ done: { from: true, to: false } }, 'checklist.update'),
    ).toEqual(['Отметка: С шага «Поднять контейнер» снята отметка']);
    expect(
      lines(
        { removedAt: { from: null, to: '2026-09-09T09:00:00.000Z' } },
        'checklist.remove',
      ),
    ).toEqual(['Шаг: Шаг «Поднять контейнер» убран']);
    expect(
      lines(
        { removedAt: { from: '2026-09-09T09:00:00.000Z', to: null } },
        'undo',
      ),
    ).toEqual(['Шаг: Шаг «Поднять контейнер» возвращён']);
    expect(
      lines({ orderKey: { from: 'a0', to: 'a2' } }, 'checklist.move'),
    ).toEqual(['Порядок: Изменён порядок']);
    const promoted = stepEvent(
      { linkedTaskId: { from: null, to: 'child' } },
      'checklist.promote',
    );
    expect(promoted.lines).toEqual([
      {
        label: 'Задача',
        text: 'Шаг «Поднять контейнер» вынесен в задачу «Настроить мониторинг»',
        note: 'название на сегодня',
      },
    ]);
    expect(
      lines({ linkedTaskId: { from: null, to: 'gone' } }, 'checklist.update'),
    ).toEqual(['Задача: Шаг «Поднять контейнер» вынесен в задачу']);
    // A step the directory no longer knows is still told, without its text.
    expect(
      describeEvent(
        {
          ...event({ done: { from: false, to: true } }, 'checklist.update'),
          entityKind: 'step',
          entityId: 'forgotten',
        },
        ctx,
      ).lines,
    ).toEqual([{ label: 'Отметка', text: 'Шаг отмечен выполненным' }]);
    // The task the promotion creates is told as a creation.
    expect(
      lines(
        {
          title: { from: null, to: 'Настроить мониторинг' },
          status: { from: null, to: 'todo' },
          note: { from: null, to: 'Шаг задачи «Перенести бота» (t).' },
        },
        'checklist.promote',
        'task',
      ),
    ).toEqual([
      'Название: «Настроить мониторинг»',
      'Состояние: «Очередь»',
      'Заметка: «Шаг задачи «Перенести бота» (t).»',
    ]);
  });
});
describe('agent proposals in the history (spec 2026-09-25)', () => {
  it('tells a proposal event by its outcome and reason and keeps the rest technical', () => {
    const story = describeEvent(
      {
        ...event(
          {
            status: { from: 'shown', to: 'rejected' },
            number: { from: 3, to: null },
            decisionReason: { from: null, to: 'Это понятно из названия' },
            decidedBy: { from: null, to: 'agent:openclaw' },
          },
          'proposal.reject',
        ),
        entityKind: 'proposal',
        entityId: 'p-1',
      },
      ctx,
    );
    expect(story.lines.map((l) => `${l.label}: ${l.text}`)).toEqual([
      'Предложение: Отклонено',
      'Причина: «Это понятно из названия»',
    ]);
    expect(story.technical.map(([field]) => field)).toContain('number');
  });
  it('names the four proposal commands and hides the night shift bookkeeping from «Активность»', () => {
    for (const command of [
      'proposal.create',
      'proposal.deliver',
      'proposal.accept',
      'proposal.reject',
    ])
      expect(commandLabel(command)).not.toBe(command);
    expect([...HIDDEN_ACTIVITY_COMMANDS]).toEqual([
      'proposal.create',
      'proposal.deliver',
    ]);
  });
});
