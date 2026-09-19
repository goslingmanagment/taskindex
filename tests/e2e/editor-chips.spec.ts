import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { command, signIn } from './helpers';

// The «Чипы и текст» layout (owner's pick, 2026-09-19): the task's meta is one
// row of chips, the location lives in the header, and the queue/archive actions
// sit behind «···» there.
test('editor chips: due date, problem slug, move and header actions', async ({
  page,
}, info) => {
  await signIn(page, info);
  const from = randomUUID();
  const to = randomUUID();
  const taskId = randomUUID();
  // Digits only: the localization spec reads every accessible name on the
  // shared base and flags Latin letters.
  const suffix = String(Number.parseInt(taskId.slice(0, 8), 16));
  await command(page, 'project.create', {
    id: from,
    area: 'agency',
    name: `Откуда ${suffix}`,
    color: '#3763df',
  });
  await command(page, 'project.create', {
    id: to,
    area: 'development',
    name: `Куда ${suffix}`,
    color: '#3763df',
  });
  await command(page, 'task.create', {
    id: taskId,
    area: 'agency',
    projectId: from,
    title: `Чипы редактора ${suffix}`,
  });
  const stored = async () =>
    (await page.request.get(`/api/tasks/${taskId}`)).json();
  const sheet = page.getByRole('dialog', {
    name: 'Редактирование задачи',
    exact: true,
  });
  const save = sheet.getByRole('button', { name: 'Сохранить', exact: true });
  const actions = sheet.getByRole('button', {
    name: 'Действия с задачей',
    exact: true,
  });

  await page.goto(`/?area=agency&project=${from}&view=list`);
  await page.locator(`[data-task-open="${taskId}"]`).click();
  // The note and the new-step row need no «add section» button.
  await expect(
    sheet.getByRole('textbox', { name: 'Заметка к задаче', exact: true }),
  ).toBeVisible();
  await expect(
    sheet.getByRole('textbox', { name: 'Новый шаг', exact: true }),
  ).toBeVisible();

  await sheet.getByRole('button', { name: 'Проблема', exact: true }).click();
  const slug = sheet.getByRole('textbox', {
    name: 'Слаг проблемы',
    exact: true,
  });
  await expect(slug).toBeFocused();
  await slug.fill('editor-chips');

  await sheet.getByRole('button', { name: 'Срок', exact: true }).click();
  await sheet.getByLabel('Срок задачи', { exact: true }).fill('2031-03-04');
  await expect(sheet.locator('.due-chip')).toContainText('мар');
  // The native calendar opened by the chip closes on the next click.
  await sheet.getByRole('textbox', { name: 'Название задачи' }).click();

  await sheet
    .getByRole('button', { name: `Агентство / Откуда ${suffix}`, exact: true })
    .click();
  await page
    .getByRole('menuitemradio', { name: `Куда ${suffix}`, exact: true })
    .click();
  await expect(
    sheet.getByRole('button', {
      name: `Разработка / Куда ${suffix}`,
      exact: true,
    }),
  ).toBeVisible();

  // Queue and archive act on the saved card, so they wait for the save.
  await actions.click();
  await expect(
    page.getByRole('menuitem', { name: 'В архив', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText('Сначала сохраните изменения', { exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await save.click();
  await expect(sheet).toBeHidden();
  expect(await stored()).toMatchObject({
    due: '2031-03-04',
    closes: 'editor-chips',
    area: 'development',
    projectId: to,
  });

  await page.goto(`/?area=development&project=${to}&view=list`);
  await page.locator(`[data-task-open="${taskId}"]`).click();
  await sheet.getByRole('button', { name: 'Убрать срок', exact: true }).click();
  await expect(
    sheet.getByRole('button', { name: 'Срок', exact: true }),
  ).toBeVisible();
  await save.click();
  await expect(sheet).toBeHidden();
  await page.locator(`[data-task-open="${taskId}"]`).click();
  await actions.click();
  await page.getByRole('menuitem', { name: 'В архив', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect
    .poll(stored)
    .toMatchObject({ due: null, closes: 'editor-chips', archived: true });
});
