import { test, expect } from '@playwright/test';
// TI-069: production bundle served by src/server/index.ts (project `static`).
test.use({ baseURL: 'http://localhost:4373' });

test('the production bundle signs the owner in and renders the board', async ({
  page,
}) => {
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': '192.0.2.201' });
  await page.goto('/');
  await page
    .getByRole('textbox', { name: 'Почта', exact: true })
    .fill('owner@example.test');
  await page
    .getByRole('textbox', { name: 'Пароль', exact: true })
    .fill('TaskIndex-e2e-password-2026');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Агентство', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.sync-status')).toHaveAttribute(
    'data-connection',
    'online',
  );
  const health = await page.request.get('/health');
  expect(health.ok()).toBe(true);
  expect(await health.json()).toMatchObject({
    ok: true,
    build: 'isolated-e2e-static',
    writes: 'open',
  });
});

test('index and deep links are revalidated, hashed assets are immutable', async ({
  request,
}) => {
  const index = await request.get('/');
  expect(index.status()).toBe(200);
  expect(index.headers()['content-type']).toContain('text/html');
  expect(index.headers()['cache-control']).toBe('no-cache');
  const html = await index.text();
  const script = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  const style = html.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
  expect(script).toBeTruthy();
  expect(style).toBeTruthy();
  for (const [path, type] of [
    [script!, 'javascript'],
    [style!, 'text/css'],
  ] as const) {
    const asset = await request.get(path);
    expect(asset.status()).toBe(200);
    expect(asset.headers()['content-type']).toContain(type);
    expect(asset.headers()['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
  }
  const favicon = await request.get('/favicon.svg');
  expect(favicon.status()).toBe(200);
  expect(favicon.headers()['cache-control']).toBe('no-cache');
  const deepLink = await request.get('/?area=development&view=list&task=x');
  expect(deepLink.status()).toBe(200);
  expect(deepLink.headers()['content-type']).toContain('text/html');
  expect(await deepLink.text()).toBe(html);
  const missingAsset = await request.get('/assets/missing.js');
  expect(missingAsset.status()).toBe(200);
  expect(missingAsset.headers()['content-type']).toContain('text/html');
});

test('API errors are JSON and every response carries the security headers', async ({
  request,
}) => {
  // Authentication runs before routing: an unknown API path without a session is 401.
  const missing = await request.get('/api/nope');
  expect(missing.status()).toBe(401);
  expect(await missing.json()).toMatchObject({
    ok: false,
    code: 'unauthorized',
  });
  for (const path of ['/', '/api/nope', '/health']) {
    const headers = (await request.get(path)).headers();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['strict-transport-security']).toBeUndefined();
  }
});
