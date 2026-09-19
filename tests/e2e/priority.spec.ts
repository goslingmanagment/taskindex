import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { SEEDED_LABELS as LABELS } from '../../src/shared/labels';
import { byOrder } from '../../src/shared/queries';
import { command, signIn, snapshot } from './helpers';

// Each scenario gets a direction of its own; other functional specs may use
// any area. The server preference is reset explicitly because it is global.
async function resetFilter(page: Page) {
  const appearance = (await snapshot(page)).appearance;
  if (appearance.hideP3)
    await command(page, 'appearance.update', {
      baseRevision: appearance.revision,
      hideP3: false,
    });
}
async function direction(page: Page) {
  const id = randomUUID();
  await command(page, 'project.create', {
    id,
    area: 'agency',
    name: `Приоритеты ${id.slice(0, 8)}`,
    color: '#397faf',
  });
  return id;
}
async function addTask(page: Page, projectId: string, fields: object = {}) {
  const id = randomUUID(),
    title = `Задача ${id.slice(0, 8)}`;
  await command(page, 'task.create', {
    id,
    area: 'agency',
    projectId,
    title,
    ...fields,
  });
  return { id, title };
}
const boardUrl = (project: string, view = 'board') =>
  `/?area=agency&project=${project}&view=${view}`;
const taskCard = (page: Page, title: string) =>
  page.locator('article.task-card', { hasText: title });
const hideP3Toggle = (page: Page) =>
  page.getByRole('checkbox', { name: 'Без P3', exact: true });
const todayToggle = (page: Page) =>
  page.getByRole('checkbox', { name: 'На сегодня', exact: true });

test.beforeEach(async ({ page }, testInfo) => {
  await signIn(page, testInfo, '/?area=agency&project=all&view=board');
  await resetFilter(page);
});
test.afterEach(async ({ page }) => {
  await resetFilter(page);
});

test('TI-086 badges, editor fields, menu and the server preference survive reloads', async ({
  page,
}) => {
  const project = await direction(page);
  const urgent = await addTask(page, project, {
    priority: 'p1',
    labels: ['dengi', 'lora'],
    closes: 'lora-km-of-vacancy',
  });
  const someday = await addTask(page, project, { priority: 'p3' });
  const active = await addTask(page, project, {
    priority: 'p1',
    status: 'doing',
  });
  await page.goto(boardUrl(project));
  const card = taskCard(page, urgent.title);
  await expect(card.locator('.label-chip')).toHaveText(['деньги', 'Lora']);
  // The column already says P1 and P3: the chip marks only a task that left
  // its column. The problem slug lives in the editor, not on the card.
  await expect(card.locator('.priority-mark')).toHaveCount(0);
  await expect(card.locator('.closes-chip')).toHaveCount(0);
  await expect(card).not.toContainText('lora-km-of-vacancy');
  await expect(taskCard(page, someday.title)).toBeVisible();
  await expect(
    taskCard(page, someday.title).locator('.priority-mark'),
  ).toHaveCount(0);
  await expect(
    taskCard(page, active.title).getByLabel('Приоритет P1'),
  ).toHaveText('P1');

  await page
    .getByRole('button', { name: `Открыть: ${urgent.title}`, exact: true })
    .click();
  const save = page.getByRole('button', { name: 'Сохранить', exact: true });
  // The label picker is a menu behind the «Метка» chip; it stays open while
  // labels are toggled and keeps each label's description.
  const labelMenu = page.getByRole('button', { name: 'Метка', exact: true });
  await labelMenu.click();
  for (const label of LABELS) {
    const checkbox = page.getByRole('menuitemcheckbox', {
      name: `Метка: ${label.name}`,
      exact: true,
    });
    await expect(checkbox).toHaveAccessibleName(`Метка: ${label.name}`);
    await expect(checkbox).toHaveAccessibleDescription(label.description);
  }
  // Server canonicalization means toggling a label back restores a clean form,
  // including tasks originally sent with labels in another order by an agent.
  const lora = page.getByRole('menuitemcheckbox', {
    name: 'Метка: Lora',
    exact: true,
  });
  await lora.click();
  await page.keyboard.press('Escape');
  await expect(save).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Снять метку Lora', exact: true }),
  ).toHaveCount(0);
  await labelMenu.click();
  await lora.click();
  await page.keyboard.press('Escape');
  await expect(save).toBeDisabled();
  const priority = page.getByRole('button', { name: /^Приоритет задачи/ });
  await expect(priority).toContainText('P1');
  await priority.click();
  await page.getByRole('menuitemradio', { name: /^P2/ }).click();
  await labelMenu.click();
  await page
    .getByRole('menuitemcheckbox', { name: 'Метка: деньги', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await page
    .getByRole('textbox', { name: 'Слаг проблемы', exact: true })
    .fill('traffic-materials');
  await save.click();
  await expect(
    page.getByRole('dialog', { name: 'Редактирование задачи', exact: true }),
  ).toBeHidden();
  await expect(card.locator('.priority-mark')).toHaveCount(0);
  await expect(card.locator('.label-chip')).toHaveText(['Lora']);
  await expect
    .poll(async () => {
      const saved = (await snapshot(page)).tasks.find(
        (task) => task.id === urgent.id,
      );
      return (
        saved && {
          priority: saved.priority,
          labels: saved.labels,
          closes: saved.closes,
        }
      );
    })
    .toEqual({
      priority: 'p2',
      labels: ['lora'],
      closes: 'traffic-materials',
    });

  await hideP3Toggle(page).click();
  await expect(taskCard(page, someday.title)).toBeHidden();
  await expect(page.locator('.filter-note[data-hidden-p3]')).toHaveAttribute(
    'data-hidden-p3',
    '1',
  );
  await expect
    .poll(async () => (await snapshot(page)).appearance.hideP3)
    .toBe(true);
  await page.reload();
  await expect(hideP3Toggle(page)).toBeChecked();
  await expect(taskCard(page, someday.title)).toBeHidden();
  const other = await page.context().newPage();
  await other.goto(boardUrl(project, 'list'));
  await expect(hideP3Toggle(other)).toBeChecked();
  await expect(taskCard(other, someday.title)).toBeHidden();
  await other.close();

  await hideP3Toggle(page).click();
  await expect(taskCard(page, someday.title)).toBeVisible();
  await page
    .getByRole('button', { name: `Действия: ${someday.title}`, exact: true })
    .click();
  await page.getByRole('menuitemradio', { name: /P1/ }).click();
  // The move shows as the column change; inside P1 the card needs no chip.
  await expect(
    page.locator('.column-p1 article.task-card', { hasText: someday.title }),
  ).toBeVisible();
  await expect(
    taskCard(page, someday.title).locator('.priority-mark'),
  ).toHaveCount(0);
});

test('TI-086 a direction containing only P3 explains the empty board and shows hidden tasks', async ({
  page,
}) => {
  const project = await direction(page);
  const task = await addTask(page, project, { priority: 'p3' });
  await page.goto(boardUrl(project));
  await hideP3Toggle(page).click();
  await expect(
    page.locator('.main-empty [data-slot="empty-title"]'),
  ).toHaveText('Задачи скрыты фильтром');
  await expect(
    page.locator('.main-empty [data-slot="empty-description"]'),
  ).toContainText('1 задача');
  await expect(
    page.getByText('Здесь пока нет задач', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Показать P3', exact: true }).click();
  await expect(taskCard(page, task.title)).toBeVisible();
  await expect(hideP3Toggle(page)).not.toBeChecked();
});

for (const hasDueTask of [true, false]) {
  test(`TI-086 show all clears both filters with ${hasDueTask ? 'one' : 'zero'} counted hidden P3`, async ({
    page,
  }) => {
    const project = await direction(page);
    const today = (await snapshot(page)).today;
    const later = await addTask(page, project, { priority: 'p3' });
    const due = hasDueTask
      ? await addTask(page, project, { priority: 'p3', due: today })
      : null;
    await page.goto(`${boardUrl(project)}&today=1`);
    await hideP3Toggle(page).click();
    await expect(page.locator('.filter-note[data-hidden-p3]')).toHaveAttribute(
      'data-hidden-p3',
      hasDueTask ? '1' : '0',
    );
    await expect(
      page.locator('.main-empty [data-slot="empty-title"]'),
    ).toHaveText(
      hasDueTask ? 'Задачи скрыты фильтром' : 'На сегодня всё спокойно',
    );
    await page
      .getByRole('button', { name: 'Показать все задачи', exact: true })
      .click();
    await expect(todayToggle(page)).not.toBeChecked();
    await expect(hideP3Toggle(page)).not.toBeChecked();
    await expect(taskCard(page, later.title)).toBeVisible();
    if (due) await expect(taskCard(page, due.title)).toBeVisible();
    await expect
      .poll(async () => (await snapshot(page)).appearance.hideP3)
      .toBe(false);
  });
}

test('TI-086 manual dragging preserves priority and order when P3 is hidden and shown', async ({
  page,
}) => {
  const project = await direction(page);
  const urgent = await addTask(page, project, { priority: 'p2' });
  const normal = await addTask(page, project, { priority: 'p2' });
  const someday = await addTask(page, project, { priority: 'p3' });
  await page.goto(boardUrl(project));
  await expect(page.locator('.column-p2 .task-title-row h3')).toHaveText([
    urgent.title,
    normal.title,
  ]);
  await page
    .getByRole('button', { name: `Перетащить: ${normal.title}`, exact: true })
    .focus();
  await page.keyboard.press('Space');
  await expect(page.locator('article.dragging')).toHaveCount(1);
  // KeyboardSensor starts listening on the next task; wait for its measurements.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.keyboard.press('ArrowUp');
  await expect(
    page.getByRole('status').filter({
      hasText: `${normal.id} was moved over droppable area ${urgent.id}`,
    }),
  ).toHaveCount(1);
  await page.keyboard.press('Space');
  const savedOrder = async () =>
    (await snapshot(page)).tasks
      .filter((task) => task.projectId === project)
      .toSorted(byOrder)
      .map((task) => ({ id: task.id, priority: task.priority }));
  const expected = [
    { id: normal.id, priority: 'p2' },
    { id: urgent.id, priority: 'p2' },
    { id: someday.id, priority: 'p3' },
  ];
  await expect.poll(savedOrder).toEqual(expected);
  await hideP3Toggle(page).click();
  await expect(page.locator('.column-p2 .task-title-row h3')).toHaveText([
    normal.title,
    urgent.title,
  ]);
  await hideP3Toggle(page).click();
  await expect
    .poll(async () => (await snapshot(page)).appearance.hideP3)
    .toBe(false);
  await page.reload();
  await expect(page.locator('.column-p2 .task-title-row h3')).toHaveText([
    normal.title,
    urgent.title,
  ]);
  await expect.poll(savedOrder).toEqual(expected);
});

test('TI-086 all labels and an 80-character closes slug fit a narrow board and the list', async ({
  page,
}, testInfo) => {
  const project = await direction(page),
    closes = 'a'.repeat(80);
  const task = await addTask(page, project, {
    priority: 'p1',
    labels: LABELS.map((label) => label.id),
    closes,
    due: (await snapshot(page)).today,
    note: 'Контекст задачи',
  });
  for (const [width, view] of [
    [390, 'board'],
    [1440, 'list'],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(boardUrl(project, view));
    const card = taskCard(page, task.title);
    await expect(card).toBeVisible();
    await expect(card.locator('.label-chip')).toHaveCount(LABELS.length);
    await expect(card.locator('.closes-chip')).toHaveCount(0);
    // Board chips are larger; list chips keep their compact size. Only the
    // direction chip carries a colour and a dot.
    expect(
      await card.locator('.label-chip').evaluateAll((chips) =>
        chips.map((chip) => {
          const style = getComputedStyle(chip);
          return {
            fontSize: style.fontSize,
            dots: chip.querySelectorAll('.tag-dot').length,
            tinted: style.backgroundColor !== 'rgba(0, 0, 0, 0)',
            oneLine: chip.getBoundingClientRect().height < 28,
          };
        }),
      ),
    ).toEqual(
      LABELS.map(() => ({
        fontSize: view === 'board' ? '13px' : '12px',
        dots: 0,
        tinted: true,
        oneLine: true,
      })),
    );
    await expect
      .poll(() =>
        card.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const chips = [...element.querySelectorAll('.label-chip')];
          // The date shares the footer row with the chips: they wrap around
          // it instead of overlapping it.
          const meta = element
            .querySelector('.due-label')!
            .getBoundingClientRect();
          const rectangles = chips.map((chip) => chip.getBoundingClientRect());
          return {
            outside: rectangles.filter(
              (chip) =>
                chip.left < bounds.left - 1 ||
                chip.right > bounds.right + 1 ||
                chip.top < bounds.top - 1 ||
                chip.bottom > bounds.bottom + 1,
            ).length,
            overlapsMeta: rectangles.filter(
              (chip) =>
                chip.left < meta.right &&
                chip.right > meta.left &&
                chip.top < meta.bottom &&
                chip.bottom > meta.top,
            ).length,
          };
        }),
      )
      .toEqual({ outside: 0, overlapsMeta: 0 });
    if (width === 390)
      expect(
        await card
          .locator('.label-chip')
          .evaluateAll(
            (chips) =>
              new Set(
                chips.map((chip) =>
                  Math.round(chip.getBoundingClientRect().top),
                ),
              ).size,
          ),
      ).toBeGreaterThan(1);
    await page.screenshot({
      path: testInfo.outputPath(`priority-${width}-${view}.png`),
    });
  }
  await page
    .getByRole('button', { name: `Открыть: ${task.title}`, exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Слаг проблемы', exact: true }),
  ).toHaveValue(closes);
});

test('card menu is a hover and keyboard affordance, hidden at rest', async ({
  page,
}) => {
  const project = await direction(page);
  const task = await addTask(page, project);
  await page.goto(boardUrl(project));
  const card = taskCard(page, task.title);
  await expect(card).toBeVisible();
  const menu = card.getByRole('button', {
    name: `Действия: ${task.title}`,
    exact: true,
  });
  const opacity = () =>
    menu.evaluate((element) => getComputedStyle(element).opacity);
  await page.mouse.move(0, 0);
  await expect.poll(opacity).toBe('0');
  await card.hover();
  await expect.poll(opacity).toBe('1');
  await page.mouse.move(0, 0);
  await expect.poll(opacity).toBe('0');
  await page
    .getByRole('button', { name: `Открыть: ${task.title}`, exact: true })
    .focus();
  await expect.poll(opacity).toBe('1');
});
