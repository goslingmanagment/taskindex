import { describe, expect, it } from 'vitest';
import { describeEnvelope } from '../../src/web/app/pending';

describe('TI-038 describeEnvelope shows what a stranded envelope contains', () => {
  it('names a single command and extracts its human text', () => {
    expect(
      describeEnvelope({
        operationId: 'op1',
        generation: 'old',
        command: 'task.create',
        payload: { area: 'agency', title: 'Потерянный текст', note: '' },
      }),
    ).toEqual({ title: 'Создана задача', texts: ['Потерянный текст'] });
    expect(
      describeEnvelope({
        operationId: 'op2',
        generation: 'old',
        command: 'task.save',
        payload: {
          id: 'task1',
          baseRevision: 1,
          fields: { note: 'Заметка из черновика', title: 'Новое имя' },
        },
      }),
    ).toEqual({
      title: 'Сохранена карточка',
      texts: ['Новое имя', 'Заметка из черновика'],
    });
    expect(
      describeEnvelope({
        operationId: 'op3',
        generation: 'old',
        command: 'comment.add',
        payload: { taskId: 'task1', text: 'Комментарий' },
      }),
    ).toEqual({ title: 'Добавлен комментарий', texts: ['Комментарий'] });
  });
  it('lists the commands of a batch in order and skips empty fields', () => {
    expect(
      describeEnvelope({
        operationId: 'op4',
        generation: 'old',
        commands: [
          {
            command: 'task.create',
            payload: { area: 'agency', title: 'Первая' },
          },
          {
            command: 'task.move',
            payload: { id: 'task1', baseRevision: 1, status: 'done' },
          },
          {
            command: 'project.create',
            payload: {
              id: 'p1',
              area: 'agency',
              name: 'Направление',
              color: '#000000',
              description: '',
            },
          },
        ],
      }),
    ).toEqual({
      title:
        'Пакет изменений: Создана задача, Задача перемещена, Создано направление',
      texts: ['Первая', 'Направление'],
    });
  });
});
