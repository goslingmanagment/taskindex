import { describe, expect, it } from 'vitest';
import { taskCount } from '../../src/web/app/labels';

describe('TI-031 taskCount declines «задача» by the Russian rules', () => {
  it.each([
    [0, '0 задач'],
    [1, '1 задача'],
    [2, '2 задачи'],
    [4, '4 задачи'],
    [5, '5 задач'],
    [11, '11 задач'],
    [12, '12 задач'],
    [14, '14 задач'],
    [21, '21 задача'],
    [22, '22 задачи'],
    [25, '25 задач'],
    [101, '101 задача'],
    [104, '104 задачи'],
    [111, '111 задач'],
    [1000, '1000 задач'],
  ])('%i → %s', (count, expected) => {
    expect(taskCount(count)).toBe(expected);
  });
});
