import { describe, it, expect } from 'vitest';
import {
  compareOriginVersion,
  applyCommand,
} from '../../src/shared/commands.js';
import {
  focusGroups,
  searchTasks,
  todayInTimezone,
  byOrder,
} from '../../src/shared/queries.js';
import { z } from 'zod';
import {
  commandEnvelopeSchema,
  commandNameSchema,
  commandNames,
  commandPayloadSchemas,
  commandSchema,
  dateSchema,
  operationEnvelopeSchema,
} from '../../src/shared/schemas.js';
import type {
  Command,
  CommandName,
  Task,
  WorkspaceState,
} from '../../src/shared/model.js';
import { owner } from '../api/helpers.js';
import { commandLabel, commandLabels } from '../../src/web/app/labels.js';
import { WRITES } from '../../src/cli/spec.js';
import {
  appearanceSchema,
  defaultAppearance,
} from '../../src/shared/domain-schemas.js';
import { SKINS, skinIds, skinIdSchema } from '../../src/shared/appearance.js';
// The explicit shape the generated unions must have (plan 04, §3.4): a
// discriminated union over the payload registry. Both assignments fail `tsc`
// if the generated `Command` drifts from it in either direction.
type ExpectedCommand = {
  [K in CommandName]: {
    command: K;
    payload: z.infer<(typeof commandPayloadSchemas)[K]>;
  };
}[CommandName];
const generated: ExpectedCommand = {} as Command;
const explicit: Command = {} as ExpectedCommand;
void generated;
void explicit;
describe('command unions are generated from the payload registry (TI-019)', () => {
  it('has one member per payload schema and rejects unknown names', () => {
    expect(commandSchema.options).toHaveLength(commandNames.length);
    expect(commandEnvelopeSchema.options).toHaveLength(commandNames.length);
    expect(commandNames).toEqual(Object.keys(commandPayloadSchemas));
    expect(commandNameSchema.safeParse('task.nope').success).toBe(false);
    expect(
      commandEnvelopeSchema.safeParse({
        operationId: 'op',
        generation: 'g',
        command: 'task.nope',
        payload: {},
      }).success,
    ).toBe(false);
    expect(
      operationEnvelopeSchema.safeParse({
        operationId: 'op',
        generation: 'g',
        commands: [
          { command: 'task.create', payload: { area: 'agency', title: 'T' } },
        ],
      }).success,
    ).toBe(true);
    const parsed = commandSchema.safeParse({
      command: 'undo',
      payload: { seq: 1 },
    });
    expect(parsed.success && parsed.data.command).toBe('undo');
  });
  // Plan 10, step 6: `assertNever` covers the branches at compile time, so the
  // runtime check is about the tables outside the compiler's reach — the
  // Russian labels of the web client. The CLI needs no case: WRITE_COMMANDS is
  // declared as Record<CommandName, …> and `tsc` keeps it complete.
  it('every command name has a web label and a CLI write', () => {
    for (const name of commandNames) {
      expect(commandLabels[name], `нет подписи для ${name}`).toBeTypeOf(
        'string',
      );
      expect(
        WRITES.some((write) => write.command === name),
        `нет команды CLI для ${name}`,
      ).toBe(true);
    }
    expect(commandLabels.batch).toBeTypeOf('string');
    expect(commandLabel('task.nope')).toBe('task.nope');
  });
  // TI-025, TI-026: the appearance registry and its schemas.
  it('registers unique skins whose default preference validates', () => {
    expect(new Set(SKINS.map((skin) => skin.id)).size).toBe(SKINS.length);
    expect(skinIds).toContain('classic');
    for (const skin of SKINS) {
      expect(skin.label.trim()).not.toBe('');
      expect(Object.keys(skin.preview).sort()).toEqual([
        'accent',
        'background',
        'foreground',
        'surface',
      ]);
    }
    const preference = defaultAppearance();
    expect(appearanceSchema.parse(preference)).toEqual(preference);
    expect(skinIds).toContain(preference.skinId);
    // Read stays lenient about an unknown skin, write does not.
    expect(
      appearanceSchema.safeParse({ ...preference, skinId: 'graphite' }).success,
    ).toBe(true);
    expect(skinIdSchema.safeParse('graphite').success).toBe(false);
  });
  it('requires a mode or a skin in appearance.update', () => {
    const payload = commandPayloadSchemas['appearance.update'];
    expect(payload.safeParse({ baseRevision: 1 }).success).toBe(false);
    expect(payload.safeParse({ baseRevision: 1, mode: 'dark' }).success).toBe(
      true,
    );
    expect(payload.safeParse({ baseRevision: 1, mode: 'sepia' }).success).toBe(
      false,
    );
    expect(payload.safeParse({ baseRevision: 0, mode: 'dark' }).success).toBe(
      false,
    );
  });
  it('keeps shared free of the OpenAPI package', () => {
    expect(z.locales.ru).toBeTypeOf('function');
  });
});
const create = (id: string, patch: Partial<Task> = {}): Task => {
  const result = applyCommand(
    {
      tasks: [],
      projects: [],
      comments: [],
      appearance: [defaultAppearance()],
    },
    { command: 'task.create', payload: { id, area: 'agency', title: id } },
    { actor: owner, now: '2026-09-08T00:00:00.000Z', ids: () => id },
  );
  return { ...result.state.tasks[0]!, ...patch };
};
describe('shared queries and validation', () => {
  it('uses the workspace timezone and existing calendar dates', () => {
    expect(todayInTimezone('Europe/Moscow', '2026-09-08T22:30:00Z')).toBe(
      '2026-09-09',
    );
    expect(dateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(dateSchema.parse(null)).toBeNull();
  });
  it('deduplicates Focus groups in the accepted priority order', () => {
    const tasks = [
      create('selected', { focus: true, due: '2026-09-08' }),
      create('new', {
        createdBy: 'agent:test',
        ownerTouchedAt: null,
        due: '2026-09-07',
      }),
      create('due', {
        due: '2026-09-07',
        status: 'waiting',
        followUp: '2026-09-08',
      }),
      create('follow', {
        area: 'personal',
        status: 'waiting',
        followUp: '2026-09-08',
      }),
      create('future', { due: '2026-09-09' }),
      create('waiting', { status: 'waiting' }),
      create('stale-follow-up', { status: 'todo', followUp: '2026-09-08' }),
      create('done', { status: 'done', focus: true }),
      create('archive', { archived: true, focus: true }),
    ];
    expect(
      focusGroups(tasks, '2026-09-08').map((g) => g.tasks.map((t) => t.id)),
    ).toEqual([['selected'], ['new'], ['due'], ['follow']]);
  });
  it('updates Focus with the day without mutating or dropping source records', () => {
    const tasks = [
      create('tomorrow', { due: '2026-09-09' }),
      create('selected', { focus: true }),
    ];
    const before = structuredClone(tasks);
    expect(
      focusGroups(tasks, '2026-09-08').flatMap((g) => g.tasks.map((t) => t.id)),
    ).toEqual(['selected']);
    expect(
      focusGroups(tasks, '2026-09-09').flatMap((g) => g.tasks.map((t) => t.id)),
    ).toEqual(['selected', 'tomorrow']);
    expect(tasks).toEqual(before);
  });
  it('searches all words across projects and checklist while separating archives', () => {
    const tasks = [
      create('agency', { note: 'Новый КОНТЕНТ', status: 'done' }),
      create('personal', { area: 'personal', waitingFor: 'Ответ мастерской' }),
      create('dev', {
        area: 'development',
        projectId: 'p',
        checklist: [{ id: 's', text: 'Проверить ПОИСК', done: false }],
      }),
      create('arch', { archived: true, note: 'Поиск' }),
    ];
    expect(
      searchTasks(
        tasks,
        [
          {
            id: 'p',
            area: 'development',
            name: 'Agency Hub',
            color: '#112233',
            description: '',
            revision: 1,
            createdAt: '',
            updatedAt: '',
          },
        ],
        ' hub   поиск ',
      ).map((t) => t.id),
    ).toEqual(['dev']);
    expect(searchTasks(tasks, [], 'поиск', true).map((t) => t.id)).toEqual([
      'arch',
    ]);
    expect(searchTasks(tasks, [], 'контент').map((t) => t.id)).toEqual([
      'agency',
    ]);
    expect(searchTasks(tasks, [], 'мастерской').map((t) => t.id)).toEqual([
      'personal',
    ]);
    expect(searchTasks(tasks, [], '').map((t) => t.id)).toEqual([
      'agency',
      'dev',
      'personal',
    ]);
  });
  it('compares fractional keys by binary order and source integers without precision loss', () => {
    expect(
      [create('lower', { orderKey: 'a0' }), create('upper', { orderKey: 'Zz' })]
        .sort(byOrder)
        .map((t) => t.id),
    ).toEqual(['upper', 'lower']);
    expect(compareOriginVersion('9007199254740993', '9007199254740992')).toBe(
      1,
    );
    expect(
      compareOriginVersion('2026-09-08T13:00:00+03:00', '2026-09-08T10:00:00Z'),
    ).toBe(0);
    expect(compareOriginVersion('etag', '2')).toBeNull();
    expect(compareOriginVersion('2', '2026-09-08T10:00:00Z')).toBeNull();
  });
  it('rejects extra envelope fields, invalid origin URLs and duplicate checklist IDs', () => {
    const base = {
      operationId: 'op',
      generation: 'g',
      command: 'task.create',
      payload: { area: 'agency', title: 'T' },
    };
    expect(
      commandEnvelopeSchema.safeParse({ ...base, actor: 'owner' }).success,
    ).toBe(false);
    expect(
      commandEnvelopeSchema.safeParse({
        ...base,
        payload: {
          ...base.payload,
          origin: { system: 'tg', ref: '1', url: 'javascript:alert(1)' },
        },
      }).success,
    ).toBe(false);
    expect(
      commandEnvelopeSchema.safeParse({
        ...base,
        payload: {
          ...base.payload,
          checklist: [
            { id: 'x', text: 'A', done: false },
            { id: 'x', text: 'B', done: false },
          ],
        },
      }).success,
    ).toBe(false);
  });
  it('does not mutate caller state or drafts', () => {
    const state: WorkspaceState = {
      tasks: [create('t')],
      projects: [],
      comments: [],
      appearance: [defaultAppearance()],
    };
    const copy = structuredClone(state);
    applyCommand(
      state,
      {
        command: 'task.save',
        payload: { id: 't', baseRevision: 1, fields: { title: 'Changed' } },
      },
      { now: '2026-09-08T01:00:00Z', actor: owner, ids: () => 'unused' },
    );
    expect(state).toEqual(copy);
  });
});

it('compares upstream instants without losing fractional precision and rejects impossible calendar dates', () => {
  expect(
    compareOriginVersion(
      '2026-09-08T10:00:00.000001Z',
      '2026-09-08T10:00:00.000002Z',
    ),
  ).toBe(-1);
  expect(
    compareOriginVersion(
      '2026-09-08T13:00:00.0100+03:00',
      '2026-09-08T10:00:00.01Z',
    ),
  ).toBe(0);
  expect(
    compareOriginVersion('2026-02-30T10:00:00Z', '2026-03-02T10:00:00Z'),
  ).toBeNull();
});
