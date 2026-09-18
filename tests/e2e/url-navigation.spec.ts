import { test, expect } from '@playwright/test';
import { command, signIn } from './helpers';

test('legacy task links canonicalize in place and keep the project, view and filters', async ({
  page,
}, info) => {
  await signIn(page, info);
  const projectId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const name = `Направление URL ${projectId.slice(0, 8)}`;
  const title = `Задача URL ${taskId.slice(0, 8)}`;
  await command(page, 'project.create', {
    id: projectId,
    area: 'agency',
    name,
    color: '#3763df',
  });
  await command(page, 'task.create', {
    id: taskId,
    area: 'agency',
    projectId,
    title,
  });
  const path = `/agency/projects/${projectId}?view=list`;
  const address = `${path}&task=${taskId}&done=1`;
  const origin = new URL(page.url()).origin;
  await page.goto(
    `/?area=agency&project=${projectId}&view=list&task=${taskId}&done=1`,
  );
  await expect(page).toHaveURL(origin + address);
  const editor = page.getByRole('dialog', {
    name: 'Редактирование задачи',
    exact: true,
  });
  await expect(editor).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Название задачи', exact: true }),
  ).toHaveValue(title);
  await page.reload();
  await expect(editor).toBeVisible();
  await expect(page).toHaveURL(origin + address);
  await page
    .getByRole('button', { name: 'Закрыть карточку', exact: true })
    .click();
  await expect(editor).toBeHidden();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(
    page.getByRole('tab', { name: 'Список', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(origin + path + '&done=1');
  expect(
    await page.evaluate(() => localStorage.getItem('taskindex/location')),
  ).toBe(path + '&done=1');
  await page.goBack();
  await expect(editor).toBeVisible();
  await expect(page).toHaveURL(origin + address);
  // Canonicalization replaced the legacy entry; it did not add another step.
  await page.goBack();
  await expect(page).toHaveURL(origin + '/agency');
  await expect(
    page.getByRole('heading', { name: 'Агентство', exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(editor).toBeVisible();
  await expect(page).toHaveURL(origin + address);
});

test('only a bare root restores the remembered location, including old preferences', async ({
  page,
}, info) => {
  await signIn(page, info);
  await page.evaluate(() =>
    localStorage.setItem(
      'taskindex/location',
      'area=development&project=all&view=list',
    ),
  );
  await page.goto('/agency');
  await expect(
    page.getByRole('heading', { name: 'Агентство', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/agency$/);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Разработка', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/development\?view=list$/);
  await page.getByRole('button', { name: 'Личное', exact: true }).click();
  await expect(page).toHaveURL(/\/personal\?view=list$/);
  expect(
    await page.evaluate(() => localStorage.getItem('taskindex/location')),
  ).toBe('/personal?view=list');
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Личное', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/personal\?view=list$/);
});

test('global screens, archive and replace-only filters survive history navigation', async ({
  page,
}, info) => {
  await signIn(page, info);
  await page.getByRole('button', { name: 'Разработка', exact: true }).click();
  await page.getByRole('tab', { name: 'Список', exact: true }).click();
  await page.getByRole('button', { name: /^Фокус/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Фокус', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/focus\?area=development&view=list$/);
  await page.getByRole('button', { name: 'Активность', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Активность', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/activity\?area=development&view=list$/);
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Фокус', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/focus\?area=development&view=list$/);
  await page.getByRole('button', { name: 'Агентство', exact: true }).click();
  await page.getByRole('button', { name: /^Архив/ }).click();
  await expect(page).toHaveURL(/\/agency\/archive\?view=list$/);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Архив', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Архив/ }).click();
  await page.getByRole('checkbox', { name: 'На сегодня', exact: true }).check();
  await expect(page).toHaveURL(/\/agency\?view=list&today=1$/);
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Архив', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/agency\/archive\?view=list$/);
  await page.goForward();
  await expect(
    page.getByRole('checkbox', { name: 'На сегодня', exact: true }),
  ).toBeChecked();
  await expect(page).toHaveURL(/\/agency\?view=list&today=1$/);
});
