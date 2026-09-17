import { test, expect } from '@playwright/test';
import { openWorkspace } from './helpers';
// Скрытие панели навигации (2026-09-18): кнопка в строке бренда скрывает панель,
// выбор переживает перезагрузку, «Открыть навигацию» в шапке показывает панель
// по наведению и закрепляет по клику, ⌘B/Ctrl+B переключает с клавиатуры.
test('the owner hides the navigation panel, the choice survives a reload, hover previews it and a click pins it back', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspace(page, '/?area=agency&project=all&view=board');
  const panel = page.locator('.workspace-sidebar');
  const hide = page.getByRole('button', { name: 'Скрыть панель', exact: true });
  const open = page.getByRole('button', {
    name: 'Открыть навигацию',
    exact: true,
  });
  const heading = (name: string) =>
    page.getByRole('heading', { name, exact: true });
  await expect(panel).toBeInViewport();
  await expect(open).toHaveCount(0);
  // The hide button is a hover affordance: the panel at rest shows only its
  // content.
  await page.mouse.move(700, 500);
  await expect(hide).toHaveCSS('opacity', '0');
  await panel.hover();
  await expect(hide).toHaveCSS('opacity', '1');
  await hide.click();
  await expect(panel).not.toBeInViewport();
  await expect(panel).toHaveAttribute('inert', '');
  await expect(open).toBeVisible();
  await expect(open).toBeFocused();
  await expect(open).toHaveAttribute('aria-expanded', 'false');
  // The choice is a device preference: a reload paints the board wide.
  await page.reload();
  await expect(heading('Агентство')).toBeVisible();
  await expect(panel).toHaveAttribute('inert', '');
  await expect(open).toBeVisible();
  // Hover previews the panel over the board without pinning it; the preview
  // is live, so a navigation from it switches the area and lets it go.
  await open.hover();
  await expect(panel).toHaveAttribute('data-peek', '');
  await expect(panel).toBeInViewport();
  await expect(panel).not.toHaveAttribute('inert');
  await panel.getByRole('button', { name: 'Личное', exact: true }).click();
  await expect(heading('Личное')).toBeVisible();
  await expect(panel).not.toHaveAttribute('data-peek');
  await expect(panel).not.toBeInViewport();
  await expect(panel).toHaveAttribute('inert', '');
  // Leaving the button without a click hides the preview again.
  await open.hover();
  await expect(panel).toBeInViewport();
  await page.mouse.move(900, 600);
  await expect(panel).not.toBeInViewport();
  // A click pins the panel and hands focus to its hide button; the shortcut
  // toggles it from the keyboard.
  await open.click();
  await expect(panel).toBeInViewport();
  await expect(panel).not.toHaveAttribute('inert');
  await expect(open).toHaveCount(0);
  await expect(hide).toBeFocused();
  await page.keyboard.press('ControlOrMeta+b');
  await expect(panel).not.toBeInViewport();
  await expect(open).toBeVisible();
  await page.keyboard.press('ControlOrMeta+b');
  await expect(panel).toBeInViewport();
  await expect(open).toHaveCount(0);
});

test('on a phone the same button closes the navigation sheet', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkspace(page);
  await page
    .getByRole('button', { name: 'Открыть навигацию', exact: true })
    .click();
  const navigation = page.getByRole('dialog', {
    name: 'Навигация',
    exact: true,
  });
  await expect(navigation).toBeVisible();
  const hide = navigation.getByRole('button', {
    name: 'Скрыть панель',
    exact: true,
  });
  await expect(hide).toHaveCSS('opacity', '1');
  await hide.click();
  await expect(navigation).toBeHidden();
});
