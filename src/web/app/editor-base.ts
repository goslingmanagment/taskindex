import type { OperationEnvelope, Task } from '@shared/model';
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
