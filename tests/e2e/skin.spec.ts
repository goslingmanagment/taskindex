import { test, expect, type Page } from '@playwright/test';
import { signIn } from './helpers';
// TI-025 phase A: the skin must keep winning over the utility classes of the
// primitives by its cascade layer alone. These rules used `!important` before
// the layers were declared; screenshots do not cover the dialogs, so their
// computed values are asserted directly.

async function style(page: Page, selector: string, property: string) {
  return page.evaluate(
    ([sel, prop]) => {
      const node = document.querySelector(sel!);
      return node ? getComputedStyle(node).getPropertyValue(prop!) : null;
    },
    [selector, property] as const,
  );
}

test('the skin layer outranks the primitive utilities without !important', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signIn(page, testInfo);
  // The heading tabs keep the skin height, not the primitive's own.
  expect(await style(page, '.view-tabs', 'height')).toBe('44px');
  // The quick-create dialog keeps its width against `sm:max-w-sm`.
  await page.keyboard.press('n');
  await expect(
    page.getByRole('dialog', { name: 'Новая задача', exact: true }),
  ).toBeVisible();
  expect(await style(page, '.create-dialog', 'width')).toBe('480px');
  await page.keyboard.press('Escape');
  // The editor sheet keeps its width and surface.
  await page
    .getByRole('button', { name: 'Добавить задачу', exact: true })
    .first()
    .click();
  await page
    .getByRole('textbox', { name: 'Что нужно сделать?', exact: true })
    .fill('Э2Э: скин');
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await page
    .getByRole('button', { name: 'Открыть: Э2Э: скин', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Название задачи', exact: true }),
  ).toBeVisible();
  expect(await style(page, '.task-sheet', 'width')).toBe('520px');
  expect(await style(page, '.task-title-row h3', 'padding-top')).toBe('0px');
});
