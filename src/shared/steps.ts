import { generateKeyBetween } from 'fractional-indexing';
import type { ChecklistItem, Step } from './model.js';
import { compareStrings } from './queries.js';
// Steps of a task (TI-095): records of their own in `state.steps`, shown
// through the task as `checklist`, the projection every reader already
// knows. The projection is derived: `applyCommand` and `applyEvent` refresh
// it after each step change, `readState` builds it from the rows.
const byStepOrder = (a: Step, b: Step) =>
  compareStrings(a.orderKey, b.orderKey) || compareStrings(a.id, b.id);
const isLiveStep = (step: Step) => step.removedAt === null;
export function liveSteps(steps: readonly Step[], taskId: string): Step[] {
  return steps
    .filter((step) => step.taskId === taskId && isLiveStep(step))
    .toSorted(byStepOrder);
}
const toChecklistItem = (step: Step): ChecklistItem => ({
  id: step.id,
  text: step.text,
  done: step.done,
  doneAt: step.doneAt,
  doneBy: step.doneBy,
  doneByLabel: step.doneByLabel,
  result: step.result,
  linkedTaskId: step.linkedTaskId,
  revision: step.revision,
});
export function projectChecklist(
  steps: readonly Step[],
  taskId: string,
): ChecklistItem[] {
  return liveSteps(steps, taskId).map(toChecklistItem);
}
// A step the client drafts before the server has seen it: the projection
// shape with the values a fresh step gets (web editor, desk).
export const draftChecklistItem = (
  id: string,
  text: string,
): ChecklistItem => ({
  id,
  text,
  done: false,
  doneAt: null,
  doneBy: null,
  doneByLabel: null,
  result: '',
  linkedTaskId: null,
  revision: 0,
});
// The order key a step gets at a position among the live steps of its task:
// `index` counts from zero, anything past the end appends.
export function stepKeyAt(live: readonly Step[], index: number): string {
  const n = Math.min(Math.max(index, 0), live.length);
  return generateKeyBetween(
    live[n - 1]?.orderKey ?? null,
    live[n]?.orderKey ?? null,
  );
}
// The keys `generateKeyBetween` would produce by appending steps one after
// another: 0008_steps.sql assigns them to existing rows by their former
// position, and the legacy journal replay assigns them by array index, so the
// tables and the replay agree (data rule variant b, drizzle/v2/README.md).
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function legacyStepKey(index: number): string {
  if (index < 62) return `a${BASE62[index]}`;
  return `b0${BASE62[index - 62]}`;
}
type LegacyChecklistItem = { id: string; text: string; done: boolean };
export function legacyChecklistItems(
  raw: unknown,
): LegacyChecklistItem[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.every(
    (item) =>
      item !== null &&
      typeof item === 'object' &&
      typeof (item as LegacyChecklistItem).id === 'string' &&
      typeof (item as LegacyChecklistItem).text === 'string' &&
      typeof (item as LegacyChecklistItem).done === 'boolean',
  )
    ? (raw as LegacyChecklistItem[])
    : null;
}
// The step records a pre-0008 checklist array stands for: exactly the rows
// the migration writes (keys by position, bookkeeping from the task,
// revision 1, nothing owner-protected), so a journal written before steps
// were records replays to the migrated tables.
export function legacySteps(
  task: {
    id: string;
    createdBy: string;
    createdByLabel: string;
    createdAt: string;
  },
  items: readonly LegacyChecklistItem[],
): Step[] {
  return items.map((item, index) => ({
    id: item.id,
    taskId: task.id,
    text: item.text,
    orderKey: legacyStepKey(index),
    done: item.done,
    doneAt: null,
    doneBy: null,
    doneByLabel: null,
    result: '',
    linkedTaskId: null,
    removedAt: null,
    createdBy: task.createdBy,
    createdByLabel: task.createdByLabel,
    ownerTouchedAt: null,
    ownerFields: [],
    revision: 1,
    createdAt: task.createdAt,
    updatedAt: task.createdAt,
  }));
}
