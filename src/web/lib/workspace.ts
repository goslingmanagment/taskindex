import type { Task } from '@shared/model';
export { AREAS, STATUSES } from '@shared/model';
export type { Task, Project, AreaId, Status } from '@shared/model';
export { dateLabel, todayInTimezone } from '@shared/queries';
export type WorkspaceData = {
  tasks: Task[];
  projects: import('@shared/model').Project[];
};
export function makeTask(
  fields: Pick<Task, 'id' | 'area' | 'title'> & Partial<Task>,
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
    createdBy: 'owner',
    createdByLabel: 'Дмитрий',
    ownerTouchedAt: null,
    ownerFields: [],
    revision: 0,
    createdAt: '',
    updatedAt: '',
    ...fields,
  };
}
