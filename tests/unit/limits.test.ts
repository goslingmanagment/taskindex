import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { LIMITS } from '../../src/shared/limits.js';
import {
  batchEnvelopeSchema,
  checklistSchema,
  commandPayloadSchemas,
} from '../../src/shared/schemas.js';
import {
  commentSchema,
  projectSchema,
  taskSchema,
} from '../../src/shared/domain-schemas.js';
const stamp = '2026-09-08T12:00:00.000Z';
const task = (patch: Record<string, unknown>) => ({
  id: 't',
  area: 'agency',
  projectId: null,
  title: 'T',
  status: 'todo',
  note: '',
  due: null,
  waitingFor: '',
  followUp: null,
  orderKey: 'a0',
  focus: false,
  archived: false,
  checklist: [],
  commentCount: 0,
  originSystem: null,
  originRef: null,
  originUrl: null,
  originVersion: null,
  createdBy: 'owner',
  createdByLabel: 'Владелец',
  ownerTouchedAt: null,
  ownerFields: [],
  revision: 1,
  createdAt: stamp,
  updatedAt: stamp,
  ...patch,
});
const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    text: 'шаг',
    done: false,
  }));
// Accepts exactly the limit and refuses one more.
function boundary(
  schema: z.ZodType,
  build: (n: number) => unknown,
  limit: number,
  label: string,
) {
  expect(schema.safeParse(build(limit)).success, `${label} = ${limit}`).toBe(
    true,
  );
  expect(
    schema.safeParse(build(limit + 1)).success,
    `${label} = ${limit + 1}`,
  ).toBe(false);
}
describe('LIMITS is the one source of domain limits (TI-060)', () => {
  it('entity schemas accept the limit and refuse limit + 1', () => {
    boundary(
      taskSchema,
      (n) => task({ title: 'x'.repeat(n) }),
      LIMITS.taskTitle,
      'task.title',
    );
    boundary(
      taskSchema,
      (n) => task({ note: 'x'.repeat(n) }),
      LIMITS.taskNote,
      'task.note',
    );
    boundary(
      taskSchema,
      (n) => task({ waitingFor: 'x'.repeat(n) }),
      LIMITS.waitingFor,
      'task.waitingFor',
    );
    boundary(
      taskSchema,
      (n) => task({ checklist: items(n) }),
      LIMITS.checklistItems,
      'task.checklist',
    );
    boundary(
      projectSchema,
      (n) => ({
        id: 'p',
        area: 'agency',
        name: 'x'.repeat(n),
        description: '',
        color: '#112233',
        revision: 1,
        createdAt: stamp,
        updatedAt: stamp,
      }),
      LIMITS.projectName,
      'project.name',
    );
    boundary(
      commentSchema,
      (n) => ({
        id: 'c',
        taskId: 't',
        actorId: 'owner',
        actorLabel: 'Владелец',
        text: 'x'.repeat(n),
        revision: 1,
        createdAt: stamp,
        deletedAt: null,
      }),
      LIMITS.commentText,
      'comment.text',
    );
  });
  it('command schemas share the same limits', () => {
    boundary(
      commandPayloadSchemas['task.create'],
      (n) => ({ area: 'agency', title: 'x'.repeat(n) }),
      LIMITS.taskTitle,
      'task.create.title',
    );
    boundary(
      commandPayloadSchemas['project.create'],
      (n) => ({ area: 'agency', name: 'x'.repeat(n), color: '#112233' }),
      LIMITS.projectName,
      'project.create.name',
    );
    boundary(
      commandPayloadSchemas['comment.add'],
      (n) => ({ taskId: 't', text: 'x'.repeat(n) }),
      LIMITS.commentText,
      'comment.add.text',
    );
    boundary(
      commandPayloadSchemas['checklist.add'],
      (n) => ({ taskId: 't', baseRevision: 1, text: 'x'.repeat(n) }),
      LIMITS.checklistText,
      'checklist.add.text',
    );
    boundary(checklistSchema, items, LIMITS.checklistItems, 'checklist');
    boundary(
      batchEnvelopeSchema,
      (n) => ({
        operationId: 'op',
        generation: 'g',
        commands: Array.from({ length: n }, () => ({
          command: 'task.create',
          payload: { area: 'agency', title: 'T' },
        })),
      }),
      LIMITS.batchCommands,
      'batch.commands',
    );
  });
  it('shared schemas and the server carry no numeric limit literals', () => {
    for (const file of [
      'src/shared/schemas.ts',
      'src/shared/domain-schemas.ts',
      'src/server/app.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source.match(/\.max\(\d+\)/g), file).toBeNull();
      // Regex quantifiers of id and origin slugs come from LIMITS too; the
      // request-id pattern in app.ts is a transport budget, not a limit.
      if (file.startsWith('src/shared/'))
        expect(source.match(/\{1,\d+\}/g), file).toBeNull();
    }
  });
});
