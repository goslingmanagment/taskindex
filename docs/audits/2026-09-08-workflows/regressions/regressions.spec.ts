import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// These assert the desired behavior. The audited implementation fails them.
const origin = 'http://localhost:4198';
async function snapshot(page: Page) {
  return (await page.request.get('/api/snapshot')).json();
}
async function command(page: Page, name: string, payload: object) {
  const state = await snapshot(page);
  return page.request.post('/api/commands', {
    headers: { Origin: origin },
    data: {
      generation: state.generation,
      operationId: randomUUID(),
      command: name,
      payload,
    },
  });
}
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
  // The local fixture has no Nginx. Give each independent test client an IP
  // rather than spending the shared login-rate-limit bucket across tests.
  const caseNumber = Number(testInfo.title.match(/B(\d+)/)?.[1] ?? 1);
  await page
    .context()
    .setExtraHTTPHeaders({ 'x-real-ip': `192.0.2.${caseNumber}` });
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

test('B04 a project conflict must recover after reopening on the current revision', async ({
  page,
}) => {
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
      })
    ).ok(),
  ).toBe(true);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Запись изменилась. Ваш текст остался в форме.',
  );
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await editProject();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(
    page.getByRole('dialog', {
      name: 'Переименовать направление',
      exact: true,
    }),
  ).toBeHidden();
});

test('B05 current version control must remain on-screen at mobile width', async ({
  page,
}) => {
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
