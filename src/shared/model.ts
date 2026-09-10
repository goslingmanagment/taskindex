import type { z } from 'zod';
import type * as contracts from './domain-schemas.js';
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
export type Me = z.infer<typeof contracts.meSchema>;
export type Project = z.infer<typeof contracts.projectSchema>;
export type Task = z.infer<typeof contracts.taskSchema>;
export type Comment = z.infer<typeof contracts.commentSchema>;
export type Agent = z.infer<typeof contracts.agentSchema>;
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
export type EventsPage = z.infer<typeof contracts.eventsPageSchema>;
export type OperationSummary = z.infer<typeof contracts.operationSummarySchema>;
export type StoredOperation = z.infer<typeof contracts.storedOperationSchema>;
export type ExportData = z.infer<typeof contracts.exportSchema>;
export type Context = z.infer<typeof contracts.contextSchema>;
export type Digest = z.infer<typeof contracts.digestSchema>;
export type Health = z.infer<typeof contracts.healthSchema>;
export type Scope = Actor['scope'];
export type ChecklistItem = Task['checklist'][number];
export type EntityKind = DomainEvent['entityKind'];
export type WorkspaceState = {
  projects: Project[];
  tasks: Task[];
  comments: Comment[];
};
export type Command = import('./schemas.js').Command;
export type CommandEnvelope = import('./schemas.js').CommandEnvelope;
export type BatchEnvelope = import('./schemas.js').BatchEnvelope;
export type CommandName = import('./schemas.js').CommandName;
export type CommandOf<K extends CommandName> =
  import('./schemas.js').CommandOf<K>;
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
// Export format: 2 adds operationSeq to operations (2026-09-10); format 1
// exports are still imported, see exportSchemaV1.
export const FORMAT_VERSION = 2;
