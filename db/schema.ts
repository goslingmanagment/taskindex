import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const records = sqliteTable('workspace_records', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['task', 'project', 'meta'] }).notNull(),
  data: text('data').notNull(),
  revision: integer('revision').notNull().default(1),
  updatedAt: text('updated_at').notNull(),
});
