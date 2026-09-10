// R5: does app.use('/api/commands', mw) also match /api/commands/batch in hono 4.13.7?
import { Hono } from '/Users/dmitriy/code/taskindex/node_modules/hono/dist/index.js';
const app = new Hono();
const hits: string[] = [];
app.use('/api/commands', async (c, next) => {
  hits.push('mw-commands:' + c.req.path);
  await next();
});
app.use('/api/commands/batch', async (c, next) => {
  hits.push('mw-batch:' + c.req.path);
  await next();
});
app.post('/api/commands', (c) => c.text('ok'));
app.post('/api/commands/batch', (c) => c.text('ok'));
await app.request('/api/commands', { method: 'POST' });
await app.request('/api/commands/batch', { method: 'POST' });
console.log(JSON.stringify(hits));
