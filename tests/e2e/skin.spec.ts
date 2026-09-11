import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import type { Snapshot } from '../../src/shared/model';
import { command, openWorkspace } from './helpers';
// TI-026 (план 08, доп. шаг 15; план 13, шаг 11): скин «Фокус». Выбор хранится
// в пространстве (`appearance.update`), корень получает `data-skin`, палитра
// берётся из блоков `:root[data-skin='focus']` в tokens.css. Снимки доски и
// стола в двух скинах складываются в `test-results/e2e-skin` для просмотра
// глазами; эталон `docs/reference/v2-validation` не трогается.
const ARTIFACTS = 'test-results/e2e-skin';
const CLASSIC_BACKGROUND = 'rgb(247, 248, 250)';
const FOCUS_BACKGROUND = 'rgb(244, 243, 237)';
const FOCUS_DARK_BACKGROUND = 'rgb(27, 35, 33)';
test.beforeAll(() => mkdirSync(ARTIFACTS, { recursive: true }));
const shoot = (page: Page, name: string) =>
  page.screenshot({ path: `${ARTIFACTS}/${name}.png`, animations: 'disabled' });
const background = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const headingFont = (page: Page) =>
  page
    .locator('.desk-title')
    .evaluate((element) => getComputedStyle(element).fontFamily);
async function appearanceRevision(page: Page) {
  const snapshot = (await (
    await page.request.get('/api/snapshot')
  ).json()) as Snapshot;
  return snapshot.appearance?.revision ?? 1;
}

test('the Focus skin is chosen in the account menu, survives a reload and paints board and desk', async ({
  page,
}) => {
  await openWorkspace(page);
  await command(page, 'task.create', {
    id: 'e2e-skin-current',
    area: 'agency',
    title: 'Скин: текущая задача',
    focus: true,
    checklist: [
      { id: 'e2e-skin-step-1', text: 'Первый шаг', done: true },
      { id: 'e2e-skin-step-2', text: 'Второй шаг', done: false },
    ],
  });
  await command(page, 'task.create', {
    id: 'e2e-skin-next',
    area: 'agency',
    title: 'Скин: следующая',
    status: 'doing',
    focus: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator('html')).not.toHaveAttribute('data-skin', /.*/);
  expect(await background(page)).toBe(CLASSIC_BACKGROUND);
  await page.mouse.move(0, 0);
  await shoot(page, 'classic-board');
  // The account menu lists the catalogue with a preview card per skin.
  await page.getByRole('button', { name: 'Дмитрий', exact: true }).click();
  await expect(
    page.getByRole('menuitem', { name: /^Классический/ }),
  ).toBeVisible();
  await page.getByRole('menuitem', { name: /^Фокус/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'focus');
  expect(await background(page)).toBe(FOCUS_BACKGROUND);
  await page.mouse.move(0, 0);
  await shoot(page, 'focus-board');
  // The choice is a workspace record, not a browser setting.
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Агентство', exact: true }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'focus');
  expect(await background(page)).toBe(FOCUS_BACKGROUND);
  await page.getByRole('button', { name: /^Фокус/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Скин: текущая задача', exact: true }),
  ).toBeVisible();
  // The current task gets the book typography of the mockup: a serif heading.
  expect(await headingFont(page)).toMatch(/Georgia/);
  await page.mouse.move(0, 0);
  await shoot(page, 'focus-desk');
  // The dark pair of the skin answers the system preference.
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await background(page)).toBe(FOCUS_DARK_BACKGROUND);
  await shoot(page, 'focus-desk-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  // Back to Classic through the API: the attribute leaves with the event.
  await command(page, 'appearance.update', {
    baseRevision: await appearanceRevision(page),
    skinId: 'classic',
  });
  await expect(page.locator('html')).not.toHaveAttribute('data-skin', /.*/);
  expect(await background(page)).toBe(CLASSIC_BACKGROUND);
  expect(await headingFont(page)).not.toMatch(/Georgia/);
  await page.mouse.move(0, 0);
  await shoot(page, 'classic-desk');
});
