import { describe, it, expect } from 'vitest';
import type { DomainEvent, Project } from '../../src/shared/model';
import { defaultLocation, type LocationState } from '../../src/web/app/url';
import {
  deskOf,
  effectiveProject,
  hiddenP3Count,
  isProjectId,
  latestSeqForTask,
  selectVisibleTasks,
} from '../../src/web/app/selectors';
import { makeTask } from './fixtures';
// План 07, шаг 10 (тест 10 плана): что показывает экран — чистая функция.
// Раньше это жило в `shell.tsx` и проверялось только e2e.
const at = (name: string) => `2026-09-${name}`;
const project: Project = {
  id: 'p1',
  area: 'agency',
  name: 'Маркетинг',
  color: '#3763df',
  description: '',
  revision: 1,
  createdAt: '',
  updatedAt: '',
};
const tasks = [
  makeTask({ id: 't1', area: 'agency', title: 'Очередь', orderKey: 'a0' }),
  makeTask({
    id: 't2',
    area: 'agency',
    title: 'Со сроком',
    orderKey: 'a1',
    due: at('09'),
  }),
  makeTask({
    id: 't3',
    area: 'agency',
    title: 'Жду ответа',
    orderKey: 'a2',
    status: 'waiting',
    followUp: at('10'),
  }),
  makeTask({
    id: 't4',
    area: 'agency',
    title: 'В направлении',
    orderKey: 'a3',
    projectId: 'p1',
  }),
  makeTask({
    id: 't5',
    area: 'development',
    title: 'Другая область',
    orderKey: 'a4',
  }),
  makeTask({
    id: 't6',
    area: 'agency',
    title: 'В фокусе',
    orderKey: 'a5',
    focus: true,
  }),
  makeTask({
    id: 't7',
    area: 'agency',
    title: 'От агента',
    orderKey: 'a6',
    createdBy: 'agent:bot',
    createdByLabel: 'Бот',
  }),
];
const data = { tasks, projects: [project] };
const where = (patch: Partial<LocationState>): LocationState => ({
  ...defaultLocation,
  ...patch,
});
const ids = (list: { id: string }[]) => list.map((t) => t.id);
describe('selectors', () => {
  it('TI-086 keeps manual order across priorities and hides P3 only in the selected area and project', () => {
    const source = {
      projects: [project],
      tasks: [
        makeTask({
          id: 'urgent',
          area: 'agency',
          title: 'Urgent',
          priority: 'p1',
          orderKey: 'a2',
          projectId: 'p1',
        }),
        makeTask({
          id: 'later',
          area: 'agency',
          title: 'Later',
          priority: 'p3',
          orderKey: 'a0',
          projectId: 'p1',
        }),
        makeTask({
          id: 'normal',
          area: 'agency',
          title: 'Normal',
          priority: 'p2',
          orderKey: 'a1',
          projectId: 'p1',
        }),
        makeTask({
          id: 'other-project',
          area: 'agency',
          title: 'Other',
          priority: 'p3',
          orderKey: 'a3',
        }),
        makeTask({
          id: 'other-area',
          title: 'Personal',
          priority: 'p3',
          area: 'personal',
          orderKey: 'a4',
        }),
      ],
    };
    const selection = { ...where({ project: 'p1' }), hideP3: true };
    expect(
      ids(
        selectVisibleTasks(source, { ...selection, hideP3: false }, at('10')),
      ),
    ).toEqual(['later', 'normal', 'urgent']);
    expect(ids(selectVisibleTasks(source, selection, at('10')))).toEqual([
      'normal',
      'urgent',
    ]);
    expect(hiddenP3Count(source, selection, at('10'))).toBe(1);
    expect(
      hiddenP3Count(source, { ...selection, hideP3: false }, at('10')),
    ).toBe(0);
  });
  it('TI-086 counts only P3 tasks hidden after the today filter, including waiting follow-ups', () => {
    const source = {
      projects: [],
      tasks: [
        makeTask({
          id: 'due',
          area: 'agency',
          title: 'Due',
          orderKey: 'a0',
          priority: 'p3',
          due: at('09'),
        }),
        makeTask({
          id: 'waiting',
          area: 'agency',
          title: 'Waiting',
          orderKey: 'a1',
          priority: 'p3',
          status: 'waiting',
          followUp: at('10'),
        }),
        makeTask({
          id: 'later',
          area: 'agency',
          title: 'Later',
          orderKey: 'a2',
          priority: 'p3',
          due: at('11'),
        }),
        makeTask({
          id: 'done',
          area: 'agency',
          title: 'Done',
          orderKey: 'a3',
          priority: 'p3',
          status: 'done',
          due: at('09'),
        }),
      ],
    };
    const selection = { ...where({ today: true }), hideP3: true };
    expect(selectVisibleTasks(source, selection, at('10'))).toEqual([]);
    expect(hiddenP3Count(source, selection, at('10'))).toBe(2);
    expect(hiddenP3Count(source, selection, at('08'))).toBe(0);
    expect(
      ids(
        selectVisibleTasks(source, { ...selection, hideP3: false }, at('10')),
      ),
    ).toEqual(['due', 'waiting']);
  });
  it('TI-086 leaves P3 visible in search, Focus and archive', () => {
    const source = {
      projects: [],
      tasks: [
        makeTask({
          id: 'active-p3',
          area: 'agency',
          title: 'Когда-нибудь',
          priority: 'p3',
          focus: true,
        }),
        makeTask({
          id: 'archived-p3',
          area: 'agency',
          title: 'Когда-нибудь архив',
          priority: 'p3',
          archived: true,
        }),
      ],
    };
    for (const [patch, expected] of [
      [{ q: 'когда' }, 'active-p3'],
      [{ focus: true }, 'active-p3'],
      [{ archive: true }, 'archived-p3'],
      [{ q: 'когда', archiveSearch: true }, 'archived-p3'],
    ] as const) {
      const selection = { ...where(patch), hideP3: true };
      expect(ids(selectVisibleTasks(source, selection, at('10')))).toContain(
        expected,
      );
      expect(hiddenP3Count(source, selection, at('10'))).toBe(0);
    }
  });
  it('board shows the tasks of the area', () => {
    expect(ids(selectVisibleTasks(data, where({}), at('10')))).toEqual([
      't1',
      't2',
      't3',
      't4',
      't6',
      't7',
    ]);
  });
  it('a project narrows the board, `none` keeps the tasks without one', () => {
    expect(
      ids(selectVisibleTasks(data, where({ project: 'p1' }), at('10'))),
    ).toEqual(['t4']);
    expect(
      ids(selectVisibleTasks(data, where({ project: 'none' }), at('10'))),
    ).toEqual(['t1', 't2', 't3', 't6', 't7']);
  });
  it('«На сегодня» keeps due dates and follow-ups that have arrived', () => {
    expect(
      ids(selectVisibleTasks(data, where({ today: true }), at('10'))),
    ).toEqual(['t2', 't3']);
    expect(
      ids(selectVisibleTasks(data, where({ today: true }), at('08'))),
    ).toEqual([]);
  });
  it('search looks through every area and respects the archive switch', () => {
    expect(
      ids(selectVisibleTasks(data, where({ q: 'область' }), at('10'))),
    ).toEqual(['t5']);
    expect(
      ids(
        selectVisibleTasks(
          data,
          where({ q: 'область', archiveSearch: true }),
          at('10'),
        ),
      ),
    ).toEqual([]);
  });
  it('Focus collects the groups of the focus screen', () => {
    const visible = ids(
      selectVisibleTasks(data, where({ focus: true }), at('10')),
    );
    expect(visible).toContain('t6');
    expect(visible).toContain('t7');
    expect(visible).not.toContain('t1');
  });
  it('a project of another area is not selected', () => {
    expect(
      effectiveProject({ area: 'development', project: 'p1' }, [project]),
    ).toBe('all');
    expect(effectiveProject({ area: 'agency', project: 'p1' }, [project])).toBe(
      'p1',
    );
    expect(effectiveProject({ area: 'agency', project: 'none' }, [])).toBe(
      'none',
    );
    expect(isProjectId('all')).toBe(false);
    expect(isProjectId('p1')).toBe(true);
  });
  // TI-078, TI-029: the sidebar renders before the first snapshot, when the
  // store has no date yet; the desk must not throw on it.
  it('the desk tolerates an empty date and counts the focused tasks', () => {
    expect(() => deskOf(tasks, '')).not.toThrow();
    const focused = tasks.map((t, i) =>
      i === 0 ? { ...t, focusKey: 'a0', focus: true } : t,
    );
    expect(deskOf(focused, '').counts.focus).toBe(1);
    expect(deskOf(focused, '2026-09-11').current?.id).toBe(focused[0]!.id);
  });
  it('the position of a task in the journal ignores other tasks', () => {
    const event = (seq: number, entityId: string, taskId?: string) =>
      ({ seq, entityId, ...(taskId ? { taskId } : {}) }) as DomainEvent;
    const events = [
      event(1, 't1'),
      event(2, 't2'),
      event(3, 'c1', 't1'),
      event(4, 't2'),
    ];
    expect(latestSeqForTask(events, 't1')).toBe(3);
    expect(latestSeqForTask(events, 't2')).toBe(4);
    expect(latestSeqForTask([], 't1')).toBe(0);
  });
});
