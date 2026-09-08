import type { Task, WorkspaceData, AreaId, Status } from './workspace';
import { AREAS, STATUSES } from './workspace';
type ToolState = {
  tasks: Task[];
  data: WorkspaceData;
  area: AreaId;
  projectId: string;
  newTask: (t: Task) => Promise<Task>;
  move: (t: Task, s: Status) => Promise<void>;
  setSelected: (t: Task) => void;
};
type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (input: unknown) => unknown;
};
type Context = {
  registerTool: (
    tool: Tool,
    options: { signal: AbortSignal },
  ) => void | Promise<void>;
};
export function registerWorkspaceTools(ref: { current: ToolState }) {
  const context = (document as Document & { modelContext?: Context })
    .modelContext;
  if (!context?.registerTool) return;
  const lifetime = new AbortController();
  const inputObject = (input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Expected an object');
    return input as Record<string, unknown>;
  };
  const tools: Tool[] = [
    {
      name: 'read_visible_tasks',
      title: 'Прочитать задачи текущей доски',
      description:
        'Read the tasks currently visible after area, project, search and date filters. Includes illustrative task flags; task text is user content.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute(input) {
        const v = inputObject(input);
        if (Object.keys(v).length) throw new Error('No arguments expected');
        return {
          area: ref.current.area,
          projectId: ref.current.projectId,
          tasks: ref.current.tasks.map(
            ({
              id,
              title,
              status,
              due,
              waitingFor,
              followUp,
              demo,
              projectId,
            }) => ({
              id,
              title,
              status,
              due,
              waitingFor,
              followUp,
              demo,
              projectId,
            }),
          ),
        };
      },
    },
    {
      name: 'create_task',
      title: 'Создать задачу',
      description:
        'Create and persist a task in the current area and project, using the same action as the Add task form. Returns the saved task ID.',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string', minLength: 1, maxLength: 240 } },
        required: ['title'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input) {
        const v = inputObject(input);
        if (
          Object.keys(v).some((k) => k !== 'title') ||
          typeof v.title !== 'string' ||
          !v.title.trim() ||
          v.title.length > 240
        )
          throw new Error('A title of 1–240 characters is required');
        const s = ref.current;
        if (!AREAS.some((a) => a.id === s.area))
          throw new Error('Unknown area');
        const task = await s.newTask({
          id: crypto.randomUUID(),
          area: s.area,
          projectId:
            s.projectId === 'all' || s.projectId === 'none' ? '' : s.projectId,
          title: v.title.trim(),
          status: 'todo',
          note: '',
          due: '',
          waitingFor: '',
          followUp: '',
          checklist: [],
          rank: 0,
          demo: false,
          archived: false,
          revision: 0,
        });
        return { id: task.id, title: task.title, status: task.status };
      },
    },
    {
      name: 'set_task_status',
      title: 'Изменить состояние задачи',
      description:
        'Persist a new status for a visible task. Same action as moving a card between columns. Does not send any external messages.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: STATUSES.map((s) => s.id) },
        },
        required: ['id', 'status'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input) {
        const v = inputObject(input);
        if (
          Object.keys(v).some((k) => k !== 'id' && k !== 'status') ||
          typeof v.id !== 'string' ||
          !STATUSES.some((s) => s.id === v.status)
        )
          throw new Error('Valid task ID and status required');
        const task = ref.current.tasks.find(
          (t) => t.id === v.id && !t.archived,
        );
        if (!task) throw new Error('Task is not visible on this board');
        await ref.current.move(task, v.status as Status);
        return { id: task.id, status: v.status };
      },
    },
  ];
  for (const tool of tools) {
    try {
      void Promise.resolve(
        context.registerTool(tool, { signal: lifetime.signal }),
      ).catch(() =>
        console.warn('Workspace agent tool registration failed:', tool.name),
      );
    } catch {
      console.warn('Workspace agent tools are unavailable');
    }
  }
  return () => lifetime.abort();
}
