import { describe, expect, it } from 'vitest';
import {
  deliverResultOf,
  formatMorning,
  type Catalog,
  type DeliverResult,
  type MorningInput,
  type ProposalView,
  type TaskView,
} from '../../scripts/night-shift/morning.mts';
import type { RunReport } from '../../scripts/night-shift/report.mts';
import { SEEDED_LABELS } from '../../src/shared/labels';
import { AREAS, STATUSES } from '../../src/shared/model';
import {
  commandPayloadSchemas,
  proposalCommandIssues,
} from '../../src/shared/schemas';

// The board's own names, as `taskindex context` returns them.
const catalog: Catalog = {
  areas: AREAS,
  statuses: STATUSES,
  projects: [
    { id: 'taskindex', name: 'taskindex' },
    { id: 'traffic', name: 'Трафик' },
  ],
  labels: SEEDED_LABELS,
};
const now = new Date('2026-09-26T07:00:00.000Z');
const goodRun: RunReport = {
  startedAt: '2026-09-26T01:30:00.000Z',
  finishedAt: '2026-09-26T01:30:04.000Z',
  ok: true,
  window: { from: '2026-09-25T01:30:00.000Z', to: '2026-09-26T01:30:00.000Z' },
  stages: {
    board: { tasks: 43, drafts: 6, created: 3, existing: 3, skippedByCap: 0 },
  },
  errors: [],
};

function view(fields: Partial<TaskView> & Pick<TaskView, 'id' | 'title'>) {
  return {
    status: 'todo',
    area: 'personal',
    projectId: null,
    priority: 'p2',
    labels: [],
    closes: null,
    note: '',
    due: null,
    waitingFor: '',
    followUp: null,
    ...fields,
  } satisfies TaskView;
}
const tasksById = new Map<string, TaskView>(
  [
    view({ id: 'pack', area: 'agency', title: 'Отдать Coraline контент-пак' }),
    view({
      id: 'fansly',
      area: 'agency',
      title: 'Продумать автозаполнение заметок Fansly',
    }),
    view({
      id: 'haircut',
      title: 'Стрижка в Барской 21.09',
      due: '2026-09-21',
    }),
    view({
      id: 'report',
      area: 'agency',
      title: 'Сдать отчёт по трафику',
      due: '2026-09-20',
      status: 'doing',
    }),
  ].map((task) => [task.id, task]),
);

let counter = 0;
function proposal(
  fields: Pick<ProposalView, 'kind' | 'command' | 'reason'> &
    Partial<ProposalView>,
): ProposalView {
  counter += 1;
  return {
    id: `proposal-${counter}`,
    taskId:
      fields.kind === 'task_change' ? String(fields.command.payload.id) : null,
    evidence: [
      {
        source: 'board',
        ref: `task:${String(fields.command.payload.id)}`,
        at: '2026-09-25',
        quote: 'доска',
      },
    ],
    number: counter,
    ...fields,
  };
}

function morning(fields: Partial<MorningInput>): string {
  return formatMorning({
    deliver: null,
    tasksById,
    lastRun: goodRun,
    now,
    catalog,
    timezone: 'Europe/Moscow',
    ...fields,
  });
}
const deliver = (shown: ProposalView[], queued: number): DeliverResult => ({
  date: '2026-09-26',
  shown,
  queued,
  expired: [],
  stale: [],
});

describe('morning message: new tasks and changes', () => {
  it('renders new tasks and every kind of board change', () => {
    counter = 0;
    const shown = [
      proposal({
        kind: 'new_task',
        command: {
          command: 'task.create',
          payload: {
            area: 'development',
            projectId: 'taskindex',
            title: 'Ответить на 9 вопросов ревью TaskIndex',
            priority: 'p2',
          },
        },
        reason: 'ревью ждёт ответа владельца',
        evidence: [
          {
            source: 'session',
            ref: 'claude-code:5f0c',
            at: '2026-09-23T15:40:00.000Z',
            quote: 'ревью закончилось вопросами, ответа не было',
          },
        ],
      }),
      proposal({
        kind: 'new_task',
        command: {
          command: 'task.create',
          payload: {
            area: 'agency',
            projectId: 'traffic',
            title: 'Скинуть Coraline ссылку под SpankBang',
            due: '2026-09-27',
            labels: ['lora', 'dengi'],
            note: 'Ссылка из чата трафика.\nПосле ответа отметить в таблице.',
          },
        },
        reason: 'Coraline ждёт ссылку',
        evidence: [
          {
            source: 'telegram',
            ref: 'telegram:coraline',
            at: '2026-09-24T09:10:00.000Z',
            quote: 'жду ссылку',
          },
        ],
      }),
      proposal({
        kind: 'task_change',
        command: {
          command: 'task.move',
          payload: { id: 'pack', baseRevision: 4, status: 'done' },
        },
        reason: '21.09 Coraline в чате: «получила»',
      }),
      proposal({
        kind: 'task_change',
        command: {
          command: 'task.update',
          payload: {
            id: 'fansly',
            baseRevision: 2,
            note: 'Какие поля заполнять и откуда брать данные',
          },
        },
        reason: 'из названия непонятно, что именно нужно',
      }),
      proposal({
        kind: 'task_change',
        command: {
          command: 'task.archive',
          payload: { id: 'haircut', baseRevision: 5 },
        },
        reason: 'дата в названии прошла 5 дней назад',
      }),
    ];
    // Delivery order is by rank; the message groups by kind, numbers stay.
    expect(morning({ deliver: deliver(shown.toReversed(), 3) })).toBe(
      [
        'Предложения на 26.09 · 5 из 8',
        '',
        'Новые задачи',
        '1. Ответить на 9 вопросов ревью TaskIndex',
        '   Разработка · taskindex · P2',
        '   Откуда: сессия, 23.09: «ревью закончилось вопросами, ответа не было»',
        '2. Скинуть Coraline ссылку под SpankBang',
        '   Агентство · Трафик · P2 · Lora, деньги · срок 27.09',
        '   Ссылка из чата трафика.',
        '   После ответа отметить в таблице.',
        '   Откуда: Телеграм, 24.09: «жду ссылку»',
        '',
        'По доске',
        '3. «Отдать Coraline контент-пак»: Очередь → Готово',
        '   Почему: 21.09 Coraline в чате: «получила»',
        '4. «Продумать автозаполнение заметок Fansly»: заметка пустая → «Какие поля заполнять и откуда брать данные»',
        '   Почему: из названия непонятно, что именно нужно',
        '5. «Стрижка в Барской 21.09»: в архив',
        '   Почему: дата в названии прошла 5 дней назад',
      ].join('\n'),
    );
  });
});

describe('morning message: a new task shows everything «да» creates', () => {
  it('renders a state other than the queue, the follow-up, what is awaited, the closed problem and the steps', () => {
    counter = 0;
    const shown = [
      proposal({
        kind: 'new_task',
        command: {
          command: 'task.create',
          payload: {
            area: 'agency',
            projectId: 'traffic',
            title: 'Отправить отчёт по трафику',
            status: 'doing',
            due: '2026-09-27',
            followUp: '2026-09-29',
            waitingFor: 'цифры от Coraline',
            closes: 'traffic-report',
            note: 'Отчёт за неделю.',
            checklist: [
              { text: 'Собрать цифры за неделю' },
              { text: 'Проверить ссылки\nи отметить битые' },
              { text: 'Черновик, который не создаётся', removed: true },
            ],
          },
        },
        reason: 'Coraline ждёт отчёт',
        evidence: [
          {
            source: 'telegram',
            ref: 'telegram:coraline',
            at: '2026-09-24T09:10:00.000Z',
            quote: 'жду отчёт к пятнице',
          },
        ],
      }),
      // The queue is where a new task lands anyway: it goes unsaid.
      proposal({
        kind: 'new_task',
        command: {
          command: 'task.create',
          payload: {
            area: 'personal',
            title: 'Записаться к стоматологу',
            status: 'todo',
            checklist: [],
          },
        },
        reason: 'обещал записаться',
      }),
    ];
    expect(morning({ deliver: deliver(shown, 0) })).toBe(
      [
        'Предложения на 26.09 · 2 из 2',
        '',
        'Новые задачи',
        '1. Отправить отчёт по трафику',
        '   Агентство · Трафик · P2 · состояние В работе · срок 27.09 · вернуться 29.09 · ждём «цифры от Coraline» · закрывает traffic-report',
        '   Отчёт за неделю.',
        '   Шаги:',
        '   – Собрать цифры за неделю',
        '   – Проверить ссылки',
        '     и отметить битые',
        '   Откуда: Телеграм, 24.09: «жду отчёт к пятнице»',
        '2. Записаться к стоматологу',
        '   Личное · P2',
        '   Откуда: доска, 25.09: «доска»',
      ].join('\n'),
    );
  });
});

describe('morning message: no field of a proposed command goes unshown', () => {
  // Every field task.create takes, each with a value that is not the
  // default. A new field of the command fails here until the message shows
  // it or the proposal check refuses it.
  const createSamples: Record<string, unknown> = {
    area: 'agency',
    title: 'Отправить отчёт',
    projectId: 'traffic',
    note: 'Отчёт за неделю',
    due: '2026-09-27',
    waitingFor: 'цифры',
    followUp: '2026-09-29',
    priority: 'p1',
    labels: ['lora'],
    closes: 'traffic-report',
    focus: true,
    status: 'done',
    checklist: [{ text: 'Собрать цифры' }],
    id: 'report',
    origin: { system: 'os', ref: 'problem-1' },
    position: { after: 'pack' },
  };
  const renderNew = (payload: Record<string, unknown>) =>
    morning({
      deliver: deliver(
        [
          proposal({
            kind: 'new_task',
            command: { command: 'task.create', payload },
            reason: 'обещано',
            number: 1,
          }),
        ],
        0,
      ),
    });

  it('shows or refuses every field of task.create; the id names the record and changes nothing the owner gets', () => {
    expect(Object.keys(createSamples).toSorted()).toEqual(
      Object.keys(commandPayloadSchemas['task.create'].shape).toSorted(),
    );
    // Valid values: a refusal below is the proposal rule, not a typo.
    expect(
      commandPayloadSchemas['task.create'].safeParse(createSamples).success,
    ).toBe(true);
    const base = { area: 'agency', title: 'Отправить отчёт' };
    const hidden = Object.entries(createSamples).flatMap(([key, value]) => {
      if (key in base) return [];
      const payload = { ...base, [key]: value };
      const refused =
        proposalCommandIssues({
          kind: 'new_task',
          command: { command: 'task.create', payload },
        }).length > 0;
      return refused || renderNew(payload) !== renderNew(base) ? [] : [key];
    });
    expect(hidden).toEqual(['id']);
  });

  it('shows or refuses every field of task.update', () => {
    const samples: Record<string, unknown> = {
      area: 'development',
      projectId: 'traffic',
      title: 'Автозаполнение заметок Fansly',
      note: 'Какие поля заполнять',
      due: '2026-10-02',
      waitingFor: 'ответ Coraline',
      followUp: '2026-10-03',
      priority: 'p1',
      labels: ['lora'],
      closes: 'fansly-notes',
      focus: true,
      focusPosition: { first: true },
    };
    expect(Object.keys(samples).toSorted()).toEqual(
      Object.keys(commandPayloadSchemas['task.update'].shape)
        .filter((key) => key !== 'id' && key !== 'baseRevision')
        .toSorted(),
    );
    expect(
      commandPayloadSchemas['task.update'].safeParse({
        id: 'fansly',
        baseRevision: 2,
        ...samples,
      }).success,
    ).toBe(true);
    const render = (fields: Record<string, unknown>) =>
      morning({
        deliver: deliver(
          [
            proposal({
              kind: 'task_change',
              command: {
                command: 'task.update',
                payload: { id: 'fansly', baseRevision: 2, ...fields },
              },
              reason: 'карточка неточная',
              number: 1,
            }),
          ],
          0,
        ),
      });
    const hidden = Object.entries(samples).flatMap(([key, value]) => {
      const refused =
        proposalCommandIssues({
          kind: 'task_change',
          taskId: 'fansly',
          baseRevision: 2,
          command: {
            command: 'task.update',
            payload: { id: 'fansly', baseRevision: 2, [key]: value },
          },
        }).length > 0;
      return refused || render({ [key]: value }) !== render({}) ? [] : [key];
    });
    expect(hidden).toEqual([]);
  });
});

describe('morning message: board changes', () => {
  it('renders a due date change and field changes as before → after', () => {
    counter = 0;
    const shown = [
      proposal({
        kind: 'task_change',
        command: {
          command: 'task.update',
          payload: { id: 'report', baseRevision: 7, due: '2026-10-02' },
        },
        reason: 'срок прошёл 20.09',
      }),
      proposal({
        kind: 'task_change',
        command: {
          command: 'task.update',
          payload: {
            id: 'fansly',
            baseRevision: 2,
            title: 'Автозаполнение заметок Fansly: поля и источники',
            priority: 'p3',
            projectId: 'traffic',
            labels: ['5-min'],
          },
        },
        reason: 'название не говорит, что сделать',
      }),
      proposal({
        kind: 'task_change',
        command: {
          command: 'task.move',
          payload: { id: 'report', baseRevision: 7, status: 'done' },
        },
        reason: 'отчёт отправлен 24.09',
      }),
    ];
    expect(morning({ deliver: deliver(shown, 0) })).toBe(
      [
        'Предложения на 26.09 · 3 из 3',
        '',
        'По доске',
        '1. «Сдать отчёт по трафику»: срок 20.09 → 02.10',
        '   Почему: срок прошёл 20.09',
        '2. «Продумать автозаполнение заметок Fansly»: название «Продумать автозаполнение заметок Fansly» → «Автозаполнение заметок Fansly: поля и источники»; приоритет P2 → P3; направление нет → Трафик; метки нет → 5 мин',
        '   Почему: название не говорит, что сделать',
        '3. «Сдать отчёт по трафику»: В работе → Готово',
        '   Почему: отчёт отправлен 24.09',
      ].join('\n'),
    );
  });
});

describe('morning message: silence and failures', () => {
  it('stays silent when nothing is shown and the night shift ran', () => {
    expect(morning({ deliver: deliver([], 0) })).toBe('NO_REPLY');
    expect(morning({ deliver: deliver([], 4) })).toBe('NO_REPLY');
  });

  it('opens with the failure line, even with nothing to show', () => {
    expect(morning({ deliver: deliver([], 0), lastRun: null })).toBe(
      'Ночная смена не отработала: отчёта прогона нет',
    );
    expect(
      morning({
        deliver: deliver([], 0),
        lastRun: {
          ...goodRun,
          ok: false,
          errors: [
            {
              stage: 'board',
              message: 'taskindex snapshot: Ключ агента не найден',
            },
          ],
        },
      }),
    ).toBe(
      'Ночная смена не отработала: taskindex snapshot: Ключ агента не найден',
    );
    counter = 0;
    const shown = [
      proposal({
        kind: 'task_change',
        command: {
          command: 'task.archive',
          payload: { id: 'haircut', baseRevision: 5 },
        },
        reason: 'дата в названии прошла 5 дней назад',
      }),
    ];
    expect(
      morning({
        deliver: deliver(shown, 0),
        lastRun: {
          ...goodRun,
          startedAt: '2026-09-25T01:30:00.000Z',
          finishedAt: '2026-09-25T01:31:00.000Z',
        },
      }),
    ).toBe(
      [
        'Ночная смена не отработала: последний прогон 25.09 в 04:31',
        '',
        'Предложения на 26.09 · 1 из 1',
        '',
        'По доске',
        '1. «Стрижка в Барской 21.09»: в архив',
        '   Почему: дата в названии прошла 5 дней назад',
      ].join('\n'),
    );
  });

  it('says so when proposals could not be fetched', () => {
    expect(
      morning({
        deliverError: 'taskindex proposal: Ключ агента не найден',
      }),
    ).toBe(
      'Предложения не получены: taskindex proposal: Ключ агента не найден',
    );
  });
});

describe('morning deliver result', () => {
  it('finds the deliver result in the operation response', () => {
    const result = deliver([], 2);
    expect(
      deliverResultOf({ ok: true, results: [{ ...result, changes: {} }] }),
    ).toEqual(result);
    expect(
      deliverResultOf({ ok: true, results: [{ record: result, changes: {} }] }),
    ).toEqual(result);
    expect(deliverResultOf({ ok: true, results: [{ record: null }] })).toBe(
      null,
    );
  });
});
