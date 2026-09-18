import { describe, expect, it } from 'vitest';
import { applyEvent } from '../../src/shared/commands';
import { defaultAppearance } from '../../src/shared/domain-schemas';
import type { DomainEvent, WorkspaceState } from '../../src/shared/model';
import { WorkspaceStore } from '../../src/web/app/store';
import { makeTask } from './fixtures';
import { draftChecklistItem } from '../../src/shared/steps';

const at = '2026-09-12T12:00:00.000Z';
function state(count = 2): WorkspaceState {
  return {
    labels: [],
    steps: [],
    tasks: Array.from({ length: count }, (_, i) =>
      makeTask({
        id: `t${i}`,
        area: 'agency',
        title: `Task ${i}`,
        revision: 1,
        createdAt: at,
        updatedAt: at,
        checklist: [draftChecklistItem(`step${i}`, 'Keep this step')],
      }),
    ),
    projects: [
      {
        id: 'p',
        area: 'agency',
        name: 'Project',
        description: '',
        color: '#123456',
        revision: 1,
        createdAt: at,
        updatedAt: at,
      },
    ],
    comments: [],
    appearance: [defaultAppearance()],
  };
}
function event(fields: Partial<DomainEvent> = {}): DomainEvent {
  return {
    generation: 'g',
    seq: 1,
    firstSeq: 1,
    lastSeq: 1,
    at,
    actorId: 'agent:writer',
    actorLabel: 'Writer',
    operationId: 'op1',
    command: 'task.update',
    entityKind: 'task',
    entityId: 't0',
    recordRevision: 2,
    changes: { title: { from: 'Task 0', to: 'Changed' } },
    ...fields,
  };
}
function freeze(value: unknown) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
}

describe('TI-083 replay preserves identities used by card subscriptions', () => {
  it('changes only the affected record and collection without mutating prior state', () => {
    const previous = state();
    const copy = structuredClone(previous);
    freeze(previous);
    const next = applyEvent(previous, event());
    expect(previous).toEqual(copy);
    expect(next.tasks[0]).toMatchObject({ title: 'Changed', revision: 2 });
    expect(next.tasks[0]).not.toBe(previous.tasks[0]);
    expect(next.tasks).not.toBe(previous.tasks);
    expect(next.tasks[1]).toBe(previous.tasks[1]);
    expect(next.tasks[0]!.checklist).toBe(previous.tasks[0]!.checklist);
    expect(next.projects).toBe(previous.projects);
    expect(next.comments).toBe(previous.comments);
    expect(next.appearance).toBe(previous.appearance);
  });

  it('keeps 2000 unrelated task selectors stable over 100 separate committed events', () => {
    const initial = state(2000);
    const store = new WorkspaceStore();
    store.loadSnapshot({
      generation: 'g',
      seq: 0,
      schemaVersion: 4,
      today: '2026-09-12',
      timezone: 'UTC',
      labels: [],
      steps: [],
      tasks: initial.tasks,
      projects: initial.projects,
      appearance: initial.appearance[0]!,
    });
    const baseline = store.getSnapshot().data;
    let invalidatedTasks = 0;
    const positions: number[] = [];
    store.subscribe(() => {
      const current = store.getSnapshot();
      positions.push(current.seq);
      invalidatedTasks += baseline.tasks.filter(
        (task, i) => task !== current.data.tasks[i],
      ).length;
    });
    for (let seq = 1; seq <= 100; seq++) {
      const created = makeTask({
        id: `new-${seq}`,
        area: 'agency',
        title: `New ${seq}`,
        revision: 1,
        createdAt: at,
        updatedAt: at,
      });
      store.ingest([
        event({
          seq,
          firstSeq: seq,
          lastSeq: seq,
          operationId: `op${seq}`,
          entityId: created.id,
          command: 'task.create',
          recordRevision: 1,
          changes: Object.fromEntries(
            Object.entries(created).map(([key, value]) => [
              key,
              { from: null, to: value },
            ]),
          ),
        }),
      ]);
    }
    expect(store.getSnapshot().data.tasks).toHaveLength(2100);
    expect(positions).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(invalidatedTasks).toBe(0);
    expect(store.getSnapshot().data.projects).toBe(baseline.projects);
  });

  it('copies the comment and counter task for create, delete and undo restore', () => {
    let previous = state();
    const creation = event({
      entityKind: 'comment',
      entityId: 'c',
      taskId: 't0',
      command: 'comment.add',
      recordRevision: 1,
      changes: {
        createdAt: { from: null, to: at },
        taskId: { from: null, to: 't0' },
        text: { from: null, to: 'Comment' },
        actorId: { from: null, to: 'agent:writer' },
        actorLabel: { from: null, to: 'Writer' },
        deletedAt: { from: null, to: null },
      },
    });
    const deletion = event({
      ...creation,
      command: 'comment.remove',
      recordRevision: 2,
      changes: { deletedAt: { from: null, to: at } },
    });
    const restore = event({
      ...deletion,
      command: 'undo',
      recordRevision: 3,
      changes: { deletedAt: { from: at, to: null } },
    });
    for (const [change, count] of [
      [creation, 1],
      [deletion, 0],
      [restore, 1],
    ] as const) {
      const before = structuredClone(previous);
      freeze(previous);
      const next = applyEvent(previous, change);
      expect(previous).toEqual(before);
      expect(next.tasks[0]!.commentCount).toBe(count);
      expect(next.tasks[0]!.revision).toBe(1);
      expect(next.tasks[0]).not.toBe(previous.tasks[0]);
      expect(next.tasks[1]).toBe(previous.tasks[1]);
      expect(next.projects).toBe(previous.projects);
      expect(next.comments).not.toBe(previous.comments);
      previous = next;
    }
    expect(previous.comments[0]).toMatchObject({
      deletedAt: null,
      revision: 3,
    });
  });

  it('does not count a tombstoned creation and retains missing-prior replay behavior', () => {
    const previous = state();
    freeze(previous);
    const absent = applyEvent(previous, event({ entityId: 'missing' }));
    expect(absent).toEqual(previous);
    const tombstone = applyEvent(
      previous,
      event({
        entityKind: 'comment',
        entityId: 'c',
        taskId: 't0',
        command: 'comment.add',
        changes: {
          createdAt: { from: null, to: at },
          deletedAt: { from: null, to: at },
          taskId: { from: null, to: 't0' },
          actorId: { from: null, to: 'agent:writer' },
          actorLabel: { from: null, to: 'Writer' },
          text: { from: null, to: 'Already deleted' },
        },
      }),
    );
    expect(tombstone.tasks[0]!.commentCount).toBe(0);
    const created = makeTask({
      id: 'new',
      area: 'agency',
      title: 'New',
      commentCount: 99,
      createdAt: at,
    });
    const newTask = applyEvent(
      previous,
      event({
        entityId: 'new',
        command: 'task.create',
        recordRevision: 1,
        changes: Object.fromEntries(
          Object.entries(created).map(([key, value]) => [
            key,
            { from: null, to: value },
          ]),
        ),
      }),
    );
    expect(newTask.tasks.at(-1)!.commentCount).toBe(0);
    expect(previous.tasks).toHaveLength(2);
  });

  it('adjusts counters when snapshot omitted the prior comment without inventing it', () => {
    const previous = state();
    previous.tasks[0]!.commentCount = 3;
    freeze(previous);
    const deletion = event({
      entityKind: 'comment',
      entityId: 'omitted',
      taskId: 't0',
      command: 'comment.remove',
      changes: { deletedAt: { from: null, to: at } },
    });
    const deleted = applyEvent(previous, deletion);
    expect(deleted.tasks[0]!.commentCount).toBe(2);
    expect(deleted.comments).toEqual([]);
    expect(previous.tasks[0]!.commentCount).toBe(3);
    expect(deleted.tasks[1]).toBe(previous.tasks[1]);
    freeze(deleted);
    const restored = applyEvent(
      deleted,
      event({
        ...deletion,
        command: 'undo',
        changes: { deletedAt: { from: at, to: null } },
      }),
    );
    expect(restored.tasks[0]!.commentCount).toBe(3);
    expect(restored.comments).toEqual([]);
    expect(deleted.tasks[0]!.commentCount).toBe(2);
    const absentTask = applyEvent(
      previous,
      event({ ...deletion, taskId: 'missing' }),
    );
    expect(absentTask).toEqual(previous);
    expect(absentTask.tasks).toBe(previous.tasks);
  });

  it('updates project and appearance metadata without invalidating task records', () => {
    const previous = state();
    freeze(previous);
    const project = applyEvent(
      previous,
      event({
        entityKind: 'project',
        entityId: 'p',
        command: 'project.update',
        changes: { name: { from: 'Project', to: 'Renamed' } },
      }),
    );
    expect(project.projects[0]).toMatchObject({ name: 'Renamed', revision: 2 });
    expect(project.tasks).toBe(previous.tasks);
    expect(project.appearance).toBe(previous.appearance);
    freeze(project);
    const appearance = applyEvent(
      project,
      event({
        entityKind: 'appearance',
        entityId: 'owner',
        command: 'appearance.update',
        changes: { skinId: { from: 'classic', to: 'focus' } },
      }),
    );
    expect(appearance.appearance[0]).toMatchObject({
      skinId: 'focus',
      revision: 2,
    });
    expect(appearance.tasks).toBe(previous.tasks);
    expect(appearance.projects).toBe(project.projects);
    expect(previous.projects[0]!.name).toBe('Project');
  });
});
