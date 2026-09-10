import { describe, it, expect } from 'vitest';
import { commandSchema } from '../../src/shared/schemas';
import type { Command, Project } from '../../src/shared/model';
import {
  commentAddCommand,
  commentRemoveCommand,
  projectSaveCommand,
  taskArchiveCommand,
  taskCreateCommand,
  taskMoveCommand,
  taskRestoreCommand,
  taskSaveCommand,
  undoCommand,
} from '../../src/web/app/commands';
import { makeTask } from './fixtures';
// План 07, шаг 9 (тест 9 плана): билдеры это единственное место, где интерфейс
// превращает намерение в команду. Проверяем состав payload и то, что каждый
// результат проходит схему команды — иначе ошибку нашёл бы только сервер.
const valid = (command: Command) => commandSchema.safeParse(command).success;
const base = () =>
  makeTask({
    id: '11111111-1111-4111-8111-111111111111',
    area: 'agency',
    title: 'Исходное',
    revision: 3,
    orderKey: 'a0',
    createdAt: '2026-09-08T00:00:00Z',
    updatedAt: '2026-09-08T00:00:00Z',
  });
const project = (fields: Partial<Project> = {}): Project => ({
  id: '22222222-2222-4222-8222-222222222222',
  area: 'agency',
  name: 'Маркетинг',
  color: '#3763df',
  description: '',
  revision: 0,
  createdAt: '',
  updatedAt: '',
  ...fields,
});
describe('command builders', () => {
  it('task.save carries only the changed fields', () => {
    const from = base();
    const command = taskSaveCommand({ ...from, note: 'Новая заметка' }, from);
    expect(command).toEqual({
      command: 'task.save',
      payload: {
        id: from.id,
        baseRevision: 3,
        fields: { note: 'Новая заметка' },
      },
    });
    expect(valid(command)).toBe(true);
  });
  it('task.save keeps status and checklist out of fields', () => {
    const from = base();
    const item = {
      id: '33333333-3333-4333-8333-333333333333',
      text: 'Шаг',
      done: false,
    };
    const command = taskSaveCommand(
      { ...from, status: 'doing', checklist: [item], title: 'Другое' },
      from,
    );
    expect(command.payload).toEqual({
      id: from.id,
      baseRevision: 3,
      fields: { title: 'Другое' },
      status: 'doing',
      checklist: [item],
    });
    expect(valid(command)).toBe(true);
  });
  it('task.save without changes sends only the base revision', () => {
    const from = base();
    expect(taskSaveCommand({ ...from }, from).payload).toEqual({
      id: from.id,
      baseRevision: 3,
    });
  });
  it('task.create takes the fields of the form', () => {
    const command = taskCreateCommand({
      id: '44444444-4444-4444-8444-444444444444',
      area: 'development',
      title: 'Новая',
      status: 'doing',
      projectId: null,
      focus: true,
    });
    expect(command).toEqual({
      command: 'task.create',
      payload: {
        id: '44444444-4444-4444-8444-444444444444',
        area: 'development',
        title: 'Новая',
        projectId: null,
        status: 'doing',
        focus: true,
      },
    });
    expect(valid(command)).toBe(true);
  });
  it('task.move names at most one neighbour', () => {
    const from = base();
    const neighbour = { ...from, id: '55555555-5555-4555-8555-555555555555' };
    expect(taskMoveCommand(from, 'todo', neighbour).payload).toMatchObject({
      before: neighbour.id,
    });
    expect(
      taskMoveCommand(from, 'todo', undefined, neighbour).payload,
    ).toMatchObject({ after: neighbour.id });
    expect(valid(taskMoveCommand(from, 'done'))).toBe(true);
  });
  it('archive and restore are separate commands on the same base', () => {
    const from = base();
    expect(taskArchiveCommand(from).command).toBe('task.archive');
    expect(taskRestoreCommand(from).command).toBe('task.restore');
    expect(taskArchiveCommand(from).payload).toEqual({
      id: from.id,
      baseRevision: 3,
    });
    expect(valid(taskArchiveCommand(from))).toBe(true);
    expect(valid(taskRestoreCommand(from))).toBe(true);
  });
  it('project builder picks create or update by revision', () => {
    expect(projectSaveCommand(project()).command).toBe('project.create');
    expect(projectSaveCommand(project({ revision: 2 })).command).toBe(
      'project.update',
    );
    expect(projectSaveCommand(project({ revision: 2 })).payload).toMatchObject({
      baseRevision: 2,
    });
    expect(valid(projectSaveCommand(project()))).toBe(true);
    expect(valid(projectSaveCommand(project({ revision: 2 })))).toBe(true);
  });
  it('comment and undo builders match the schema', () => {
    const add = commentAddCommand(
      base().id,
      '66666666-6666-4666-8666-666666666666',
      'Текст',
    );
    expect(valid(add)).toBe(true);
    expect(valid(commentRemoveCommand(base().id))).toBe(true);
    expect(valid(undoCommand({ seq: 4 }))).toBe(true);
    expect(valid(undoCommand({ operationId: base().id }))).toBe(true);
  });
});
