import { describe, expect, it } from 'vitest';
import {
  auditBoard,
  collectLastEvents,
  daysWord,
  titleDates,
  type ProposalDraft,
} from '../../scripts/night-shift/audit.mts';
import { runWindow } from '../../scripts/night-shift/report.mts';
import {
  eventSchema,
  snapshotSchema,
  stepSchema,
  taskSchema,
} from '../../src/shared/domain-schemas';
import type { DomainEvent, Step, Task } from '../../src/shared/model';
import { commandPayloadSchemas } from '../../src/shared/schemas';

const TODAY = '2026-09-25';
const GENERATION = 'g-night-shift';

function task(fields: Pick<Task, 'id' | 'title'> & Partial<Task>): Task {
  return taskSchema.parse({
    area: 'personal',
    projectId: null,
    status: 'todo',
    priority: 'p2',
    labels: [],
    closes: null,
    note: '',
    due: null,
    waitingFor: '',
    followUp: null,
    orderKey: `a${fields.id}`,
    focus: false,
    focusKey: null,
    focusLeftAt: null,
    archived: false,
    checklist: [],
    commentCount: 0,
    originSystem: null,
    originRef: null,
    originUrl: null,
    originVersion: null,
    createdBy: 'agent:claude-mac',
    createdByLabel: 'Claude Code (мак)',
    ownerTouchedAt: null,
    ownerFields: [],
    revision: 3,
    createdAt: '2026-09-01T09:00:00.000Z',
    // Moved by migrations and the agent rename without events: the audit
    // must not read it.
    updatedAt: '2026-09-24T21:00:00.000Z',
    ...fields,
  });
}

let seq = 0;
function event(
  fields: Pick<DomainEvent, 'entityKind' | 'entityId' | 'at'> &
    Partial<DomainEvent>,
): DomainEvent {
  seq += 1;
  return eventSchema.parse({
    seq,
    generation: GENERATION,
    actorId: 'agent:claude-mac',
    actorLabel: 'Claude Code (мак)',
    operationId: `op-${seq}`,
    command: fields.entityKind === 'step' ? 'checklist.add' : 'task.update',
    changes: {},
    recordRevision: 1,
    firstSeq: seq,
    lastSeq: seq,
    ...fields,
  });
}

function step(fields: Pick<Step, 'id' | 'taskId'> & Partial<Step>): Step {
  return stepSchema.parse({
    text: 'Шаг',
    orderKey: 'a0',
    done: false,
    doneAt: null,
    doneBy: null,
    doneByLabel: null,
    result: '',
    linkedTaskId: null,
    removedAt: null,
    createdBy: 'owner',
    createdByLabel: 'Владелец',
    ownerTouchedAt: null,
    ownerFields: [],
    revision: 1,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    ...fields,
  });
}

// The board of 2026-09-25 in miniature: the visits of spec §1, an overdue
// task, an abandoned one and the cases the audit must leave alone.
const tasks = [
  task({
    id: 'haircut',
    title: 'Стрижка в Барской 21.09',
    due: '2026-09-21',
    revision: 5,
  }),
  task({ id: 'lfk', title: 'ЛФК 21.09' }),
  task({
    id: 'traffic-report',
    area: 'agency',
    title: 'Сдать отчёт по трафику',
    due: '2026-09-20',
    status: 'doing',
    revision: 7,
  }),
  task({
    id: 'photo-archive',
    title: 'Разобрать фотоархив',
    priority: 'p3',
    due: '2026-09-24',
  }),
  task({
    id: 'call-moved',
    title: 'Созвон с бухгалтером 30.09',
    due: '2026-09-22',
  }),
  task({
    id: 'fansly-notes',
    area: 'agency',
    title: 'Продумать автозаполнение заметок Fansly',
  }),
  task({ id: 'someday', title: 'Выучить испанский', priority: 'p3' }),
  task({
    id: 'archived-visit',
    title: 'Мануальный терапевт 22.09',
    archived: true,
  }),
  task({
    id: 'done-late',
    title: 'Оплатить хостинг',
    status: 'done',
    due: '2026-09-10',
  }),
  task({
    id: 'step-moved',
    title: 'Собрать чек-лист запуска',
    checklist: [
      {
        id: 'live-step',
        text: 'Первый пункт',
        done: false,
        doneAt: null,
        doneBy: null,
        doneByLabel: null,
        result: '',
        linkedTaskId: null,
        revision: 1,
      },
    ],
  }),
  task({ id: 'removed-step-moved', title: 'Разобрать почту агентства' }),
  task({ id: 'doing-idle', title: 'Переписать онбординг', status: 'doing' }),
  task({ id: 'visit-ahead', title: 'Визит к врачу 15.10' }),
  task({ id: 'no-events', title: 'Задача без журнала' }),
];
const steps = [
  step({ id: 'live-step', taskId: 'step-moved' }),
  step({
    id: 'gone-step',
    taskId: 'removed-step-moved',
    removedAt: '2026-09-20T10:00:00.000Z',
  }),
];
const old = '2026-09-04T08:00:00.000Z';
const events = [
  ...[
    'haircut',
    'lfk',
    'traffic-report',
    'photo-archive',
    'call-moved',
    'someday',
    'archived-visit',
    'done-late',
    'step-moved',
    'removed-step-moved',
    'doing-idle',
    'visit-ahead',
  ].map((id) => event({ entityKind: 'task', entityId: id, at: old })),
  event({ entityKind: 'task', entityId: 'fansly-notes', at: old }),
  // Eleven days ago, from the task's live step: movement.
  event({
    entityKind: 'step',
    entityId: 'live-step',
    taskId: 'step-moved',
    at: '2026-09-14T08:00:00.000Z',
  }),
  // A step event of an older row without taskId, of a step removed since.
  event({
    entityKind: 'step',
    entityId: 'gone-step',
    at: '2026-09-20T10:00:00.000Z',
  }),
  // Comments and projects are not movement of the task.
  event({
    entityKind: 'comment',
    entityId: 'comment-1',
    taskId: 'fansly-notes',
    command: 'comment.add',
    at: '2026-09-24T08:00:00.000Z',
  }),
];

const snapshot = snapshotSchema.parse({
  generation: GENERATION,
  seq,
  schemaVersion: 9,
  today: TODAY,
  timezone: 'Europe/Moscow',
  projects: [],
  labels: [],
  tasks,
  steps,
  appearance: {
    id: 'owner',
    mode: 'system',
    skinId: 'classic',
    hideP3: false,
    revision: 1,
    updatedAt: null,
  },
});

function audit(): ProposalDraft[] {
  return auditBoard({
    tasks: snapshot.tasks,
    lastEventAt: collectLastEvents({
      tasks: snapshot.tasks,
      steps: snapshot.steps,
      events,
    }),
    today: snapshot.today,
    timezone: snapshot.timezone,
  });
}
const byTask = (drafts: ProposalDraft[]) =>
  new Map(drafts.map((draft) => [draft.taskId, draft]));

describe('night shift audit rules', () => {
  it('archives a visit whose date in the title has passed', () => {
    const drafts = byTask(audit());
    expect(drafts.get('haircut')).toEqual({
      kind: 'task_change',
      taskId: 'haircut',
      baseRevision: 5,
      command: {
        command: 'task.archive',
        payload: { id: 'haircut', baseRevision: 5 },
      },
      reason: 'дата в названии прошла 4 дня назад',
      evidence: [
        {
          source: 'board',
          ref: 'task:haircut',
          at: '2026-09-21',
          quote: '«Стрижка в Барской 21.09», срок 21.09',
        },
      ],
      fingerprint: 'audit:dated:haircut:2026-09-21:5',
      rank: 3,
    });
    expect(drafts.get('lfk')).toMatchObject({
      command: { command: 'task.archive' },
      reason: 'дата в названии прошла 4 дня назад',
      fingerprint: 'audit:dated:lfk:none:3',
      evidence: [{ at: '2026-09-21', quote: '«ЛФК 21.09», срока нет' }],
    });
  });

  it('moves a passed due date a week past today', () => {
    const drafts = byTask(audit());
    expect(drafts.get('traffic-report')).toEqual({
      kind: 'task_change',
      taskId: 'traffic-report',
      baseRevision: 7,
      command: {
        command: 'task.update',
        payload: { id: 'traffic-report', baseRevision: 7, due: '2026-10-02' },
      },
      reason: 'срок прошёл 20.09',
      evidence: [
        {
          source: 'board',
          ref: 'task:traffic-report',
          at: '2026-09-20',
          quote: '«Сдать отчёт по трафику», срок 20.09',
        },
      ],
      fingerprint: 'audit:overdue:traffic-report:2026-09-20:7',
      rank: 2,
    });
    // P3 is spared only by the idle rule; a date in the title other than
    // the due date leaves the overdue rule in charge.
    expect(drafts.get('photo-archive')).toMatchObject({
      command: { command: 'task.update', payload: { due: '2026-10-02' } },
      fingerprint: 'audit:overdue:photo-archive:2026-09-24:3',
      rank: 2,
    });
    expect(drafts.get('call-moved')).toMatchObject({
      command: { command: 'task.update' },
      reason: 'срок прошёл 22.09',
    });
  });

  it('archives a queued task two weeks without events, judged by the journal', () => {
    const drafts = byTask(audit());
    const lastSeq = events.find(
      (item) => item.entityId === 'fansly-notes',
    )?.seq;
    expect(drafts.get('fansly-notes')).toEqual({
      kind: 'task_change',
      taskId: 'fansly-notes',
      baseRevision: 3,
      command: {
        command: 'task.archive',
        payload: { id: 'fansly-notes', baseRevision: 3 },
      },
      reason: '21 день без движения',
      evidence: [
        {
          source: 'board',
          ref: 'task:fansly-notes',
          at: old,
          quote:
            '«Продумать автозаполнение заметок Fansly», последнее событие 04.09',
        },
      ],
      fingerprint: `audit:stale:fansly-notes:${lastSeq}`,
      rank: 3,
    });
  });

  it('leaves alone P3, archive, done, fresh steps, other statuses and future dates', () => {
    const proposed = [...byTask(audit()).keys()];
    for (const id of [
      'someday',
      'archived-visit',
      'done-late',
      'step-moved',
      'removed-step-moved',
      'doing-idle',
      'visit-ahead',
      'no-events',
    ])
      expect(proposed).not.toContain(id);
    expect(proposed.toSorted()).toEqual(
      [
        'call-moved',
        'fansly-notes',
        'haircut',
        'lfk',
        'photo-archive',
        'traffic-report',
      ].toSorted(),
    );
  });
});

describe('night shift audit drafts', () => {
  it('puts overdue first and keeps every payload inside the proposal contract', () => {
    const drafts = audit();
    expect(drafts.map((draft) => draft.rank)).toEqual([2, 2, 2, 3, 3, 3]);
    expect(drafts.map((draft) => draft.taskId).slice(0, 3)).toEqual([
      'traffic-report',
      'call-moved',
      'photo-archive',
    ]);
    for (const draft of drafts) {
      const { command, payload } = draft.command;
      expect(commandPayloadSchemas[command].safeParse(payload).success).toBe(
        true,
      );
      expect(payload.id).toBe(draft.taskId);
      expect(payload.baseRevision).toBe(draft.baseRevision);
      if (command === 'task.update')
        expect(Object.keys(payload).toSorted()).toEqual([
          'baseRevision',
          'due',
          'id',
        ]);
      expect(draft.reason.length).toBeLessThanOrEqual(300);
      expect(draft.fingerprint.length).toBeLessThanOrEqual(200);
      expect(draft.evidence).toHaveLength(1);
      expect(draft.evidence[0].quote.length).toBeLessThanOrEqual(200);
    }
    expect(new Set(drafts.map((draft) => draft.fingerprint)).size).toBe(
      drafts.length,
    );
  });

  it('keeps the fingerprint while the task stays the same and changes it with the task', () => {
    const first = byTask(audit());
    const tomorrow = byTask(
      auditBoard({
        tasks: snapshot.tasks,
        lastEventAt: collectLastEvents({
          tasks: snapshot.tasks,
          steps: snapshot.steps,
          events,
        }),
        today: '2026-09-26',
        timezone: 'Europe/Moscow',
      }),
    );
    for (const id of ['haircut', 'traffic-report', 'fansly-notes'])
      expect(tomorrow.get(id)?.fingerprint).toBe(first.get(id)?.fingerprint);
    expect(tomorrow.get('haircut')?.reason).toBe(
      'дата в названии прошла 5 дней назад',
    );
    const moved = byTask(
      auditBoard({
        tasks: snapshot.tasks.map((item) =>
          item.id === 'traffic-report'
            ? { ...item, due: '2026-09-23', revision: 8 }
            : item,
        ),
        lastEventAt: new Map(),
        today: TODAY,
      }),
    );
    expect(moved.get('traffic-report')?.fingerprint).toBe(
      'audit:overdue:traffic-report:2026-09-23:8',
    );
    // A note edited after the proposal leaves the date alone but makes the
    // earlier proposal stale: the next night proposes again (review of PR #7).
    const edited = byTask(
      auditBoard({
        tasks: snapshot.tasks.map((item) =>
          item.id === 'traffic-report' || item.id === 'haircut'
            ? { ...item, note: 'уточнил', revision: item.revision + 1 }
            : item,
        ),
        lastEventAt: new Map(),
        today: TODAY,
      }),
    );
    expect(edited.get('traffic-report')?.fingerprint).toBe(
      'audit:overdue:traffic-report:2026-09-20:8',
    );
    expect(edited.get('haircut')?.fingerprint).toBe(
      'audit:dated:haircut:2026-09-21:6',
    );
  });
});

const report = (ok: boolean, startedAt: string, from?: string) => ({
  startedAt,
  finishedAt: startedAt,
  ok,
  window: from ? { from, to: startedAt } : null,
  stages: {},
  errors: [],
});

describe('night shift audit helpers', () => {
  it('takes the latest event of a task and of its steps', () => {
    const last = collectLastEvents({ tasks, steps, events });
    expect(last.get('step-moved')?.at).toBe('2026-09-14T08:00:00.000Z');
    expect(last.get('removed-step-moved')?.at).toBe('2026-09-20T10:00:00.000Z');
    expect(last.get('fansly-notes')?.at).toBe(old);
    expect(last.has('no-events')).toBe(false);
  });

  it('reads DD.MM dates in titles near the day the task was created', () => {
    expect(titleDates('Стрижка в Барской 21.09', '2026-09-15')).toEqual([
      '2026-09-21',
    ]);
    expect(titleDates('Отчёт за праздники 05.01', '2026-12-20')).toEqual([
      '2027-01-05',
    ]);
    expect(titleDates('Подать декларацию 30.04.2027', '2026-09-15')).toEqual([
      '2027-04-30',
    ]);
    expect(titleDates('Перенести 21.09 на 28.09', '2026-09-15')).toEqual([
      '2026-09-21',
      '2026-09-28',
    ]);
    for (const title of [
      'Созвон 31.02',
      'Обновить Node до 26.7',
      'Сессия 1.5 часа',
      'Версия 1.21.09',
    ])
      expect(titleDates(title, '2026-09-15'), title).toEqual([]);
  });

  it('declines days in Russian', () => {
    expect(
      [1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map(
        (n) => `${n} ${daysWord(n)}`,
      ),
    ).toEqual([
      '1 день',
      '2 дня',
      '4 дня',
      '5 дней',
      '11 дней',
      '12 дней',
      '14 дней',
      '21 день',
      '22 дня',
      '25 дней',
      '101 день',
      '111 дней',
    ]);
  });

  it('reads from the last good run, at most 48 hours back', () => {
    const now = new Date('2026-09-25T01:30:00.000Z');
    expect(runWindow(null, now)).toEqual({
      from: '2026-09-23T01:30:00.000Z',
      to: '2026-09-25T01:30:00.000Z',
    });
    expect(runWindow(report(true, '2026-09-24T01:30:00.000Z'), now).from).toBe(
      '2026-09-24T01:30:00.000Z',
    );
    expect(
      runWindow(
        report(false, '2026-09-24T01:30:00.000Z', '2026-09-23T10:00:00.000Z'),
        now,
      ).from,
    ).toBe('2026-09-23T10:00:00.000Z');
    expect(runWindow(report(true, '2026-09-20T01:30:00.000Z'), now).from).toBe(
      '2026-09-23T01:30:00.000Z',
    );
  });
});
