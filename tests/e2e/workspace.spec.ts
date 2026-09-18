import { test, expect, type Page } from '@playwright/test';
import type { Snapshot, Task, OperationError } from '../../src/shared/model';
import {
  TOUCH_HOLD_MS,
  command,
  openWorkspace,
  signIn,
  snapshot as snapshotOf,
} from './helpers';
// TI-070: спека больше не хранит общих cookies и не снимает эталон. Сессия
// владельца приходит из проекта `setup` через `storageState`, снимки эталона
// живут в `visual.spec.ts`, поэтому порядок тестов внутри файла ничего не решает.
async function createTask(page: Page, title: string) {
  await page
    .getByRole('button', { name: 'Добавить задачу', exact: true })
    .first()
    .click();
  await page
    .getByRole('textbox', { name: 'Что нужно сделать?', exact: true })
    .fill(title);
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Новая задача', exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole('heading', { name: title, exact: true }),
  ).toBeVisible();
}
test('real owner login, atomic editor save, comments, and operation history', async ({
  page,
}) => {
  await openWorkspace(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const title = 'Э2Э: атомарное сохранение';
  await createTask(page, title);
  await page
    .getByRole('button', { name: `Открыть: ${title}`, exact: true })
    .click();
  await page.getByRole('button', { name: 'Заметка', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Заметка к задаче', exact: true })
    .fill('Контекст владельца');
  await page
    .getByRole('combobox', { name: 'Состояние задачи', exact: true })
    .click();
  await expect(
    page.getByRole('option', { name: 'Жду', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('option', { name: 'В работе', exact: true }).click();
  const save = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/commands') &&
      request.method() === 'POST' &&
      request.postDataJSON()?.command === 'task.save',
  );
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  const payload = (await save).postDataJSON().payload;
  expect(payload).toMatchObject({
    fields: { note: 'Контекст владельца' },
    status: 'doing',
  });
  expect(payload.fields).not.toHaveProperty('title');
  expect(payload).not.toHaveProperty('checklist');
  await page
    .getByRole('button', { name: `Открыть: ${title}`, exact: true })
    .click();
  await page.getByRole('button', { name: /^Комментарии/ }).click();
  await page
    .getByRole('textbox', { name: 'Новый комментарий', exact: true })
    .fill('Проверено на реальном API');
  await page
    .getByRole('button', { name: 'Добавить комментарий', exact: true })
    .click();
  await expect(
    page.getByText('Проверено на реальном API', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'История', exact: true }).click();
  await expect(
    page.getByText('Сохранена карточка', { exact: true }),
  ).toBeVisible();
});
test('conflicting edit retains owner text and recovers a draft after reload', async ({
  page,
}) => {
  await openWorkspace(page);
  const title = 'Э2Э: конфликт';
  await createTask(page, title);
  await page
    .getByRole('button', { name: `Открыть: ${title}`, exact: true })
    .click();
  await page
    .getByRole('textbox', { name: 'Название задачи', exact: true })
    .fill('Моя версия');
  const snapshot = (await (
    await page.request.get('/api/snapshot')
  ).json()) as Snapshot;
  const task = snapshot.tasks.find((t) => t.title === title)!;
  await command(page, 'task.update', {
    id: task.id,
    baseRevision: task.revision,
    title: 'Версия другой сессии',
  });
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(
    page.getByRole('textbox', { name: 'Название задачи', exact: true }),
  ).toHaveValue('Моя версия');
  await expect(
    page.getByRole('button', { name: 'Совместить и проверить', exact: true }),
  ).toBeVisible();
  page.on('dialog', (dialog) => void dialog.accept());
  await page.reload();
  await expect(
    page.getByRole('textbox', { name: 'Название задачи', exact: true }),
  ).toHaveValue('Моя версия');
});
test('mobile navigation, focus/search/archive and keyboard task movement', async ({
  page,
}) => {
  await openWorkspace(page);
  await page.keyboard.press('n');
  await expect(
    page.getByRole('dialog', { name: 'Новая задача', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('dialog', { name: 'Новая задача', exact: true }),
  ).toBeHidden();
  await page.keyboard.press('Meta+k');
  await expect(
    page.getByRole('textbox', { name: 'Найти во всех областях', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  const projectId = 'e2e-keyboard';
  await command(page, 'project.create', {
    id: projectId,
    area: 'agency',
    name: 'Клавиатурный перенос',
    color: '#3763df',
  });
  await page.goto(`/?area=agency&project=${projectId}&view=board`);
  const title = 'Э2Э: перенос';
  await createTask(page, title);
  const handle = page.getByRole('button', {
    name: `Перетащить: ${title}`,
    exact: true,
  });
  await handle.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('article.dragging')).toHaveCount(1);
  // KeyboardSensor installs its document listener on the next task; droppable
  // measurements finish on the following animation frame.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.keyboard.press('ArrowRight');
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /was moved over droppable area column-p3\./ }),
  ).toHaveCount(1);
  await page.keyboard.press('Space');
  const snapshot = (await (
    await page.request.get('/api/snapshot')
  ).json()) as Snapshot;
  const task = snapshot.tasks.find((t) => t.title === title)!;
  // The keyboard drag must create a move operation, not just move a visual overlay.
  await expect
    .poll(async () => {
      const latest = (await (
        await page.request.get(`/api/tasks/${task.id}`)
      ).json()) as Task;
      return latest.priority;
    })
    .toBe('p3');
  await command(page, 'task.update', {
    id: task.id,
    baseRevision: (
      (await (await page.request.get(`/api/tasks/${task.id}`)).json()) as Task
    ).revision,
    focus: true,
    // TI-078: экран Focus это стол — видна текущая задача и две следующие,
    // поэтому задача ставится в начало стола, а не в конец очереди.
    focusPosition: { first: true },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('button', { name: 'Открыть навигацию', exact: true })
    .click();
  await page.getByRole('button', { name: /^Фокус/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Фокус', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: title, exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Открыть поиск', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: 'Найти во всех областях', exact: true })
    .fill(title);
  await expect(
    page.getByRole('heading', { name: title, exact: true }),
  ).toBeVisible();
  // TI-031: the search scope declines the count («1 задача», not «1 задач»).
  await expect(page.locator('.overview-scope')).toHaveText(
    'Все области · 1 задача',
  );
  await page
    .getByRole('textbox', { name: 'Найти во всех областях', exact: true })
    .press('Escape');
  const latest = (await (
    await page.request.get(`/api/tasks/${task.id}`)
  ).json()) as Task;
  await command(page, 'task.archive', {
    id: task.id,
    baseRevision: latest.revision,
  });
  await page
    .getByRole('button', { name: 'Открыть навигацию', exact: true })
    .click();
  await page.getByRole('button', { name: /^Архив/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Архив', exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Список', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: title, exact: true }),
  ).toBeVisible();
});

test('reload after the server commits but its response is lost never creates a duplicate', async ({
  page,
}) => {
  await page.route('**/api/events/stream**', (route) => route.abort());
  await openWorkspace(page);
  const title = 'Э2Э: потерянный ответ';
  let committed!: () => void;
  const onCommit = new Promise<void>((resolve) => {
    committed = resolve;
  });
  const operationIds: string[] = [];
  await page.route('**/api/commands', async (route) => {
    const data = route.request().postDataJSON();
    if (data.command === 'task.create' && data.payload.title === title) {
      operationIds.push(data.operationId);
      if (operationIds.length === 1) {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        await route.abort('failed');
        committed();
        return;
      }
    }
    await route.continue();
  });
  await page
    .getByRole('button', { name: 'Добавить задачу', exact: true })
    .first()
    .click();
  await page
    .getByRole('textbox', { name: 'Что нужно сделать?', exact: true })
    .fill(title);
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await onCommit;
  // Reload before the first automatic retry. The operation remains in the durable outbox.
  const ids = await page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith('taskindex/ops/')),
  );
  expect(ids).toHaveLength(1);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: title, exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys(localStorage).filter((key) =>
            key.startsWith('taskindex/ops/'),
          ).length,
      ),
    )
    .toBe(0);
  const state = (await (
    await page.request.get('/api/snapshot')
  ).json()) as Snapshot;
  expect(state.tasks.filter((task) => task.title === title)).toHaveLength(1);
  expect(new Set(operationIds).size).toBe(1);
});

test('mouse and emulated touch drag both persist task moves', async ({
  page,
  browser,
}) => {
  await openWorkspace(page);
  const projectId = 'e2e-pointer';
  await command(page, 'project.create', {
    id: projectId,
    area: 'agency',
    name: 'Перетаскивание',
    color: '#3763df',
  });
  const mouse = (
    await command(page, 'task.create', {
      area: 'agency',
      projectId,
      title: 'Мышью',
    })
  ).results[0]!.record as Task;
  const touch = (
    await command(page, 'task.create', {
      area: 'agency',
      projectId,
      title: 'Касанием',
      priority: 'p3',
    })
  ).results[0]!.record as Task;
  await command(page, 'task.create', {
    area: 'agency',
    projectId,
    title: 'Целевая колонка',
    status: 'doing',
  });
  await page.goto(`/?area=agency&project=${projectId}&view=board`);
  const source = page.getByRole('button', {
    name: 'Открыть: Мышью',
    exact: true,
  });
  await expect(source).toBeVisible();
  const from = (await source.boundingBox())!;
  const target = (await page
    .getByRole('button', { name: 'Открыть: Целевая колонка', exact: true })
    .boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    from.x + from.width / 2 + 15,
    from.y + from.height / 2,
    { steps: 3 },
  );
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        (
          (await (
            await page.request.get(`/api/tasks/${mouse.id}`)
          ).json()) as Task
        ).status,
    )
    .toBe('doing');
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    storageState: test.info().project.use.storageState,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mobile = await context.newPage();
  await openWorkspace(mobile);
  await mobile.goto(`/?area=agency&project=${projectId}&view=board&done=1`);
  const start = mobile.getByRole('button', {
    name: 'Открыть: Касанием',
    exact: true,
  });
  await expect(start).toBeVisible();
  await start.scrollIntoViewIfNeeded();
  // Touch has no hover: completion remains discoverable beside the menu.
  await expect(
    mobile.getByRole('button', { name: 'Завершить: Касанием', exact: true }),
  ).toHaveCSS('opacity', '1');
  const rect = (await start.boundingBox())!;
  const session = await context.newCDPSession(mobile);
  const x = rect.x + rect.width / 2,
    y = rect.y + rect.height / 2;
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }],
  });
  // TouchSensor activates after its hold delay: wait for the drag itself, not a
  // timer. The budget comes from the sensor's own constraint (TOUCH_HOLD_MS).
  await expect(mobile.locator('article.dragging')).toHaveCount(1, {
    timeout: TOUCH_HOLD_MS * 20,
  });
  for (let step = 1; step <= 8; step++)
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + ((380 - x) * step) / 8, y }],
    });
  await expect
    .poll(
      async () =>
        (await mobile.locator('.drag-overlay .task-card').boundingBox())?.x ??
        0,
    )
    .toBeGreaterThan(x);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
  await expect
    .poll(
      async () =>
        (
          (await (
            await page.request.get(`/api/tasks/${touch.id}`)
          ).json()) as Task
        ).status,
    )
    // TI-092: the column to the right of P3 is «Готово».
    .toBe('done');
  await context.close();
});

test('activity identifies a rejected command and cannot undo it', async ({
  page,
}) => {
  await openWorkspace(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const snapshot = await snapshotOf(page);
  const response = await page.request.post('/api/commands', {
    headers: { Origin: new URL(page.url()).origin },
    data: {
      operationId: crypto.randomUUID(),
      generation: snapshot.generation,
      command: 'task.update',
      payload: {
        id: 'does-not-exist',
        baseRevision: 1,
        title: 'Отклонённое изменение',
      },
    },
  });
  expect(response.status()).toBe(404);
  const result = (await response.json()) as OperationError;
  await page.getByRole('button', { name: 'Активность', exact: true }).click();
  const row = page.locator('.operation-row').first();
  await expect(row).toHaveAttribute('data-outcome', 'rejected');
  await expect(
    row.getByText('Операция отклонена', { exact: true }),
  ).toBeVisible();
  await expect(row.getByText(result.message, { exact: true })).toBeVisible();
  await expect(
    row.getByRole('button', { name: 'Отменить', exact: true }),
  ).toBeDisabled();
  await row.locator('.operation-heading').getByRole('button').first().click();
  await expect(
    row.getByText('Загружаем изменения…', { exact: true }),
  ).toBeHidden();
  await expect(row.locator('[role="alert"]')).toHaveCount(0);
  await expect(row.getByText(result.message, { exact: true })).toBeVisible();
});

// TI-070: выход из пространства отзывает сессию, поэтому сцена работает не с
// общей сессией проекта `setup`, а со своей: иначе она гасила бы `storageState`
// для всех последующих тестов файла.
test.describe('своя сессия владельца', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('register passkey, sign out, and sign in with a virtual WebAuthn authenticator', async ({
    page,
  }, testInfo) => {
    await signIn(page, testInfo);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send(
      'WebAuthn.addVirtualAuthenticator',
      {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          automaticPresenceSimulation: true,
          isUserVerified: true,
        },
      },
    );
    await page.getByRole('button', { name: 'Дмитрий', exact: true }).click();
    await page
      .getByRole('menuitem', { name: 'Добавить passkey', exact: true })
      .click();
    await expect(
      page.getByText('Passkey добавлен', { exact: true }),
    ).toBeVisible();
    const credentials = await cdp.send('WebAuthn.getCredentials', {
      authenticatorId,
    });
    expect(credentials.credentials).toHaveLength(1);
    expect(credentials.credentials[0]!.rpId).toBe('localhost');
    await page.getByRole('button', { name: 'Дмитрий', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Выйти', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Войти в пространство', exact: true }),
    ).toBeVisible();
    expect((await page.request.get('/api/snapshot')).status()).toBe(401);
    await page
      .getByRole('button', { name: 'Войти с passkey', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Агентство', exact: true }),
    ).toBeVisible();
    expect((await page.request.get('/api/snapshot')).ok()).toBe(true);
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  });
});

// TI-025 фаза A: скин обязан выигрывать у утилит примитивов слоем каскада, а не
// !important. Скриншоты не покрывают диалоги, поэтому вычисленные значения
// проверяются напрямую. TI-070: эталон снимает проект `visual` на своей базе,
// поэтому место теста в файле роли не играет.
test('the skin layer outranks the primitive utilities without !important', async ({
  page,
}) => {
  const style = (selector: string, property: string) =>
    page.evaluate(
      ([sel, prop]) => {
        const node = document.querySelector(sel!);
        return node ? getComputedStyle(node).getPropertyValue(prop!) : null;
      },
      [selector, property] as const,
    );
  await openWorkspace(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  // The heading tabs keep the skin height, not the primitive's own.
  expect(await style('.view-tabs', 'height')).toBe('44px');
  // The quick-create dialog keeps its width against `sm:max-w-sm`.
  await page.keyboard.press('n');
  await expect(
    page.getByRole('dialog', { name: 'Новая задача', exact: true }),
  ).toBeVisible();
  expect(await style('.create-dialog', 'width')).toBe('480px');
  await page.keyboard.press('Escape');
  // The editor sheet keeps its width and its surface.
  const title = 'Э2Э: скин';
  await createTask(page, title);
  await page.getByRole('button', { name: `Открыть: ${title}` }).click();
  await expect(
    page.getByRole('textbox', { name: 'Название задачи', exact: true }),
  ).toBeVisible();
  expect(await style('.task-sheet', 'width')).toBe('520px');
  expect(await style('.task-title-row h3', 'padding-top')).toBe('0px');
});
