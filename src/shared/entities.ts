import type {
  Comment,
  Label,
  Project,
  Step,
  Task,
  WorkspaceState,
} from './model.js';

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
  'label',
  'step',
] as const;
type EntityKindName = (typeof ENTITY_KINDS)[number];

// Subject fields: what undo restores, what conflicts are detected on and what
// the owner's touch protects. Declared over the record keys, so a renamed
// field fails `tsc`.
const taskFields = new Set<keyof Task>([
  'area',
  'projectId',
  'title',
  'status',
  'priority',
  'labels',
  'closes',
  'note',
  'due',
  'waitingFor',
  'followUp',
  'orderKey',
  'focus',
  'focusKey',
  'focusLeftAt',
  'archived',
  'originUrl',
]);
const projectFields = new Set<keyof Project>(['name', 'color', 'description']);
const commentFields = new Set<keyof Comment>(['deletedAt']);
// A step (TI-095): its wording, place, tick, outcome, link and existence.
// doneAt/doneBy travel with `done` so undo of a tick restores them together.
const stepFields = new Set<keyof Step>([
  'text',
  'orderKey',
  'done',
  'doneAt',
  'doneBy',
  'doneByLabel',
  'result',
  'linkedTaskId',
  'removedAt',
]);
// What executing a step touches: its tick, its outcome and the task it grew
// into. The owner writing a step does not decide these, so they stay open to
// the agent that executes the step (owner decision 2026-09-18, TI-095).
export const STEP_EXECUTION_FIELDS: ReadonlySet<string> = new Set<keyof Step>([
  'done',
  'doneAt',
  'doneBy',
  'doneByLabel',
  'result',
  'linkedTaskId',
]);
const labelFields = new Set<keyof Label>([
  'name',
  'color',
  'description',
  'archivedAt',
]);
const appearanceFields = new Set(['mode', 'skinId', 'hideP3']);

type EntityDefinition = {
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
  label: { collection: 'labels', subjectFields: fields(labelFields) },
  step: { collection: 'steps', subjectFields: fields(stepFields) },
} satisfies Record<EntityKindName, EntityDefinition>;
