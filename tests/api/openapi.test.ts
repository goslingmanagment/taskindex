import { describe, it, expect } from 'vitest';
import { fixture } from './helpers.js';
import { RESERVED_IDS } from '../../src/shared/schemas.js';
type Parameter = { in: string; name: string; description?: string };
type Operation = {
  operationId?: string;
  summary?: string;
  tags?: string[];
  parameters?: Parameter[];
  security?: unknown[];
};
type Document = {
  paths: Record<string, Record<string, Operation>>;
  tags: { name: string }[];
  security: unknown[];
  components: {
    schemas: Record<string, { properties?: Record<string, unknown> }>;
    securitySchemes: Record<string, Record<string, unknown>>;
  };
};
const EXPECTED_OPERATIONS = [
  'getHealth',
  'getMe',
  'getSnapshot',
  'getAppearance',
  'postCommand',
  'postBatch',
  'listEvents',
  'listTasks',
  'getTaskByOrigin',
  'getTask',
  'listProjects',
  'listLabels',
  'listTaskComments',
  'getTaskHistory',
  'listOperations',
  'getOperation',
  'getExport',
  'streamEvents',
  'getContext',
  'getDigest',
  'getFocus',
];
const EXPECTED_COMPONENTS = [
  'Actor',
  'Me',
  'ChecklistItem',
  'Task',
  'Step',
  'Project',
  'Comment',
  'Event',
  'Snapshot',
  'Appearance',
  'Context',
  'Digest',
  'FocusGroup',
  'OperationError',
  'OperationSuccess',
  'StoredOperation',
  'OperationSummary',
  'EventsPage',
  'Export',
  'CommandEnvelope',
  'BatchEnvelope',
];
async function document(f: ReturnType<typeof fixture>) {
  const response = await f.app.request('/api/openapi.json');
  expect(response.status).toBe(200);
  const text = await response.text();
  return { text, doc: JSON.parse(text) as Document };
}
describe('OpenAPI is a compact contract for agents (TI-049)', () => {
  it('is served with a key, stays under 150 KB and names every operation with summary, tags and security', async () => {
    const f = fixture();
    const denied = await f.app.request('/api/openapi.json', {
      headers: { 'x-test-role': 'none' },
    });
    expect(denied.status).toBe(401);
    const { text, doc } = await document(f);
    expect(text.length).toBeLessThan(150_000);
    const operations = Object.values(doc.paths).flatMap((methods) =>
      Object.values(methods),
    );
    expect(operations).toHaveLength(EXPECTED_OPERATIONS.length);
    const ids = operations.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(EXPECTED_OPERATIONS.length);
    expect(ids).toEqual(expect.arrayContaining(EXPECTED_OPERATIONS));
    const tagNames = doc.tags.map((t) => t.name);
    for (const operation of operations) {
      expect(operation.summary, operation.operationId).toBeTruthy();
      expect(operation.tags?.length, operation.operationId).toBeGreaterThan(0);
      for (const tag of operation.tags!) expect(tagNames).toContain(tag);
      for (const parameter of operation.parameters ?? [])
        if (parameter.in === 'query')
          expect(
            parameter.description,
            `${operation.operationId} ${parameter.name}`,
          ).toBeTruthy();
    }
    expect(doc.components.securitySchemes.bearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(doc.components.securitySchemes.apiKey).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'x-api-key',
    });
    expect(doc.security).toEqual(
      expect.arrayContaining([{ bearer: [] }, { apiKey: [] }]),
    );
    expect(doc.paths['/health']!.get!.security).toEqual([]);
    f.close();
  });
  it('lists the entities and envelopes once as components and refers to them from the routes', async () => {
    const f = fixture();
    const { text, doc } = await document(f);
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(EXPECTED_COMPONENTS),
    );
    expect(doc.components.schemas.Task!.properties!.title).toBeDefined();
    expect(doc.components.schemas.Me!.properties!.generation).toBeDefined();
    expect(doc.components.schemas.Context!.properties!.agents).toBeDefined();
    expect(doc.components.schemas.Digest!.properties!.comments).toBeDefined();
    expect(
      doc.components.schemas.OperationError!.properties!.issues,
    ).toBeDefined();
    expect(
      doc.components.schemas.OperationSummary!.properties!.operationSeq,
    ).toBeDefined();
    expect(JSON.stringify(doc.paths['/api/tasks/{id}']!.get!)).toContain(
      '#/components/schemas/Task',
    );
    // The task schema is defined once: every other use is a $ref.
    expect(text.split('"commentCount":{').length - 1).toBe(1);
    f.close();
  });
  it('every static segment addressing /api/tasks or /api/projects is a reserved identifier (TI-010, TI-011)', async () => {
    const f = fixture();
    const { doc } = await document(f);
    const statics = Object.keys(doc.paths).flatMap((path) => {
      const match = /^\/api\/(?:tasks|projects)\/([^/{]+)/.exec(path);
      return match ? [match[1]!] : [];
    });
    expect(statics).toContain('lookup');
    for (const segment of statics) expect(RESERVED_IDS.has(segment)).toBe(true);
    expect([...RESERVED_IDS].sort()).toEqual([
      'all',
      'by-origin',
      'lookup',
      'none',
    ]);
    f.close();
  });
});
