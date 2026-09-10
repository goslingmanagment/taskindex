import type { Actor, Task } from '../../src/shared/model';
// Фикстура задачи для веб-тестов. Раньше её роль играл `makeTask` из
// `src/web/lib/workspace.ts`: приложение больше не собирает задачу вручную
// (формы отправляют команду, запись приходит с сервера), а тестам полная
// запись по-прежнему нужна. План 10 перенесёт её в общий `tests/helpers/`.
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
    focusKey: null,
    focusLeftAt: null,
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
