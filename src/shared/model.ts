import type { z } from 'zod';
import type * as contracts from './domain-schemas.js';
import type { BatchEnvelope, CommandEnvelope } from './schemas.js';
export const AREAS = [
  {
    id: 'agency',
    name: 'Агентство',
    color: '#3763df',
    description: 'Команда и ежедневная работа',
  },
  {
    id: 'development',
    name: 'Разработка',
    color: '#7855c7',
    description: 'Продукты и инструменты',
  },
  {
    id: 'personal',
    name: 'Личное',
    color: '#248168',
    description: 'Время для своих дел',
  },
] as const;
export const STATUSES = [
  { id: 'todo', name: 'Очередь', hint: 'Следующее — сверху', color: '#8290a4' },
  {
    id: 'doing',
    name: 'В работе',
    hint: 'То, чем занимаешься сейчас',
    color: '#416ae3',
  },
  {
    id: 'waiting',
    name: 'Жду',
    hint: 'Мяч на другой стороне',
    color: '#bd811d',
  },
  { id: 'done', name: 'Готово', hint: 'Можно выдохнуть', color: '#298467' },
] as const;
export type AreaId = (typeof AREAS)[number]['id'];
export type Status = (typeof STATUSES)[number]['id'];
export type Actor = z.infer<typeof contracts.actorSchema>;
export type Project = z.infer<typeof contracts.projectSchema>;
export type Label = z.infer<typeof contracts.labelSchema>;
export type Task = z.infer<typeof contracts.taskSchema>;
export type Step = z.infer<typeof contracts.stepSchema>;
export type ChecklistItem = z.infer<typeof contracts.checklistItemSchema>;
export type Comment = z.infer<typeof contracts.commentSchema>;
export type Agent = z.infer<typeof contracts.agentSchema>;
export type Appearance = z.infer<typeof contracts.appearanceSchema>;
export type Entity = z.infer<typeof contracts.entitySchema>;
export type Changes = z.infer<typeof contracts.changesSchema>;
export type DomainEvent = z.infer<typeof contracts.eventSchema>;
export type Snapshot = z.infer<typeof contracts.snapshotSchema>;
export type CommandResult = z.infer<typeof contracts.commandResultSchema>;
export type OperationSuccess = z.infer<typeof contracts.operationSuccessSchema>;
export type ErrorCode = z.infer<typeof contracts.errorCodeSchema>;
export type OperationIssue = z.infer<typeof contracts.operationIssueSchema>;
export type OperationError = z.infer<typeof contracts.operationErrorSchema>;
export type OperationResponse = z.infer<
  typeof contracts.operationResponseSchema
>;
export type OperationSummary = z.infer<typeof contracts.operationSummarySchema>;
export type StoredOperation = z.infer<typeof contracts.storedOperationSchema>;
export type ExportData = z.infer<typeof contracts.exportSchema>;
export type Context = z.infer<typeof contracts.contextSchema>;
export type Digest = z.infer<typeof contracts.digestSchema>;
export type FocusDesk = z.infer<typeof contracts.focusDeskSchema>;
export type Scope = Actor['scope'];
export type EntityKind = DomainEvent['entityKind'];
export type WorkspaceState = {
  projects: Project[];
  // The owner's label catalogue (0007), archived records included.
  labels: Label[];
  tasks: Task[];
  // Steps of every task, removed ones included (TI-095); a task shows its
  // live steps as `checklist`, a projection of this collection.
  steps: Step[];
  comments: Comment[];
  // One record (id `owner`), kept in an array so it travels the same record
  // paths as tasks and projects: `records`, `applyEvent`, export, replay.
  appearance: Appearance[];
};
export type { Command, CommandName, CommandOf } from './schemas.js';
export type OperationEnvelope = CommandEnvelope | BatchEnvelope;
export type Page<T> = {
  generation: string;
  seq: number;
  items: T[];
  more: boolean;
  nextCursor: string | null;
};
export type FocusGroup = {
  id: 'selected' | 'new' | 'due' | 'follow-ups';
  title: string;
  tasks: Task[];
};
// Export format: 2 adds operationSeq to operations, 3 adds the appearance
// preference, 4 adds focusKey and focusLeftAt, 5 adds priority, labels,
// closes and hideP3 (2026-09-13), 6 retires the label otvet (2026-09-17),
// 7 adds the label catalogue (2026-09-17), 8 turns steps into records
// (2026-09-18, TI-095). Formats 1-7 are still imported.
export const FORMAT_VERSION = 8;
