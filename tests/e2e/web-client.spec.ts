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

test('TI-007 the editor bases its save on the confirmed revision, not on a rejected optimistic move', async ({
  page,
}) => {
  await login(page, 102);
  const id = randomUUID();
  const title = 'TI-007 карточка';
  expect(
    (await command(page, 'task.create', { id, area: 'agency', title })).ok(),
  ).toBe(true);
  await expect(
    page.getByRole('button', { name: `Открыть: ${title}`, exact: true }),
  ).toBeVisible();
  // The move stays pending until the test rejects it definitively (Astra a01-rejected-variant).
  let reject!: () => void;
  const rejected = new Promise<void>((resolve) => {
    reject = resolve;
  });
  await page.route('**/api/commands', async (route) => {
    const data = route.request().postDataJSON();
    if (data.command === 'task.move' && data.payload.id === id) {
      await rejected;
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          code: 'invalid',
          retryable: false,
          message: 'Сосед ушёл.',
        }),
      });
      return;
    }
    await route.continue();
  });
  await page
    .getByRole('button', { name: `Завершить: ${title}`, exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys(localStorage).filter((k) =>
            k.startsWith('taskindex/ops/'),
          ).length,
      ),
    )
    .toBe(1);
  // Opened while the optimistic revision 2 is on screen and the server is still at 1.
  await page
    .getByRole('button', { name: `Открыть: ${title}`, exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Редактирование задачи', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Ожидает подтверждения')).toBeVisible();
  reject();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys(localStorage).filter((k) =>
            k.startsWith('taskindex/ops/'),
          ).length,
      ),
    )
    .toBe(0);
  await expect(page.getByText('Ожидает подтверждения')).toBeHidden();
  await page
    .getByRole('textbox', { name: 'Название задачи', exact: true })
    .fill('TI-007 сохранено после отказа');
  const save = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/commands') &&
      request.method() === 'POST' &&
      request.postDataJSON()?.command === 'task.save',
  );
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  expect((await save).postDataJSON().payload.baseRevision).toBe(1);
  await expect(
    page.getByRole('dialog', { name: 'Редактирование задачи', exact: true }),
  ).toBeHidden();
  const latest = await (await page.request.get(`/api/tasks/${id}`)).json();
  expect(latest).toMatchObject({
    title: 'TI-007 сохранено после отказа',
    status: 'todo',
    revision: 2,
  });
});

test('TI-038 a pending envelope of a previous generation shows its text and can be removed', async ({
  page,
}) => {
  await login(page, 103);
  await page.evaluate(() =>
    localStorage.setItem(
      'taskindex/ops/stale',
      JSON.stringify({
        operationId: 'stale',
        generation: 'stale-generation',
        command: 'task.create',
        payload: { area: 'agency', title: 'Потерянный текст' },
      }),
    ),
  );
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Агентство', exact: true }),
  ).toBeVisible();
  const notice = page.locator('[data-notice="foreign-generation"]');
  await expect(notice).toContainText('Изменение от прежней версии базы');
  await expect(notice).toContainText('Потерянный текст');
  await expect(
    notice.getByRole('button', { name: 'Повторить', exact: true }),
  ).toHaveCount(0);
  await notice.getByRole('button', { name: /^Убрать/ }).click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Агентство', exact: true }),
  ).toBeVisible();
  await expect(notice).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.startsWith('taskindex/ops/')),
    ),
  ).toEqual([]);
});

test('TI-042 browser back returns to the previous view instead of the remembered one', async ({
  page,
}) => {
  await login(page, 104);
  await page.getByRole('button', { name: 'Разработка', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Разработка', exact: true }),
  ).toBeVisible();
  expect(page.url()).toContain('area=development');
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Агентство', exact: true }),
  ).toBeVisible();
  expect(page.url()).not.toContain('area=development');
  await page.goForward();
  await expect(
    page.getByRole('heading', { name: 'Разработка', exact: true }),
  ).toBeVisible();
  // Closing an editor opened from a filtered list keeps the filter in the URL.
  const id = randomUUID();
  expect(
    (
      await command(page, 'task.create', {
        id,
        area: 'development',
        title: 'TI-042 фильтр',
      })
    ).ok(),
  ).toBe(true);
  await page.getByRole('tab', { name: 'Список', exact: true }).click();
  await page
    .getByRole('button', { name: 'Открыть: TI-042 фильтр', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Редактирование задачи', exact: true }),
  ).toBeVisible();
  expect(page.url()).toContain(`task=${id}`);
  await page
    .getByRole('button', { name: 'Закрыть карточку', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Редактирование задачи', exact: true }),
  ).toBeHidden();
  expect(page.url()).toContain('area=development');
  expect(page.url()).toContain('view=list');
  expect(page.url()).not.toContain('task=');
});
