import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { command, signIn, snapshot } from './helpers';

async function drag(page: Page, title: string, column: string) {
  const source = page.getByRole('button', {
    name: `Открыть: ${title}`,
    exact: true,
  });
  await source.scrollIntoViewIfNeeded();
  const from = (await source.boundingBox())!;
  const target = page.locator(`.column-${column} .column-head`);
  await target.scrollIntoViewIfNeeded();
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + 18);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + 18);
  await expect(page.locator('article.dragging')).toHaveCount(1);
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 15,
  });
  await page.mouse.up();
}

test('TI-091 board groups queued tasks by priority without a waiting column', async ({
  page,
}, testInfo) => {
  await signIn(page, testInfo);
  const projectId = randomUUID();
  await command(page, 'project.create', {
    id: projectId,
    area: 'agency',
    name: `Колонки ${projectId.slice(0, 8)}`,
    color: '#397faf',
  });
  for (const priority of ['p1', 'p2', 'p3']) {
    await command(page, 'task.create', {
      id: randomUUID(),
      area: 'agency',
      projectId,
      title: `Задача ${priority.toUpperCase()}`,
      priority,
    });
  }
  await page.goto(`/?area=agency&project=${projectId}&view=board`);
  for (const priority of ['p1', 'p2', 'p3']) {
    const column = page.locator(`.column-${priority}`);
    await expect(column.locator('.column-head h2')).toContainText(
      priority.toUpperCase(),
    );
    await expect(column.locator('.task-title-row h3')).toHaveText([
      `Задача ${priority.toUpperCase()}`,
    ]);
  }
  await expect(page.locator('.column-waiting')).toHaveCount(0);
  await expect(page.locator('.column-head h2')).toHaveText([
    'P1',
    'P2',
    'P3',
    'В работе',
    'Готово',
  ]);
  await page.getByRole('tab', { name: 'Список', exact: true }).click();
  await expect(page.locator('.column-head h2')).toHaveText([
    'P1',
    'P2',
    'P3',
    'В работе',
    'Готово',
  ]);
});

test('TI-091 column creation, priority drag, undo and status moves persist', async ({
  page,
}, testInfo) => {
  await signIn(page, testInfo);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const projectId = randomUUID();
  await command(page, 'project.create', {
    id: projectId,
    area: 'agency',
    name: 'Проверка переноса',
    color: '#397faf',
  });
  await page.goto(`/?area=agency&project=${projectId}&view=board`);
  // A project needs an initial task before the board replaces its empty state.
  await command(page, 'task.create', {
    id: randomUUID(),
    projectId,
    area: 'agency',
    title: 'Обычная задача',
  });
  const p1 = page.locator('.column-p1');
  await p1
    .getByRole('button', { name: 'Добавить задачу', exact: true })
    .click();
  await p1
    .getByRole('textbox', { name: 'Название новой задачи', exact: true })
    .fill('Важная задача');
  await p1.getByRole('button', { name: 'Добавить', exact: true }).click();
  const saved = async () =>
    (await snapshot(page)).tasks.find(
      (task) => task.projectId === projectId && task.title === 'Важная задача',
    );
  await expect.poll(async () => (await saved())?.priority).toBe('p1');
  await drag(page, 'Важная задача', 'p2');
  await expect.poll(async () => (await saved())?.priority).toBe('p2');
  expect((await saved())?.status).toBe('todo');
  await page
    .locator('[data-slot="toast"]')
    .filter({ hasText: 'Задача → P2' })
    .getByRole('button', { name: 'Отменить', exact: true })
    .click();
  await expect.poll(async () => (await saved())?.priority).toBe('p1');
  await drag(page, 'Важная задача', 'doing');
  await expect.poll(async () => (await saved())?.status).toBe('doing');
  expect((await saved())?.priority).toBe('p1');
  await drag(page, 'Важная задача', 'done');
  await expect.poll(async () => (await saved())?.status).toBe('done');
  await drag(page, 'Важная задача', 'p3');
  await expect
    .poll(async () => {
      const task = await saved();
      return { status: task?.status, priority: task?.priority };
    })
    .toEqual({ status: 'todo', priority: 'p3' });
  await page.reload();
  await expect(page.locator('.column-p3 .task-title-row h3')).toHaveText([
    'Важная задача',
  ]);
});

test('TI-091 legacy waiting tasks stay visible and the five-column layout works on narrow screens', async ({
  page,
}, testInfo) => {
  await signIn(page, testInfo);
  const projectId = randomUUID(),
    id = randomUUID();
  await command(page, 'project.create', {
    id: projectId,
    area: 'agency',
    name: 'Задачи агентства',
    color: '#397faf',
  });
  await command(page, 'task.create', {
    id,
    projectId,
    area: 'agency',
    title: 'Проверить материалы',
    status: 'waiting',
    priority: 'p1',
    waitingFor: 'Исходные сведения',
    followUp: '2026-09-15',
  });
  for (const [title, priority, status] of [
    ['Дочистить доступы Алексея', 'p1', 'todo'],
    ['Оформить Гришу на утреннюю смену', 'p1', 'todo'],
    ['Выбрать кандидата на ночную смену', 'p2', 'todo'],
    ['Решить, кто готовит публикации', 'p2', 'todo'],
    ['Разобрать идеи для контента', 'p3', 'todo'],
    ['Обновить описание вакансии', 'p2', 'doing'],
    ['Проверить доступы команды', 'p1', 'done'],
  ])
    await command(page, 'task.create', {
      id: randomUUID(),
      projectId,
      area: 'agency',
      title,
      priority,
      status,
    });
  const url = `/?area=agency&project=${projectId}&view=board`;
  await page.goto(url);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('.column-p1 .task-title-row h3')).toContainText([
    'Проверить материалы',
  ]);
  await page
    .getByRole('button', { name: 'Действия: Проверить материалы', exact: true })
    .click();
  await expect(
    page.getByRole('menuitem', { name: 'Жду', exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: 'Открыть: Проверить материалы', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: 'Состояние задачи', exact: true })
    .click();
  await expect(
    page.getByRole('option', { name: 'Жду', exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('dialog', { name: 'Редактирование задачи' }),
  ).toBeHidden();
  const legacy = (await snapshot(page)).tasks.find((task) => task.id === id)!;
  expect(legacy).toMatchObject({
    status: 'waiting',
    priority: 'p1',
    waitingFor: 'Исходные сведения',
    followUp: '2026-09-15',
    revision: 1,
  });
  await page
    .getByRole('heading', { name: 'Задачи агентства', exact: true })
    .click();
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: testInfo.outputPath('priority-board-desktop.png'),
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.column-p1 h2')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('priority-board-mobile.png'),
    animations: 'disabled',
  });
  await page.getByRole('tab', { name: 'Список', exact: true }).click();
  await expect(page.locator('.column-p1 .task-title-row h3')).toContainText([
    'Проверить материалы',
  ]);
  await page.screenshot({
    path: testInfo.outputPath('priority-list-mobile.png'),
    animations: 'disabled',
  });
});
