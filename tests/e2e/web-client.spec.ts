import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { postCommand as command, signIn } from './helpers';
// Web-client regressions from the v2 review registry (plan 07).

test('TI-006 a browser without localStorage shows the degradation banner and sends no command', async ({
  page,
}, testInfo) => {
  await signIn(page, testInfo);
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
}, testInfo) => {
  await signIn(page, testInfo);
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
}, testInfo) => {
  await signIn(page, testInfo);
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
}, testInfo) => {
  await signIn(page, testInfo);
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

test('TI-032 the activity tells what changed in words, not in ids and JSON', async ({
  page,
}, testInfo) => {
  await signIn(page, testInfo);
  const projectId = randomUUID(),
    taskId = randomUUID(),
    itemId = randomUUID();
  expect(
    (
      await command(page, 'project.create', {
        id: projectId,
        area: 'agency',
        name: 'Клиенты',
        description: '',
        color: '#3763df',
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await command(page, 'task.create', {
        id: taskId,
        area: 'agency',
        title: 'ТИ-032 читаемая история',
      })
    ).ok(),
  ).toBe(true);
  // A move to another column, a project assignment and a checklist step: the
  // three shapes the history used to show as `todo`, an id and raw JSON.
  expect(
    (
      await command(page, 'task.save', {
        id: taskId,
        baseRevision: 1,
        fields: { projectId },
        status: 'doing',
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await command(page, 'checklist.add', {
        taskId,
        id: itemId,
        baseRevision: 2,
        text: 'Позвонить клиенту',
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await command(page, 'checklist.update', {
        taskId,
        itemId,
        baseRevision: 3,
        done: true,
      })
    ).ok(),
  ).toBe(true);
  await page.getByRole('button', { name: 'Активность', exact: true }).click();
  const rows = page.locator('.operation-row');
  await expect(rows.first()).toBeVisible();
  for (const index of [0, 1, 2, 3])
    await rows
      .nth(index)
      .locator('.operation-heading')
      .getByRole('button')
      .first()
      .click();
  await expect(page.getByText('Загружаем изменения…')).toHaveCount(0);
  const history = page.locator('.event-list');
  await expect(
    history.getByText('Шаг «Позвонить клиенту» отмечен выполненным'),
  ).toBeVisible();
  await expect(
    history.getByText('Добавлен шаг «Позвонить клиенту»'),
  ).toBeVisible();
  await expect(history.getByText('«Очередь» → «В работе»')).toBeVisible();
  await expect(history.getByText('без направления → «Клиенты»')).toBeVisible();
  // The caveat: the project name comes from today's directory, not the event.
  await expect(history.getByText('название на сегодня').first()).toBeVisible();
  // No internal enum id, order key or JSON leaks into the story.
  const story = (await page.locator('.event-row dd').allTextContents()).join(
    '\n',
  );
  expect(story).not.toMatch(/todo|doing|orderKey|[{[]|"done"/);
  // The raw payload stays one click away: bookkeeping never becomes a sentence,
  // but it is still readable verbatim.
  const details = page
    .getByRole('button', { name: 'Технические детали', exact: true })
    .first();
  await expect(details).toBeVisible();
  await details.click();
  await expect(page.locator('.event-raw').first()).toContainText('createdBy');
  // A creation reads as the values it started with, not as «не задано → …».
  await expect(
    page.getByText('ТИ-032 читаемая история', { exact: false }).last(),
  ).toBeVisible();
});
