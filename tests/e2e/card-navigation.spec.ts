import { test, expect } from '@playwright/test';
import { agentCommand, command, signIn } from './helpers';

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
    // The direction chip is tinted with the direction colour and keeps its dot.
    await expect(card.locator('.project-tag .tag-dot')).toHaveCount(1);
    await expect(card.locator('.project-tag')).not.toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)',
    );
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

test('hover keeps the title in place; the agent byline sits at the right edge', async ({
  page,
}, info) => {
  await signIn(page, info);
  const taskId = crypto.randomUUID();
  const title = `Наведение ${Number.parseInt(taskId.slice(0, 8), 16)}: длинное название, которое переносится на вторую строку`;
  expect(
    (
      await agentCommand(page, 'task.create', {
        id: taskId,
        area: 'agency',
        title,
        labels: ['dengi'],
      })
    ).ok(),
  ).toBe(true);
  const card = page
    .locator('article.task-card')
    .filter({ has: page.locator(`[data-task-open="${taskId}"]`) });
  const heading = card.locator('h3');
  await expect(heading).toHaveText(title);
  try {
    // The byline of an agent-created task is pushed to the right edge of the
    // footer row, so labels and the author never read as one grey sentence.
    const edges = await card.locator('.card-footer').evaluate((row) => {
      const box = row.getBoundingClientRect();
      const byline = row.querySelector('.agent-mark')!.getBoundingClientRect();
      return {
        row: box.right - parseFloat(getComputedStyle(row).paddingRight),
        byline: byline.right,
      };
    });
    expect(Math.abs(edges.row - edges.byline)).toBeLessThanOrEqual(1);
    // Hover reveals the menu and the drag handle without moving the text:
    // a leftover `padding-left` on hover once pushed the title 22px right and
    // rewrapped it, so the card jumped under the pointer.
    const textBox = () =>
      heading.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const box = range.getBoundingClientRect();
        return { left: box.left, top: box.top, height: box.height };
      });
    await page.mouse.move(0, 0);
    const before = { text: await textBox(), card: await card.boundingBox() };
    await card.hover();
    await expect(card.locator('.card-menu')).toHaveCSS('opacity', '1');
    await expect(card.locator('.drag-handle')).toHaveCSS('opacity', '1');
    expect(await textBox()).toEqual(before.text);
    expect(await card.boundingBox()).toEqual(before.card);
  } finally {
    const latest = await (
      await page.request.get(`/api/tasks/${taskId}`)
    ).json();
    await command(page, 'task.archive', {
      id: taskId,
      baseRevision: latest.revision,
    });
  }
});
