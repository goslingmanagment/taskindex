import type { Comment, Project, Task, WorkspaceState } from './model.js';

// Ж11 (plan 09, step 8): the one place that knows the kinds of records. Adding
// a kind to ENTITY_KINDS without describing it here fails `tsc`, and every
// dispatch over kinds — `records`, `isSubjectField`, the event schema enum and
// the replay of an export — reads it from this table instead of repeating the
// list. The server side of the registry (table, row codec, import order) waits
// for a kind whose storage is not already covered by `writeState`.
export const ENTITY_KINDS = [
  'task',
  'project',
  'comment',
  'appearance',
] as const;
export type EntityKindName = (typeof ENTITY_KINDS)[number];

// Subject fields: what undo restores, what conflicts are detected on and what
// the owner's touch protects. Declared over the record keys, so a renamed
// field fails `tsc`.
const taskFields = new Set<keyof Task>([
  'area',
  'projectId',
  'title',
  'status',
  'note',
  'due',
  'waitingFor',
  'followUp',
  'orderKey',
  'focus',
  'focusKey',
  'focusLeftAt',
  'archived',
  'checklist',
  'originUrl',
]);
const projectFields = new Set<keyof Project>(['name', 'color', 'description']);
const commentFields = new Set<keyof Comment>(['deletedAt']);
const appearanceFields = new Set(['mode', 'skinId']);

export type EntityDefinition = {
  // Where the records of this kind live in the workspace state.
  collection: keyof WorkspaceState;
  subjectFields: ReadonlySet<string>;
};

const fields = (set: ReadonlySet<string>): ReadonlySet<string> => set;

export const ENTITIES = {
  task: { collection: 'tasks', subjectFields: fields(taskFields) },
  project: { collection: 'projects', subjectFields: fields(projectFields) },
  comment: { collection: 'comments', subjectFields: fields(commentFields) },
  appearance: {
    collection: 'appearance',
    subjectFields: fields(appearanceFields),
  },
} satisfies Record<EntityKindName, EntityDefinition>;
