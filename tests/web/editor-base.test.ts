import { describe, expect, it } from 'vitest';
import {
  editorBaseRevision,
  isFutureBaseError,
  pendingTaskLabel,
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
