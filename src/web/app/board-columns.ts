import { STATUSES, type Status, type Task } from '@shared/model';
import { PRIORITIES, type Priority } from '@shared/labels';

export type BoardColumn = Priority | 'doing' | 'done';
export const BOARD_COLUMNS = [
  ...PRIORITIES.map((priority) => ({
    ...priority,
    color:
      priority.id === 'p1' ? 'var(--destructive)' : 'var(--muted-foreground)',
  })),
  ...STATUSES.filter((status) => status.id === 'doing' || status.id === 'done'),
] as const;

// Older clients and stored operations can still carry waiting. Display those
// records in the queue without rewriting the owner's data on read.
export const visibleStatus = (status: Status) =>
  status === 'waiting' ? 'todo' : status;
export const TASK_STATES = STATUSES.filter((status) => status.id !== 'waiting');
export const boardColumn = (task: Task): BoardColumn =>
  task.status === 'doing' || task.status === 'done'
    ? task.status
    : task.priority;
export const columnStatus = (column: BoardColumn) =>
  column === 'doing' || column === 'done' ? column : 'todo';
export const columnPriority = (column: BoardColumn) =>
  column === 'doing' || column === 'done' ? undefined : column;
export const columnDraftKey = (column: BoardColumn) =>
  column === 'p2' ? 'todo' : column;
