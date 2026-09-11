import { describe, it, expect } from 'vitest';
import type { DomainEvent, Project } from '../../src/shared/model';
import { defaultLocation, type LocationState } from '../../src/web/app/url';
import {
  deskOf,
  effectiveProject,
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
