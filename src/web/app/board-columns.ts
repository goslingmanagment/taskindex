import { STATUSES, type Status, type Task } from '@shared/model';
import { PRIORITIES, type Priority } from '@shared/labels';

export type BoardColumn = Priority | 'doing' | 'done';
// TI-092: the owner reads the board from the left, so the work in progress
// comes first, then the queue by priority, then the finished tasks.
export const BOARD_COLUMNS = [
  ...STATUSES.filter((status) => status.id === 'doing'),
  ...PRIORITIES.map((priority) => ({
    ...priority,
    color:
      priority.id === 'p1' ? 'var(--destructive)' : 'var(--muted-foreground)',
  })),
  ...STATUSES.filter((status) => status.id === 'done'),
] as const;
// The owner rarely needs finished tasks on the board: the «Готово» column is
// hidden until he turns it on. The archive always shows every column.
export const shownColumns = (showDone: boolean) =>
  showDone
    ? BOARD_COLUMNS
    : BOARD_COLUMNS.filter((column) => column.id !== 'done');

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
