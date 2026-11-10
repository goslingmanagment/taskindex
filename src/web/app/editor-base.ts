import type { ChecklistItem, OperationEnvelope, Task } from '@shared/model';
import { commandLabel } from './labels';
// TI-007: every base the editor sends comes from the confirmed record. A restored
// draft may only lower the base (its fields were written against an older revision,
// so the server still checks the fields changed since then); it never raises it.
export function editorBaseRevision(
  restoredBaseRevision: number | undefined,
  confirmed: Task,
): number {
  return restoredBaseRevision === undefined
    ? confirmed.revision
    : Math.min(restoredBaseRevision, confirmed.revision);
}
/** Revisions of the steps a form starts from, by step id. */
export const stepRevisions = (steps: readonly ChecklistItem[]) =>
  Object.fromEntries(steps.map((step) => [step.id, step.revision]));
/**
 * A draft keeps its whole checklist, but the live steps may have moved on
 * since (an agent ticks them through the CLI without touching the task's
 * revision). The draft's steps go over the live ones one by one: a step
 * changed or removed on the server since the draft takes the server's
 * version, a step added there stays. `base` holds the revisions the draft
 * started from; it tells a step the owner removed from one added on the
 * server since. Without it (older drafts) no live step is dropped.
 * `stale` says the result differs from the draft because of the server.
 */
export function restoreChecklist(
  drafted: readonly ChecklistItem[],
  live: readonly ChecklistItem[],
  base?: Readonly<Record<string, number>>,
): { checklist: ChecklistItem[]; stale: boolean } {
  const liveById = new Map(live.map((step) => [step.id, step]));
  const draftedIds = new Set(drafted.map((step) => step.id));
  let stale = false;
  const checklist: ChecklistItem[] = [];
  for (const step of drafted) {
    const current = liveById.get(step.id);
    if (current) {
      if (current.revision === step.revision) checklist.push(step);
      else {
        checklist.push(current);
        stale = true;
      }
    } else if (step.revision > 0) stale = true;
    else checklist.push(step);
  }
  for (const [index, step] of live.entries()) {
    if (draftedIds.has(step.id)) continue;
    if (base?.[step.id] === step.revision) continue;
    stale = true;
    const before = live
      .slice(0, index)
      .findLastIndex((prior) => checklist.some((kept) => kept.id === prior.id));
    const at =
      before < 0
        ? 0
        : checklist.findIndex((kept) => kept.id === live[before]!.id) + 1;
    checklist.splice(at, 0, step);
  }
  return { checklist, stale };
}
export const isFutureBaseError = (message: string) =>
  message.includes('из будущего');
/** Label of the first pending command that touches this task, for the editor indicator. */
export function pendingTaskLabel(
  pending: readonly { envelope: OperationEnvelope }[],
  taskId: string,
): string | undefined {
  for (const { envelope } of pending) {
    const commands = 'commands' in envelope ? envelope.commands : [envelope];
    for (const command of commands)
      if (
        ('id' in command.payload && command.payload.id === taskId) ||
        ('taskId' in command.payload && command.payload.taskId === taskId)
      )
        return commandLabel(command.command);
  }
  return undefined;
}
