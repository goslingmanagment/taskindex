import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, it, expect } from 'vitest';
import { fixture } from './helpers.js';
import { generation } from '../../src/server/db.js';
import { cacheControl, serveWeb } from '../../src/server/static.js';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
const expectedHeaders = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-dns-prefetch-control': 'off',
  'x-xss-protection': '0',
};
it('sends the same security headers on every response, HSTS never, CSP report-only for now', async () => {
  const f = fixture();
  cleanup.push(f.close);
  const responses = [
    await f.app.request('/api/snapshot'),
    await f.app.request('/health'),
    await f.app.request('/api/nope'),
    await f.app.request('/api/snapshot', {
      headers: { 'x-test-role': 'none' },
    }),
    await f.app.request('/api/commands', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:5173',
        'x-test-role': 'read',
      },
      body: JSON.stringify({
        command: 'task.create',
        payload: { id: 't', area: 'agency', title: 'T' },
        operationId: 'denied',
        generation: generation(f.db),
      }),
    }),
    await f.app.request(`/api/events/stream?generation=${generation(f.db)}`),
  ];
  expect(responses.map((r) => r.status)).toEqual([
    200, 200, 404, 401, 403, 200,
  ]);
  for (const response of responses) {
    for (const [name, value] of Object.entries(expectedHeaders))
      expect(response.headers.get(name), name).toBe(value);
    expect(response.headers.get('strict-transport-security')).toBeNull();
    expect(response.headers.get('content-security-policy')).toBeNull();
    const csp = response.headers.get('content-security-policy-report-only')!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("object-src 'none'");
    expect(response.headers.get('x-powered-by')).toBeNull();
  }
  await responses[5]!.body?.cancel();
});
it('marks hashed assets immutable and everything else no-cache, with index.html for deep links', async () => {
  const root = mkdtempSync(join(tmpdir(), 'taskindex-web-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'assets'));
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><title>TaskIndex</title>',
  );
  writeFileSync(join(root, 'assets', 'index-C5sBns2A.js'), 'console.log(1)');
  writeFileSync(
    join(root, 'favicon.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  const app = serveWeb(new Hono(), root);
  const asset = await app.request('/assets/index-C5sBns2A.js');
  expect(asset.status).toBe(200);
  expect(asset.headers.get('cache-control')).toBe(
    'public, max-age=31536000, immutable',
  );
  expect(asset.headers.get('content-type')).toContain('javascript');
  for (const path of [
    '/',
    '/index.html',
    '/?area=agency',
    '/tasks/deep-link',
    '/favicon.svg',
  ]) {
    const response = await app.request(path);
    expect(response.status, path).toBe(200);
    expect(response.headers.get('cache-control'), path).toBe('no-cache');
  }
  expect(await (await app.request('/tasks/deep-link')).text()).toContain(
    'TaskIndex',
  );
  // Unknown paths fall back to index.html (deep links), never cached.
  const fallback = await app.request('/assets/missing.js');
  expect(fallback.headers.get('cache-control')).toBe('no-cache');
  expect(await fallback.text()).toContain('TaskIndex');
  expect(cacheControl('/srv/web/assets/x.css')).toBe(
    'public, max-age=31536000, immutable',
  );
  expect(cacheControl('/srv/web/index.html')).toBe('no-cache');
});
