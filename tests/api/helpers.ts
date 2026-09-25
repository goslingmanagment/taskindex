import { randomUUID } from 'node:crypto';
import {
  openDatabase,
  migrate,
  generation,
  readState,
} from '../../src/server/db.js';
import { createApp } from '../../src/server/app.js';
import type { EventHub } from '../../src/server/sse.js';
import type {
  Actor,
  Command,
  OperationResponse,
  OperationSuccess,
} from '../../src/shared/model.js';
export const owner: Actor = {
  id: 'owner',
  label: 'Владелец',
  kind: 'owner',
  scope: 'write',
};
export const agent: Actor = {
  id: 'agent:test-agent',
  agentId: 'test-agent',
  label: 'Тестовый агент',
  kind: 'agent',
  scope: 'write',
};
export const otherAgent: Actor = {
  id: 'agent:other',
  agentId: 'other',
  label: 'Другой агент',
  kind: 'agent',
  scope: 'write',
};
// The night shift (spec 2026-09-25): reads everything, writes proposals only.
export const nightShift: Actor = {
  id: 'agent:night-shift',
  agentId: 'night-shift',
  label: 'Ночная смена',
  kind: 'agent',
  scope: 'propose',
};
export function fixture(
  setup:
    | 'held'
    | 'open'
    | {
        mode?: 'held' | 'open';
        hub?: EventHub;
        sseBacklogLimit?: number;
        now?: () => string;
      } = 'open',
) {
  const {
    mode = 'open',
    now = () => '2026-09-08T12:00:00.000Z',
    ...rest
  } = typeof setup === 'string' ? { mode: setup } : setup;
  const db = openDatabase(':memory:');
  migrate(db);
  const app = createApp({
    ...rest,
    db,
    baseURL: 'http://localhost:3001',
    trustedOrigins: ['http://localhost:5173'],
    writes: mode,
    deploymentId: 'test-deploy',
    now,
    authorize: (r) =>
      r.headers.get('x-test-role') === 'none'
        ? null
        : r.headers.get('x-test-role') === 'agent'
          ? agent
          : r.headers.get('x-test-role') === 'tasks'
            ? { ...agent, scope: 'tasks' }
            : r.headers.get('x-test-role') === 'read'
              ? { ...agent, scope: 'read' }
              : r.headers.get('x-test-role') === 'agent2'
                ? otherAgent
                : r.headers.get('x-test-role') === 'propose'
                  ? nightShift
                  : owner,
  });
  async function post(
    command: Command,
    options: {
      id?: string;
      gen?: string;
      role?: string;
      dryRun?: boolean;
      confirmOwnerFields?: boolean;
    } = {},
  ) {
    const response = await app.request('/api/commands', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:5173',
        'x-test-role': options.role ?? 'owner',
      },
      body: JSON.stringify({
        ...command,
        operationId: options.id ?? randomUUID(),
        generation: options.gen ?? generation(db),
        dryRun: options.dryRun ?? false,
        ...(options.confirmOwnerFields === undefined
          ? {}
          : { confirmOwnerFields: options.confirmOwnerFields }),
      }),
    });
    return {
      status: response.status,
      body: (await response.json()) as OperationResponse,
    };
  }
  async function batch(
    commands: Command[],
    options: {
      id?: string;
      role?: string;
      gen?: string;
      dryRun?: boolean;
      confirmOwnerFields?: boolean;
    } = {},
  ) {
    const response = await app.request('/api/commands/batch', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:5173',
        'x-test-role': options.role ?? 'owner',
      },
      body: JSON.stringify({
        commands,
        operationId: options.id ?? randomUUID(),
        generation: options.gen ?? generation(db),
        dryRun: options.dryRun ?? false,
        ...(options.confirmOwnerFields === undefined
          ? {}
          : { confirmOwnerFields: options.confirmOwnerFields }),
      }),
    });
    return {
      status: response.status,
      body: (await response.json()) as OperationResponse,
    };
  }
  return {
    db,
    app,
    post,
    batch,
    state: () => readState(db),
    close: () => {
      app.closeStreams();
      db.close();
    },
  };
}
export const success = (r: { body: OperationResponse }): OperationSuccess => {
  if (!r.body.ok) throw new Error(JSON.stringify(r.body));
  return r.body;
};
