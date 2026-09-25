import type { Proposal, WorkspaceState } from './model.js';
import { fail } from './errors.js';
import { compareStrings } from './queries.js';

// Agent proposals (spec 2026-09-25, plan 2026-09-25-proposals-phase1 §1):
// the rules the reducer and the read routes share.

// A reference of one or two digits is a number among the shown proposals,
// anything else is an id (proposal ids of one or two digits are refused).
export function findProposal(state: WorkspaceState, ref: string): Proposal {
  if (/^\d\d?$/.test(ref)) {
    const number = Number(ref);
    return (
      state.proposals.find(
        (p) => p.status === 'shown' && p.number === number,
      ) ?? fail('not_found', `Среди показанных нет предложения ${number}.`)
    );
  }
  return (
    state.proposals.find((p) => p.id === ref) ??
    fail('not_found', 'Предложение не найдено.')
  );
}

// Why a proposed change no longer fits its task, or null while it does: the
// task is gone, archived, finished or has moved past the revision the author
// saw.
export function staleReason(
  state: WorkspaceState,
  proposal: Proposal,
): string | null {
  if (proposal.kind !== 'task_change') return null;
  const task = state.tasks.find((t) => t.id === proposal.taskId);
  if (!task) return 'задача не найдена';
  if (task.archived) return 'задача в архиве';
  if (task.status === 'done') return 'задача уже закрыта';
  if (task.revision !== proposal.baseRevision)
    return 'задача изменилась после предложения';
  return null;
}

// Why an accept or reject cannot touch a proposal in this status.
const CLOSED: Record<Proposal['status'], string> = {
  queued: 'Предложение ещё не показано владельцу.',
  shown: 'Предложение показано и ждёт ответа.',
  accepted: 'Предложение уже принято.',
  rejected: 'Предложение уже отклонено.',
  expired: 'Предложение истекло без ответа.',
  stale: 'Предложение устарело: задача изменилась после него.',
};
export const closedMessage = (status: Proposal['status']): string =>
  CLOSED[status];

// The queue order of the morning message: urgent first, then the oldest.
export const byQueue = (a: Proposal, b: Proposal): number =>
  a.rank - b.rank ||
  compareStrings(a.createdAt, b.createdAt) ||
  compareStrings(a.id, b.id);

// A calendar day moved by whole days (YYYY-MM-DD in, YYYY-MM-DD out).
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
