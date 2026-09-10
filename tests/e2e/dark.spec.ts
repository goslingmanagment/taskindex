import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { signIn } from './helpers';
// TI-025 шаг 10: тёмная тема. Проект `dark` (playwright.config.ts) даёт
// prefers-color-scheme: dark и идёт после `functional`, поэтому пространство уже
// наполнено фикстурой визуального сравнения. Снимки складываются отдельно от
// эталона светлой темы: они нужны для просмотра глазами, а не для побайтного
// сравнения.
const ARTIFACTS = 'test-results/e2e-dark';
const DARK_BACKGROUND = 'rgb(25, 29, 36)';
const LIGHT_BACKGROUND = 'rgb(247, 248, 250)';
test.beforeAll(() => mkdirSync(ARTIFACTS, { recursive: true }));
const shoot = (page: Page, name: string) =>
  page.screenshot({ path: `${ARTIFACTS}/${name}.png`, animations: 'disabled' });
const background = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('the system preference paints the nine scenes dark', async ({
  page,
}, testInfo) => {
  await signIn(page, testInfo);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/?area=agency&project=all&view=board');
  await expect(
    page.getByRole('heading', { name: 'Агентство', exact: true }),
  ).toBeVisible();
  // Один пиксель фона: значение --background тёмного блока tokens.css.
  expect(await background(page)).toBe(DARK_BACKGROUND);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
  await page.mouse.move(0, 0);
  await shoot(page, 'desktop-board');
  await page.getByRole('tab', { name: 'Список', exact: true }).click();
  await shoot(page, 'desktop-list');
  await page.getByRole('tab', { name: 'Доска', exact: true }).click();
  const card = page.getByRole('button', { name: /^Открыть: / }).first();
  await card.click();
  await expect(
    page.getByRole('textbox', { name: 'Название задачи', exact: true }),
  ).toBeVisible();
  await shoot(page, 'desktop-editor');
  await page.getByRole('button', { name: /^Комментарии/ }).click();
  await page.getByRole('button', { name: 'История', exact: true }).click();
  await page.locator('.editor-body').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await shoot(page, 'desktop-discussion');
  await page
    .getByRole('button', { name: 'Закрыть карточку', exact: true })
    .click();
  await page.getByRole('button', { name: 'Активность', exact: true }).click();
  await expect(page.locator('.operation-row').first()).toBeVisible();
  await shoot(page, 'desktop-activity');
  await page.locator('.operation-row').first().click();
  await shoot(page, 'desktop-activity-open');
  await page.getByRole('button', { name: 'Агентство', exact: true }).click();
  await page.keyboard.press('n');
  await expect(
    page.getByRole('dialog', { name: 'Новая задача', exact: true }),
  ).toBeVisible();
  await shoot(page, 'desktop-create');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.mouse.move(0, 0);
  await shoot(page, 'mobile-board');
  await page
    .getByRole('button', { name: 'Открыть навигацию', exact: true })
    .click();
  await page.getByRole('button', { name: /^Фокус/ }).click();
  await shoot(page, 'mobile-focus');
});

test('the account menu overrides the system and the choice survives a reload', async ({
  page,
}, testInfo) => {
  await signIn(page, testInfo);
  expect(await background(page)).toBe(DARK_BACKGROUND);
  await page.getByRole('button', { name: 'Дмитрий', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Светлая', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await background(page)).toBe(LIGHT_BACKGROUND);
  // Выбор хранится в пространстве, а не только в браузере: после перезагрузки
  // он всё ещё светлый, хотя система просит тёмную.
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Агентство', exact: true }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await background(page)).toBe(LIGHT_BACKGROUND);
  await page.getByRole('button', { name: 'Дмитрий', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Тёмная', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await background(page)).toBe(DARK_BACKGROUND);
  // «Как в системе» снимает атрибут, чтобы снова действовал медиазапрос.
  await page.getByRole('button', { name: 'Дмитрий', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Как в системе', exact: true })
    .click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
  expect(await background(page)).toBe(DARK_BACKGROUND);
});
