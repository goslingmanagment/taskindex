import type { Actor, Task } from '@shared/model';
export { AREAS, STATUSES } from '@shared/model';
export type { Task, Project, AreaId, Status } from '@shared/model';
export { dateLabel } from '@shared/queries';
export type WorkspaceData = {
  tasks: Task[];
  projects: import('@shared/model').Project[];
};
// TI-074: attribution comes from the actor of this client (`/api/me`), never from a literal.
export function makeTask(
  fields: Pick<Task, 'id' | 'area' | 'title'> & Partial<Task>,
  actor?: Pick<Actor, 'id' | 'label'> | null,
): Task {
  return {
    projectId: null,
    status: 'todo',
    note: '',
    due: null,
    waitingFor: '',
    followUp: null,
    orderKey: '',
    focus: false,
    archived: false,
    checklist: [],
    commentCount: 0,
    originSystem: null,
    originRef: null,
    originUrl: null,
    originVersion: null,
    createdBy: actor?.id ?? 'owner',
    createdByLabel: actor?.label ?? 'Владелец',
    ownerTouchedAt: null,
    ownerFields: [],
    revision: 0,
    createdAt: '',
    updatedAt: '',
    ...fields,
  };
}
