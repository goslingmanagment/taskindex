import assert from 'node:assert/strict';
import test from 'node:test';
import { focusGroups, searchTasks } from '../lib/workspace-queries.ts';

const today = '2026-09-08';
const task = (id, patch = {}) => ({
  id,
  area: 'agency',
  projectId: 'hiring',
  title: id,
  status: 'todo',
  note: '',
  due: '',
  waitingFor: '',
  followUp: '',
  checklist: [],
  rank: 1024,
  demo: false,
  archived: false,
  revision: 1,
  ...patch,
});
const projects = [{ id: 'hub', name: 'Agency Hub', area: 'development' }];

test('global search finds other areas, notes, contacts, project names and checklist text', () => {
  const data = [
    task('agency', { note: 'Новый КОНТЕНТ' }),
    task('dev', {
      area: 'development',
      projectId: 'hub',
      checklist: [{ id: 'step', text: 'Проверить поиск', done: false }],
    }),
    task('personal', { area: 'personal', waitingFor: 'Ответ мастерской' }),
  ];
  assert.deepEqual(
    searchTasks(data, projects, 'контент', false).map((t) => t.id),
    ['agency'],
  );
  assert.deepEqual(
    searchTasks(data, projects, '  hub   ПОИСК ', false).map((t) => t.id),
    ['dev'],
  );
  assert.deepEqual(
    searchTasks(data, projects, 'мастерской', false).map((t) => t.id),
    ['personal'],
  );
});

test('global search separates the archive, respects demo visibility and includes completed tasks', () => {
  const data = [
    task('real', { status: 'done' }),
    task('archived', { archived: true }),
    task('demo', { demo: true }),
  ];
  assert.deepEqual(
    searchTasks(data, [], '', false).map((t) => t.id),
    ['real'],
  );
  assert.deepEqual(
    searchTasks(data, [], '', false, true).map((t) => t.id),
    ['archived'],
  );
  assert.equal(searchTasks(data, [], '', true).length, 2);
});

test('Focus combines all areas without duplicates and leaves future unscheduled waiting tasks out', () => {
  const data = [
    task('picked', {
      focus: true,
      due: today,
      status: 'waiting',
      followUp: today,
    }),
    task('overdue', { area: 'development', due: '2026-09-07' }),
    task('both-dates', { due: today, status: 'waiting', followUp: today }),
    task('follow-up', { area: 'personal', status: 'waiting', followUp: today }),
    task('future', { due: '2026-09-09' }),
    task('waiting', { status: 'waiting' }),
    task('stale-follow-up', { status: 'todo', followUp: today }),
  ];
  assert.deepEqual(
    focusGroups(data, today, false).map((g) => g.tasks.map((t) => t.id)),
    [['picked'], ['overdue', 'both-dates'], ['follow-up']],
  );
});

test('Focus omits completed, archived and hidden demo tasks even when selected', () => {
  const data = [
    task('done', { focus: true, status: 'done' }),
    task('archived', { focus: true, archived: true }),
    task('demo', { focus: true, demo: true }),
    task('legacy'),
    task('selected', { focus: true }),
  ];
  assert.deepEqual(
    focusGroups(data, today, false).flatMap((g) => g.tasks.map((t) => t.id)),
    ['selected'],
  );
});

test('Focus changes with the local day and never mutates or drops the input records', () => {
  const data = [
    task('tomorrow', { due: '2026-09-09' }),
    task('first', { focus: true, rank: 1 }),
  ];
  const before = structuredClone(data);
  assert.deepEqual(
    focusGroups(data, today, false).flatMap((g) => g.tasks.map((t) => t.id)),
    ['first'],
  );
  assert.deepEqual(
    focusGroups(data, '2026-09-09', false).flatMap((g) =>
      g.tasks.map((t) => t.id),
    ),
    ['first', 'tomorrow'],
  );
  assert.deepEqual(data, before);
});
