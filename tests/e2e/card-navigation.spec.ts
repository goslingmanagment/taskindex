import { test, expect } from '@playwright/test';
import { command, signIn } from './helpers';

test('TI-085 card labels, menu actions and history stay current across navigation', async ({
  page,
}, info) => {
  await signIn(page, info);
  const projectId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const projectName = `Проверка направления ${Number.parseInt(projectId.slice(0, 8), 16)}`;
  const title = `Проверка карточки ${Number.parseInt(taskId.slice(0, 8), 16)}`;
  await command(page, 'project.create', {
    id: projectId,
    area: 'agency',
    name: projectName,
    color: '#3763df',
  });
  await command(page, 'task.create', {
    id: taskId,
    area: 'agency',
    projectId,
    title,
  });
  try {
    const card = page
      .locator('article.task-card')
      .filter({ has: page.locator(`[data-task-open="${taskId}"]`) });
    await expect(card.locator('.project-tag')).toHaveText(projectName);
    await page.getByRole('button', { name: projectName, exact: true }).click();
    await expect(card.locator('.project-tag')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Список', exact: true }).click();
    await card.locator('.card-open').click();
    await expect(
      page.getByRole('textbox', { name: 'Название задачи', exact: true }),
    ).toHaveValue(title);
    await page.goBack();
    await expect(page.locator('.task-sheet')).toHaveCount(0);
    await expect(
      page.getByRole('tab', { name: 'Список', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await page.locator('.search-field').fill(title);
    await expect(card.locator('.project-tag')).toHaveText(projectName);
    await expect(card.locator('.drag-handle')).toHaveCount(0);
    const menu = card.getByRole('button', {
      name: `Действия: ${title}`,
      exact: true,
    });
    await menu.focus();
    await menu.press('Enter');
    await page.getByRole('menuitem', { name: 'В фокус', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/tasks/${taskId}`)).json()).focus,
      )
      .toBe(true);
    await menu.click();
    await expect(
      page.getByRole('menuitem', { name: 'Убрать из фокуса', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('menu')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeFocused();
    await expect(
      page.locator('[data-slot="dropdown-menu-content"]:visible'),
    ).toHaveCount(0);
    await page.locator('[aria-label="Очистить поиск"]').click();
    await expect(card.locator('.project-tag')).toHaveCount(0);
    await expect(card.locator('.drag-handle')).toHaveCount(1);
  } finally {
    // Other functional specs inspect the same fixture's Focus and Russian
    // accessible names. Leave no focused task from this navigation exercise.
    const latest = await (
      await page.request.get(`/api/tasks/${taskId}`)
    ).json();
    await command(page, 'task.archive', {
      id: taskId,
      baseRevision: latest.revision,
    });
  }
});
