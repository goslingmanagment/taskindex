import { test, expect, type Page } from '@playwright/test';
import { clientIp, OWNER, signIn } from './helpers';
// TI-030: the interface a screen reader announces must be Russian everywhere
// the visible interface is. Every assertion here goes through the role and the
// accessible name, so an English `aria-label` or `sr-only` caption fails even
// when the visible text is already translated.

// Product name, protocol words and keyboard keys legitimately stay Latin.
const ALLOWED = new Set([
  'TaskIndex',
  'passkey',
  'Passkey',
  'N',
  'B',
  'Esc',
  'Enter',
  'Ctrl',
  'Shift',
  'Alt',
  'Cmd',
  'Tab',
]);
// The accessible names of everything currently rendered: `aria-label`, `title`,
// visually hidden captions and the text of controls without a label.
async function accessibleNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const names: string[] = [];
    for (const node of document.querySelectorAll<HTMLElement>('*')) {
      if (!node.checkVisibility()) continue;
      const label = node.getAttribute('aria-label');
      if (label) names.push(label);
      const title = node.getAttribute('title');
      if (title) names.push(title);
      const placeholder = node.getAttribute('placeholder');
      if (placeholder) names.push(placeholder);
      if (node.classList.contains('sr-only') && node.textContent)
        names.push(node.textContent);
      if (
        (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button') &&
        !label &&
        node.textContent
      )
        names.push(node.textContent);
    }
    return names;
  });
}
function englishIn(names: string[]): string[] {
  const offenders: string[] = [];
  for (const name of names)
    for (const word of name.match(/[A-Za-z][A-Za-z'-]*/g) ?? [])
      if (!ALLOWED.has(word)) offenders.push(`«${name.trim()}» → ${word}`);
  return offenders;
}

// TI-070: единственный тест, которому нужна форма входа. Сессия из `setup`
// здесь отключена, остальные тесты файла открывают уже готовое пространство.
test.describe('без сессии владельца', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('TI-030 a wrong password, a server failure and a lost connection are reported in Russian', async ({
    page,
  }, testInfo) => {
    await page
      .context()
      .setExtraHTTPHeaders({ 'x-real-ip': clientIp(testInfo) });
    await page.goto('/');
    const email = page.getByRole('textbox', { name: 'Почта', exact: true });
    const password = page.getByRole('textbox', { name: 'Пароль', exact: true });
    const submit = page.getByRole('button', { name: 'Войти', exact: true });
    await email.fill(OWNER.email);
    await password.fill('совершенно-не-тот-пароль');
    await submit.click();
    // The server answers `INVALID_EMAIL_OR_PASSWORD` in English; the alert must not.
    await expect(page.getByRole('alert')).toHaveText(
      'Неверная почта или пароль.',
    );
    expect(englishIn(await accessibleNames(page))).toEqual([]);

    await page.route('**/api/auth/sign-in/email', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Internal Server Error' }),
      }),
    );
    await password.fill(OWNER.password);
    await submit.click();
    await expect(page.getByRole('alert')).toContainText('Сервер недоступен.');
    await expect(page.getByRole('alert')).not.toContainText(/[A-Za-z]{3,}/);

    await page.unroute('**/api/auth/sign-in/email');
    await page.route('**/api/auth/sign-in/email', (route) => route.abort());
    await submit.click();
    await expect(page.getByRole('alert')).toHaveText(
      'Нет связи с сервером. Проверьте соединение.',
    );
    await page.unroute('**/api/auth/sign-in/email');

    // The sign-in screen still works once the connection is back.
    await submit.click();
    await expect(
      page.getByRole('heading', { name: 'Агентство', exact: true }),
    ).toBeVisible();
  });
});

test('TI-030 the mobile navigation announces itself in Russian', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, testInfo);
  const trigger = page.getByRole('button', {
    name: 'Открыть навигацию',
    exact: true,
  });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const navigation = page.getByRole('dialog', {
    name: 'Навигация',
    exact: true,
  });
  await expect(navigation).toBeVisible();
  await expect(
    navigation.getByRole('button', { name: 'Фокус', exact: false }).first(),
  ).toBeVisible();
  expect(englishIn(await accessibleNames(page))).toEqual([]);
  // Nothing announced as «Sidebar» or «Toggle Sidebar» is left behind.
  await expect(page.getByLabel(/sidebar/i)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(navigation).toBeHidden();
});

test('TI-030 closing a dialog and a notification are Russian actions', async ({
  page,
}, testInfo) => {
  await signIn(page, testInfo);
  await page.keyboard.press('n');
  const dialog = page.getByRole('dialog', {
    name: 'Новая задача',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  expect(englishIn(await accessibleNames(page))).toEqual([]);
  await dialog
    .getByRole('textbox', { name: 'Что нужно сделать?', exact: true })
    .fill('Э2Э: русские подписи');
  await dialog.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(dialog).toBeHidden();
  // The toast that confirms the new task closes through a Russian action.
  const toast = page.locator('[data-slot="toast"]').first();
  await expect(toast).toContainText('Задача добавлена');
  expect(englishIn(await accessibleNames(page))).toEqual([]);
  // Base UI keeps the close button out of the accessibility tree until the
  // stack is expanded or the button is focused, so hover it the way a reader
  // of the notification would.
  await toast.hover();
  await toast
    .getByRole('button', { name: 'Закрыть уведомление', exact: true })
    .click();
  await expect(toast).toBeHidden();
  // The dialog close button carries a Russian caption, not «Close».
  await page.keyboard.press('n');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(dialog).toBeHidden();
});
