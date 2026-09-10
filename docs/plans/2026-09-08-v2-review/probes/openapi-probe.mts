// Probe: does .meta({id}) alone yield $ref? does registry.register keep identity? size effect.
import { OpenAPIHono, createRoute, z as zo } from '@hono/zod-openapi';
import { z } from 'zod';
const inner = z.object({ a: z.string(), b: z.number() }).meta({ id: 'Inner' });
const outer = z.object({ items: z.array(inner), one: inner });
const app = new OpenAPIHono();
app.openapi(
  createRoute({
    method: 'get',
    path: '/x',
    responses: {
      200: {
        description: 'd',
        content: { 'application/json': { schema: outer } },
      },
    },
  }),
  (c) => c.json({ items: [], one: { a: '', b: 0 } }),
);
const doc1 = app.getOpenAPIDocument({
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
});
console.log(
  'meta(id) only -> components:',
  JSON.stringify(doc1.components),
  'uses $ref:',
  JSON.stringify(doc1).includes('$ref'),
);
// registry.register path
const app2 = new OpenAPIHono();
const inner2 = z.object({ a: z.string(), b: z.number() });
const reg = app2.openAPIRegistry.register('Inner2', inner2);
console.log('register returns same instance:', reg === inner2);
const outer2 = z.object({ items: z.array(inner2), one: inner2 });
app2.openapi(
  createRoute({
    method: 'get',
    path: '/y',
    responses: {
      200: {
        description: 'd',
        content: { 'application/json': { schema: outer2 } },
      },
    },
  }),
  (c) => c.json({ items: [], one: { a: '', b: 0 } }),
);
const doc2 = app2.getOpenAPIDocument({
  openapi: '3.1.0',
  info: { title: 't', version: '1' },
});
console.log(
  'register on original instance -> $ref used:',
  JSON.stringify(doc2).includes('$ref'),
  'components:',
  Object.keys(doc2.components?.schemas ?? {}),
);
// plain zod z vs zo identity
console.log(
  'zod z === zod-openapi z:',
  z === zo,
  'plain schema has .openapi at runtime after import:',
  typeof (inner2 as any).openapi,
);
