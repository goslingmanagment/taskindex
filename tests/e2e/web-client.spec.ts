import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
// Web-client regressions from the v2 review registry (plan 07).
async function login(page: Page, ip: number) {
  // The fixture has no Nginx: each test gets its own client IP for the login rate limit.
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': `192.0.2.${ip}` });
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
}
async function snapshot(page: Page) {
  return (await page.request.get('/api/snapshot')).json();
}
async function command(page: Page, name: string, payload: object) {
  const state = await snapshot(page);
  return page.request.post('/api/commands', {
    headers: { Origin: new URL(page.url()).origin },
    data: {
      generation: state.generation,
      operationId: randomUUID(),
      command: name,
      payload,
    },
  });
}

test('TI-006 a browser without localStorage shows the degradation banner and sends no command', async ({
  page,
}) => {
  await login(page, 101);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Access denied', 'SecurityError');
      },
    });
  });
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/commands'))
      writes.push(request.url());
  });
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Агентство', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Хранилище браузера недоступно', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Добавить задачу', exact: true }).first(),
  ).toBeDisabled();
  await page.keyboard.press('n');
  await expect(
    page.getByRole('dialog', { name: 'Новая задача', exact: true }),
  ).toBeHidden();
  // Reading still works: an existing task opens in the editor.
  expect(
    (
      await command(page, 'task.create', {
        id: 'ti006-read-only',
        area: 'agency',
        title: 'TI-006 чтение доступно',
      })
    ).ok(),
  ).toBe(true);
  await page
    .getByRole('button', {
      name: 'Открыть: TI-006 чтение доступно',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Название задачи', exact: true }),
  ).toHaveValue('TI-006 чтение доступно');
  await page
    .getByRole('textbox', { name: 'Название задачи', exact: true })
    .fill('TI-006 не должно уйти');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Хранилище браузера недоступно',
  );
  expect(writes).toEqual([]);
});
