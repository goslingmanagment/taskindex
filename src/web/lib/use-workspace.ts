import { useSyncExternalStore } from 'react';
import type { Command, Project, Task } from '@shared/model';
import { workspaceStore } from '../app/store';
export { ApiError } from '../app/api';
const editableFields = [
  'area',
  'projectId',
  'title',
  'note',
  'due',
  'waitingFor',
  'followUp',
  'focus',
] as const;
export function taskSaveCommand(task: Task, base: Task): Command {
  const fields: Record<string, unknown> = {};
  for (const field of editableFields)
    if (JSON.stringify(task[field]) !== JSON.stringify(base[field]))
      fields[field] = task[field];
  return {
    command: 'task.save',
    payload: {
      id: task.id,
      baseRevision: base.revision,
      ...(Object.keys(fields).length ? { fields } : {}),
      ...(task.status !== base.status ? { status: task.status } : {}),
      ...(JSON.stringify(task.checklist) !== JSON.stringify(base.checklist)
        ? { checklist: task.checklist }
        : {}),
    },
  };
}
export function useWorkspace() {
  const state = useSyncExternalStore(
    workspaceStore.subscribe,
    workspaceStore.getSnapshot,
    workspaceStore.getSnapshot,
  );
  return {
    ...state,
    data: state.data,
    refresh: workspaceStore.refresh,
    pendingCount: state.pending.length,
    saveTask: async (task: Task, base?: Task, operationId?: string) => {
      const command: Command = task.revision
        ? taskSaveCommand(
            task,
            base ?? state.confirmed.tasks.find((t) => t.id === task.id) ?? task,
          )
        : {
            command: 'task.create',
            payload: {
              id: task.id,
              area: task.area,
              projectId: task.projectId,
              title: task.title,
              status: task.status,
              note: task.note,
              due: task.due,
              waitingFor: task.waitingFor,
              followUp: task.followUp,
              focus: task.focus,
              checklist: task.checklist,
            },
          };
      const result = await workspaceStore.submit(command, operationId);
      return { task: result.results[0]!.record as Task, result };
    },
    saveProject: async (project: Project, operationId?: string) => {
      const result = await workspaceStore.submit(
        project.revision
          ? {
              command: 'project.update',
              payload: {
                id: project.id,
                baseRevision: project.revision,
                name: project.name,
                color: project.color,
                description: project.description,
              },
            }
          : {
              command: 'project.create',
              payload: {
                id: project.id,
                area: project.area,
                name: project.name,
                color: project.color,
                description: project.description,
              },
            },
        operationId,
      );
      return result.results[0]!.record as Project;
    },
  };
}
