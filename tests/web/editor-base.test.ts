import { describe, expect, it } from 'vitest';
import type { ChecklistItem } from '../../src/shared/model';
import { draftChecklistItem } from '../../src/shared/steps';
import {
  editorBaseRevision,
  isFutureBaseError,
  pendingTaskLabel,
  restoreChecklist,
  stepRevisions,
} from '../../src/web/app/editor-base';
import { makeTask } from './fixtures';

describe('TI-007 editor base comes from the confirmed record', () => {
  const confirmed = makeTask({
    id: 'task1',
    area: 'agency',
    title: 'Подтверждённая',
    revision: 1,
  });
  it('never raises the base above the confirmed revision', () => {
    expect(editorBaseRevision(undefined, confirmed)).toBe(1);
    expect(editorBaseRevision(2, confirmed)).toBe(1);
    expect(editorBaseRevision(1, confirmed)).toBe(1);
  });
  it('keeps an older draft base so the server still checks the fields changed since', () => {
    expect(editorBaseRevision(1, { ...confirmed, revision: 3 })).toBe(1);
  });
  it('recognises the server refusal of a base from the future', () => {
    expect(isFutureBaseError('Базовая версия из будущего.')).toBe(true);
    expect(isFutureBaseError('Конфликт версий.')).toBe(false);
  });
  it('names the unconfirmed command of the opened task', () => {
    const pending = [
      {
        envelope: {
          operationId: 'op1',
          generation: 'gen1',
          command: 'task.move' as const,
          payload: { id: 'task1', baseRevision: 1, status: 'done' as const },
        },
      },
    ];
    expect(pendingTaskLabel(pending, 'task1')).toBe('Задача перемещена');
    expect(pendingTaskLabel(pending, 'other')).toBeUndefined();
    expect(pendingTaskLabel([], 'task1')).toBeUndefined();
  });
});

describe('a restored draft goes over the live steps one by one', () => {
  const step = (id: string, revision: number, done = false): ChecklistItem => ({
    ...draftChecklistItem(id, id),
    revision,
    done,
  });
  const ids = (steps: ChecklistItem[]) =>
    steps.map((s) => `${s.id}:${s.revision}:${s.done ? 'x' : '-'}`);
  it('keeps the owner ticks and shows the steps an agent ticked since', () => {
    const base = [step('a', 1), step('b', 1), step('c', 1)];
    const drafted = [step('a', 1, true), step('b', 1), step('c', 1)];
    const live = [step('a', 1), step('b', 2, true), step('c', 1)];
    const restored = restoreChecklist(drafted, live, stepRevisions(base));
    expect(ids(restored.checklist)).toEqual(['a:1:x', 'b:2:x', 'c:1:-']);
    expect(restored.stale).toBe(true);
  });
  it('honours a removal in the draft, keeps a step added on the server', () => {
    const base = [step('a', 1), step('b', 1), step('c', 1)];
    const drafted = [step('a', 1), step('c', 1), step('new', 0)];
    const live = [step('a', 1), step('b', 1), step('added', 1), step('c', 1)];
    const restored = restoreChecklist(drafted, live, stepRevisions(base));
    expect(ids(restored.checklist)).toEqual([
      'a:1:-',
      'added:1:-',
      'c:1:-',
      'new:0:-',
    ]);
    expect(restored.stale).toBe(true);
  });
  it('drops a step removed on the server and leaves an unchanged draft as is', () => {
    const base = [step('a', 1), step('b', 1)];
    expect(
      restoreChecklist(
        [step('a', 1, true)],
        [step('a', 1), step('b', 1)],
        stepRevisions(base),
      ),
    ).toEqual({ checklist: [step('a', 1, true)], stale: false });
    const gone = restoreChecklist([step('a', 1), step('b', 1)], [step('a', 1)]);
    expect(ids(gone.checklist)).toEqual(['a:1:-']);
    expect(gone.stale).toBe(true);
  });
  it('never drops a live step for a draft that kept no base', () => {
    const restored = restoreChecklist(
      [step('a', 1)],
      [step('a', 1), step('b', 1)],
    );
    expect(ids(restored.checklist)).toEqual(['a:1:-', 'b:1:-']);
  });
});
