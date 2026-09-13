import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { postCommand as command, signIn, snapshot } from './helpers';

// Regressions from the live workflow audit of 2026-09-08.
async function task(page: Page, title: string) {
  const id = randomUUID();
  expect(
    (await command(page, 'task.create', { id, area: 'agency', title })).ok(),
  ).toBe(true);
  await expect(
    page.getByRole('button', { name: `Открыть: ${title}`, exact: true }),
  ).toBeVisible();
  return id;
}
async function open(page: Page, title: string) {
  await page
    .getByRole('button', { name: `Открыть: ${title}`, exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Редактирование задачи', exact: true }),
  ).toBeVisible();
}
test.beforeEach(async ({ page }, testInfo) => {
  await signIn(page, testInfo);
});

test('B01 saving tab B must not delete the unsaved task draft in tab A', async ({
  page,
  context,
}) => {
  await task(page, 'B01 исходное название');
  await open(page, 'B01 исходное название');
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(
    other.getByRole('textbox', { name: 'Название задачи', exact: true }),
  ).toHaveValue('B01 исходное название');
  await page
    .getByRole('textbox', { name: 'Название задачи', exact: true })
    .fill('B01 важный несохранённый текст');
  // Ensure the effect has written the draft before B starts saving.
  await expect(page.getByText('Есть изменения', { exact: true })).toBeVisible();
  await other
    .getByRole('textbox', { name: 'Название задачи', exact: true })
    .fill('B01 сохранено в Б');
  await other.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(
    other.getByRole('dialog', { name: 'Редактирование задачи', exact: true }),
  ).toBeHidden();
  await page
    .getByRole('button', { name: 'Закрыть карточку', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Закрыть с черновиком', exact: true })
    .click();
  await open(page, 'B01 сохранено в Б');
  await expect(
    page.getByRole('textbox', { name: 'Название задачи', exact: true }),
  ).toHaveValue('B01 важный несохранённый текст');
});

test('B02 clearing a comment draft must stay cleared after reopening', async ({
  page,
}) => {
  await task(page, 'B02 комментарий');
  await open(page, 'B02 комментарий');
  await page
    .getByRole('button', { name: 'Комментарии 0', exact: true })
    .click();
  const field = page.getByRole('textbox', {
    name: 'Новый комментарий',
    exact: true,
  });
  await field.fill('B02 текст удалён пользователем');
  await field.fill('');
  await page
    .getByRole('button', { name: 'Закрыть карточку', exact: true })
    .click();
  await open(page, 'B02 комментарий');
  await page
    .getByRole('button', { name: 'Комментарии 0', exact: true })
    .click();
  await expect(field).toHaveValue('');
});

test('B03 quick-create must consume the inline draft after creating its task', async ({
  page,
}) => {
  await task(page, 'B03 доска не пуста');
  const add = page.getByRole('button', {
    name: 'Добавить задачу',
    exact: true,
  });
  await add.nth(1).click();
  const field = page.getByRole('textbox', {
    name: 'Название новой задачи',
    exact: true,
  });
  await field.fill('B03 создать ровно один раз');
  await field.press('Escape');
  await add.first().click();
  await expect(
    page.getByRole('textbox', { name: 'Что нужно сделать?', exact: true }),
  ).toHaveValue('B03 создать ровно один раз');
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Новая задача', exact: true }),
  ).toBeHidden();
  await add.nth(1).click();
  await expect(field).toHaveValue('');
});

test('B04 a project conflict supports explicit review after reopening', async ({
  page,
}, testInfo) => {
  const id = randomUUID();
  expect(
    (
      await command(page, 'project.create', {
        id,
        area: 'agency',
        name: 'B04 направление',
        color: '#3465df',
      })
    ).ok(),
  ).toBe(true);
  await page
    .getByRole('button', { name: 'B04 направление', exact: true })
    .click();
  async function editProject() {
    await page
      .getByRole('button', { name: 'Настройки доски', exact: true })
      .click();
    await page
      .getByRole('menuitem', { name: 'Переименовать проект', exact: true })
      .click();
  }
  await editProject();
  await page
    .getByRole('textbox', { name: 'Название направления', exact: true })
    .fill('B04 моё имя');
  expect(
    (
      await command(page, 'project.update', {
        id,
        baseRevision: 1,
        name: 'B04 другая сессия',
        description: 'Описание другой сессии',
      })
    ).ok(),
  ).toBe(true);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Запись изменилась. Ваш текст остался в форме.',
  );
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 568 });
  await editProject();
  await expect(
    page.getByRole('button', { name: 'Сохранить', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText('Описание другой сессии', { exact: true }),
  ).toBeVisible();
  const dialog = page.getByRole('dialog', {
    name: 'Переименовать направление',
    exact: true,
  });
  await expect
    .poll(async () => {
      const box = (await dialog.boundingBox())!;
      return (
        box.x >= 0 &&
        box.x + box.width <= 320 &&
        box.y >= 0 &&
        box.y + box.height <= 568
      );
    })
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('project-conflict.png'),
    animations: 'disabled',
  });
  await page
    .getByRole('button', { name: 'Совместить и проверить', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Название направления', exact: true }),
  ).toHaveValue('B04 моё имя');
  await expect(
    page.getByRole('textbox', { name: 'Описание направления', exact: true }),
  ).toHaveValue('Описание другой сессии');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(
    page.getByRole('dialog', {
      name: 'Переименовать направление',
      exact: true,
    }),
  ).toBeHidden();
  const saved = (await snapshot(page)).projects.find(
    (p: { id: string }) => p.id === id,
  );
  expect(saved).toMatchObject({
    name: 'B04 моё имя',
    description: 'Описание другой сессии',
    revision: 3,
  });
});

test('B05 current version control must remain on-screen at mobile width', async ({
  page,
}, testInfo) => {
  const id = await task(page, 'B05 мобильный конфликт');
  await page.setViewportSize({ width: 320, height: 568 });
  await open(page, 'B05 мобильный конфликт');
  await page
    .getByRole('textbox', { name: 'Название задачи', exact: true })
    .fill('B05 мои правки');
  expect(
    (
      await command(page, 'task.update', {
        id,
        baseRevision: 1,
        title: 'B05 другая сессия',
      })
    ).ok(),
  ).toBe(true);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  const summary = page.getByText('Актуальная версия', { exact: true });
  await expect(summary).toBeVisible();
  const box = (await summary.boundingBox())!;
  expect(
    box.x,
    'The current-version control must be reachable without leaving the viewport',
  ).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  await page.screenshot({
    path: testInfo.outputPath('mobile-conflict.png'),
    animations: 'disabled',
  });
  await summary.click();
  await expect(page.locator('.editor-conflict pre')).toContainText(
    'B05 другая сессия',
  );
  await page
    .getByRole('button', { name: 'Совместить и проверить', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Название задачи', exact: true }),
  ).toHaveValue('B05 мои правки');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Редактирование задачи', exact: true }),
  ).toBeHidden();
});

test('B06 open activity must receive a new rejected operation without a data mutation', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Активность', exact: true }).click();
  await expect(
    page.getByText('Загружаем активность…', { exact: true }),
  ).toBeHidden();
  const rejected = page.locator('.operation-row[data-outcome="rejected"]');
  const before = await rejected.count();
  expect(
    (
      await command(page, 'task.update', {
        id: randomUUID(),
        baseRevision: 1,
        title: 'B06 отказ',
      })
    ).status(),
  ).toBe(404);
  await expect(rejected).toHaveCount(before + 1);
});

test('B01 duplicated tabs and closed-tab recovery keep independent drafts', async ({
  page,
  context,
}) => {
  await task(page, 'B01 duplicate source');
  await open(page, 'B01 duplicate source');
  const field = page.getByRole('textbox', {
    name: 'Название задачи',
    exact: true,
  });
  await field.fill('B01 original unsaved text');
  await expect(page.getByText('Есть изменения', { exact: true })).toBeVisible();
  // A native opener clones sessionStorage, just like duplicating a tab.
  const popupPromise = page.waitForEvent('popup');
  await page.evaluate(() => {
    window.open(location.href);
  });
  const other = await popupPromise;
  await expect(
    other.getByRole('textbox', { name: 'Название задачи', exact: true }),
  ).toHaveValue('B01 original unsaved text');
  await other
    .getByRole('textbox', { name: 'Название задачи', exact: true })
    .fill('B01 saved in duplicated tab');
  await other.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(
    other.getByRole('dialog', { name: 'Редактирование задачи', exact: true }),
  ).toBeHidden();
  page.on('dialog', (dialog) => void dialog.accept());
  await page.reload();
  await expect(field).toHaveValue('B01 original unsaved text');
  const url = page.url();
  await page.close();
  const recovered = await context.newPage();
  await recovered.goto(url);
  await expect(
    recovered.getByRole('textbox', { name: 'Название задачи', exact: true }),
  ).toHaveValue('B01 original unsaved text');
});

test('B03 the still-open inline form also consumes the modal creation', async ({
  page,
}) => {
  await task(page, 'B03 simultaneous forms');
  await page
    .getByRole('button', { name: 'Добавить задачу', exact: true })
    .nth(1)
    .click();
  const inline = page.getByRole('textbox', {
    name: 'Название новой задачи',
    exact: true,
  });
  await inline.fill('B03 modal consumes open inline');
  await page
    .getByRole('button', { name: 'Добавить задачу', exact: true })
    .first()
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Что нужно сделать?', exact: true }),
  ).toHaveValue('B03 modal consumes open inline');
  await page
    .getByRole('dialog', { name: 'Новая задача', exact: true })
    .getByRole('button', { name: 'Добавить', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Новая задача', exact: true }),
  ).toBeHidden();
  await expect(inline).toHaveValue('');
  await expect(
    page.getByRole('button', {
      name: 'Открыть: B03 modal consumes open inline',
      exact: true,
    }),
  ).toHaveCount(1);
});

test('B06 live refresh retains loaded activity pages', async ({ page }) => {
  for (let i = 0; i < 55; i++)
    expect(
      (
        await command(page, 'task.update', {
          id: randomUUID(),
          baseRevision: 1,
          title: `B06 page ${i}`,
        })
      ).status(),
    ).toBe(404);
  await page.getByRole('button', { name: 'Активность', exact: true }).click();
  await expect(page.locator('.operation-row')).toHaveCount(50);
  await page.getByRole('button', { name: 'Показать ещё', exact: true }).click();
  await expect
    .poll(() => page.locator('.operation-row').count())
    .toBeGreaterThan(50);
  const before = await page.locator('.operation-row').count();
  const response = await command(page, 'task.update', {
    id: randomUUID(),
    baseRevision: 1,
    title: 'B06 new after pagination',
  });
  expect(response.status()).toBe(404);
  const latest = (await response.json()) as { operationId: string };
  // Refresh preserves the opened page depth. With more than 100 operations
  // from other specs, the two loaded pages stay at 100 rather than grow to 101.
  const openedDepth = Math.ceil(before / 50) * 50;
  await expect(page.locator('.operation-row')).toHaveCount(
    Math.min(before + 1, openedDepth),
  );
  const detail = page.waitForResponse(
    (reply) =>
      new URL(reply.url()).pathname === `/api/operations/${latest.operationId}`,
  );
  await page
    .locator('.operation-row')
    .first()
    .getByRole('button', { name: /Операция отклонена/ })
    .click();
  expect((await detail).ok()).toBe(true);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('B01 restores drafts written before tab isolation was introduced', async ({
  page,
}) => {
  const id = await task(page, 'B01 legacy source');
  const state = await snapshot(page);
  await page.addInitScript(
    ({ id, generation }) => {
      if (localStorage.getItem('audit-legacy-seeded')) return;
      localStorage.setItem('audit-legacy-seeded', 'true');
      sessionStorage.removeItem('taskindex/draft-tab');
      localStorage.setItem(
        `taskindex/draft/${id}`,
        JSON.stringify({
          formatVersion: 1,
          generation,
          baseRevision: 1,
          fields: { task: { title: 'B01 preserved legacy text' }, step: '' },
        }),
      );
    },
    { id, generation: state.generation },
  );
  await page.reload();
  await open(page, 'B01 legacy source');
  await expect(
    page.getByRole('textbox', { name: 'Название задачи', exact: true }),
  ).toHaveValue('B01 preserved legacy text');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Редактирование задачи', exact: true }),
  ).toBeHidden();
  const saved = (await snapshot(page)).tasks.find(
    (task: { id: string }) => task.id === id,
  );
  expect(saved).toMatchObject({
    title: 'B01 preserved legacy text',
    revision: 2,
  });
});
