import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { OWNER, openWorkspace, seedReferenceData, snapshot } from './helpers';
// TI-018 (план 10, доп. шаг 21): критический путь на движке WebKit —
// `devices['Desktop Safari']`. Браузер ставится один раз: `npx playwright
// install webkit`. Здесь проверяются именно различия движка (EventSource, Web
// Locks в `drafts.ts`, `AbortSignal.timeout`), а не заново весь Chromium-набор:
// касания остаются за `workspace.spec.ts`, эталонные снимки — за `visual.spec.ts`.
//
// WebKit Playwright — не Safari на iPhone. Passkey, системные диалоги, клавиатура,
// safe area и ориентация проверяются на устройстве по `docs/acceptance/phone.md`.
const heading = (page: Page) =>
  page.getByRole('heading', { name: 'Агентство', exact: true });
const title = (page: Page) =>
  page.getByRole('textbox', { name: 'Название задачи', exact: true });
const note = (page: Page) =>
  page.getByRole('textbox', { name: 'Заметка к задаче', exact: true });
async function createTask(page: Page, name: string) {
  await page
    .getByRole('button', { name: 'Добавить задачу', exact: true })
    .first()
    .click();
  await page
    .getByRole('textbox', { name: 'Что нужно сделать?', exact: true })
    .fill(name);
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Новая задача', exact: true }),
  ).toBeHidden();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
async function openTask(page: Page, name: string) {
  await page
    .getByRole('button', { name: `Открыть: ${name}`, exact: true })
    .click();
  await expect(title(page)).toBeVisible();
}
// Известная причина прошлого отката (docs/acceptance/test-debt.md): секция
// «Заметка» раскрыта только когда заметка уже сохранена на сервере
// (`editor.tsx:137`, `more.note = !!task.note`). После сохранения и после
// перезагрузки её надо раскрывать явно, иначе поля в DOM просто нет.
async function showNote(page: Page) {
  const field = note(page);
  if ((await field.count()) === 0)
    await page.getByRole('button', { name: 'Заметка', exact: true }).click();
  await expect(field).toBeVisible();
  return field;
}
test.describe('без сессии владельца', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('WebKit: вход по паролю и выход', async ({ page }) => {
    await page.context().setExtraHTTPHeaders({ 'x-real-ip': '10.18.0.1' });
    await page.goto('/');
    await page
      .getByRole('textbox', { name: 'Почта', exact: true })
      .fill(OWNER.email);
    await page
      .getByRole('textbox', { name: 'Пароль', exact: true })
      .fill(OWNER.password);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(heading(page)).toBeVisible();
    expect((await page.request.get('/api/snapshot')).ok()).toBe(true);
    await page.getByRole('button', { name: 'Дмитрий', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Выйти', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Войти в пространство', exact: true }),
    ).toBeVisible();
    expect((await page.request.get('/api/snapshot')).status()).toBe(401);
  });
});
test('WebKit: создание, правка и сохранение при переподключении SSE', async ({
  page,
}) => {
  // Поток событий недоступен с самого начала: индикатор не должен показывать
  // «online», а команды обязаны уходить и без него.
  await page.route('**/api/events/stream*', (route) => route.abort('failed'));
  await openWorkspace(page);
  const status = page.locator('.sync-status');
  await expect(status).not.toHaveAttribute('data-connection', 'online');
  const name = 'Э2Э WebKit: правка';
  await createTask(page, name);
  await openTask(page, name);
  await page.getByRole('button', { name: 'Заметка', exact: true }).click();
  await note(page).fill('Заметка из WebKit');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Редактирование задачи', exact: true }),
  ).toBeHidden();
  const state = await snapshot(page);
  const task = state.tasks.find((item) => item.title === name)!;
  expect(task.note).toBe('Заметка из WebKit');
  // Поток снова доступен: EventSource пересоздаётся, индикатор возвращается в
  // «online». Любая новая команда будит `connect()` без ожидания backoff.
  await page.unroute('**/api/events/stream*');
  await createTask(page, 'Э2Э WebKit: после переподключения');
  await expect(status).toHaveAttribute('data-connection', 'online', {
    timeout: 45000,
  });
  // Сохранённая заметка видна в переоткрытом редакторе: секцию раскрываем явно.
  await openTask(page, name);
  await expect(await showNote(page)).toHaveValue('Заметка из WebKit');
});
test('WebKit: черновик переживает перезагрузку (Web Locks)', async ({
  page,
}) => {
  await openWorkspace(page);
  expect(
    await page.evaluate(() => typeof navigator.locks?.request === 'function'),
  ).toBe(true);
  const name = 'Э2Э WebKit: черновик';
  await createTask(page, name);
  await openTask(page, name);
  await title(page).fill('Э2Э WebKit: несохранённое название');
  await page.getByRole('button', { name: 'Заметка', exact: true }).click();
  await note(page).fill('Несохранённая заметка');
  await expect(page.getByText('Есть изменения', { exact: true })).toBeVisible();
  page.on('dialog', (dialog) => void dialog.accept());
  await page.reload();
  await expect(title(page)).toHaveValue('Э2Э WebKit: несохранённое название');
  await expect(await showNote(page)).toHaveValue('Несохранённая заметка');
  // Ничего не сохранено: на сервере осталось исходное название.
  const state = await snapshot(page);
  expect(state.tasks.some((item) => item.title === name)).toBe(true);
});
test('WebKit: чеклист, комментарии и индикатор неподтверждённой команды', async ({
  page,
}) => {
  await openWorkspace(page);
  const name = 'Э2Э WebKit: карточка';
  await createTask(page, name);
  await openTask(page, name);
  await page.getByRole('button', { name: 'Шаги', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Новый шаг', exact: true })
    .fill('Первый шаг');
  await page.getByRole('button', { name: 'Добавить шаг', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Выполнено: Первый шаг', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Комментарии/ }).click();
  await page
    .getByRole('textbox', { name: 'Новый комментарий', exact: true })
    .fill('Комментарий из WebKit');
  await page
    .getByRole('button', { name: 'Добавить комментарий', exact: true })
    .click();
  await expect(
    page.getByText('Комментарий из WebKit', { exact: true }),
  ).toBeVisible();
  // Индикатор pending: ответ на команду теряется, конверт остаётся в очереди и
  // сообщает о себе, а не исчезает молча.
  await page.route('**/api/commands', (route) => route.abort('failed'));
  await page
    .getByRole('textbox', { name: 'Новый комментарий', exact: true })
    .fill('Комментарий без ответа');
  await page
    .getByRole('button', { name: 'Добавить комментарий', exact: true })
    .click();
  await expect(page.locator('[data-notice="unknown"]')).toContainText(
    'Комментарий без ответа',
    { timeout: 45000 },
  );
  await page.unroute('**/api/commands');
});
test('WebKit @dark: доска, редактор и лента в тёмной теме', async ({
  page,
}, testInfo) => {
  const dir = `test-results/e2e-${testInfo.project.name}`;
  mkdirSync(dir, { recursive: true });
  const shoot = (scene: string) =>
    page.screenshot({
      path: `${dir}/${scene}.png`,
      animations: 'disabled',
    });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkspace(page);
  await seedReferenceData(page);
  await page.goto('/?area=agency&project=all&view=board');
  await expect(
    page.getByRole('heading', {
      name: 'Выбрать контент-менеджера',
      exact: true,
    }),
  ).toBeVisible();
  // Тот же один пиксель фона, что и в `dark.spec.ts`: медиазапрос сработал.
  expect(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
  ).toBe('rgb(25, 29, 36)');
  await page.mouse.move(0, 0);
  await shoot('desktop-board');
  await page
    .getByRole('button', {
      name: 'Открыть: Выбрать контент-менеджера',
      exact: true,
    })
    .click();
  await expect(title(page)).toBeVisible();
  await shoot('desktop-editor');
  await page
    .getByRole('button', { name: 'Закрыть карточку', exact: true })
    .click();
  await page.getByRole('button', { name: 'Активность', exact: true }).click();
  await expect(page.locator('.operation-row').first()).toBeVisible();
  await shoot('desktop-activity');
});
