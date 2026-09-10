import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { Changes, OperationResponse } from '../shared/model.js';
import { commandNames } from '../shared/schemas.js';
import { APPEARANCE_MODES } from '../shared/appearance.js';
const commandColumn = [...commandNames, 'batch'] as const;
const time = (name: string) => integer(name, { mode: 'timestamp_ms' });
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
// One row (id `owner`): the appearance preference of the workspace owner.
// `skin_id` stays free text so an id written by a newer build still reads back
// and falls back to Classic in the client (astra-26).
export const appearance = sqliteTable('appearance', {
  id: text('id').primaryKey(),
  mode: text('mode', { enum: APPEARANCE_MODES }).notNull(),
  skinId: text('skin_id').notNull(),
  revision: integer('revision').notNull(),
  updatedAt: text('updated_at'),
});
export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    area: text('area').notNull(),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
    description: text('description').notNull(),
    color: text('color').notNull(),
    revision: integer('revision').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('projects_area_name').on(t.area, t.nameKey)],
);
export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    area: text('area').notNull(),
    projectId: text('project_id').references(() => projects.id),
    title: text('title').notNull(),
    status: text('status').notNull(),
    note: text('note').notNull(),
    due: text('due'),
    waitingFor: text('waiting_for').notNull(),
    followUp: text('follow_up'),
    orderKey: text('order_key').notNull(),
    focus: integer('focus', { mode: 'boolean' }).notNull(),
    archived: integer('archived', { mode: 'boolean' }).notNull(),
    originSystem: text('origin_system'),
    originRef: text('origin_ref'),
    originUrl: text('origin_url'),
    originVersion: text('origin_version'),
    createdBy: text('created_by').notNull(),
    createdByLabel: text('created_by_label').notNull(),
    ownerTouchedAt: text('owner_touched_at'),
    ownerFields: text('owner_fields', { mode: 'json' })
      .$type<string[]>()
      .notNull(),
    revision: integer('revision').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('tasks_order').on(t.area, t.status, t.orderKey),
    uniqueIndex('tasks_origin').on(t.originSystem, t.originRef),
    index('tasks_area_archive_status').on(t.area, t.archived, t.status),
    index('tasks_project').on(t.projectId),
  ],
);
export const checklistItems = sqliteTable(
  'checklist_items',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    done: integer('done', { mode: 'boolean' }).notNull(),
    position: integer('position').notNull(),
  },
  (t) => [uniqueIndex('checklist_position').on(t.taskId, t.position)],
);
export const comments = sqliteTable(
  'comments',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').notNull(),
    actorLabel: text('actor_label').notNull(),
    text: text('text').notNull(),
    revision: integer('revision').notNull(),
    createdAt: text('created_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => [index('comments_task_created').on(t.taskId, t.createdAt)],
);
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  createdAt: text('created_at').notNull(),
  disabledAt: text('disabled_at'),
});
export const operations = sqliteTable(
  'operations',
  {
    id: text('id').primaryKey(),
    // Position in the operation journal (TI-008): assigned with the result in
    // the same transaction, independent of whether the operation has events.
    operationSeq: integer('operation_seq').notNull(),
    actorId: text('actor_id').notNull(),
    actorLabel: text('actor_label').notNull(),
    command: text('command', { enum: commandColumn }).notNull(),
    commandHash: text('command_hash').notNull(),
    status: integer('status').notNull(),
    result: text('result', { mode: 'json' })
      .$type<OperationResponse>()
      .notNull(),
    firstSeq: integer('first_seq'),
    lastSeq: integer('last_seq'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('operations_created').on(t.createdAt, t.id),
    uniqueIndex('operations_seq').on(t.operationSeq),
  ],
);
export const events = sqliteTable(
  'events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    at: text('at').notNull(),
    actorId: text('actor_id').notNull(),
    actorLabel: text('actor_label').notNull(),
    operationId: text('operation_id').notNull(),
    entityKind: text('entity_kind').notNull(),
    entityId: text('entity_id').notNull(),
    taskId: text('task_id'),
    command: text('command', { enum: commandNames }).notNull(),
    changes: text('changes', { mode: 'json' }).$type<Changes>().notNull(),
    recordRevision: integer('record_revision').notNull(),
    firstSeq: integer('first_seq').notNull(),
    lastSeq: integer('last_seq').notNull(),
  },
  (t) => [
    index('events_entity_revision').on(t.entityKind, t.entityId, t.seq),
    index('events_operation').on(t.operationId),
  ],
);
export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull(),
  image: text('image'),
  createdAt: time('created_at').notNull(),
  updatedAt: time('updated_at').notNull(),
});
export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: time('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: time('created_at').notNull(),
  updatedAt: time('updated_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});
export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: time('access_token_expires_at'),
  refreshTokenExpiresAt: time('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: time('created_at').notNull(),
  updatedAt: time('updated_at').notNull(),
});
export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: time('expires_at').notNull(),
  createdAt: time('created_at').notNull(),
  updatedAt: time('updated_at').notNull(),
});
export const passkey = sqliteTable('passkey', {
  id: text('id').primaryKey(),
  name: text('name'),
  publicKey: text('public_key').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  credentialID: text('credential_id').notNull().unique(),
  counter: integer('counter').notNull(),
  deviceType: text('device_type').notNull(),
  backedUp: integer('backed_up', { mode: 'boolean' }).notNull(),
  transports: text('transports'),
  createdAt: time('created_at'),
  aaguid: text('aaguid'),
});
export const agentKeys = sqliteTable(
  'agent_keys',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    scope: text('scope', { enum: ['read', 'tasks', 'write'] }).notNull(),
    keyHash: text('key_hash').notNull(),
    name: text('name'),
    createdAt: text('created_at').notNull(),
    revokedAt: text('revoked_at'),
  },
  (t) => [
    uniqueIndex('agent_keys_hash').on(t.keyHash),
    index('agent_keys_agent').on(t.agentId),
  ],
);
