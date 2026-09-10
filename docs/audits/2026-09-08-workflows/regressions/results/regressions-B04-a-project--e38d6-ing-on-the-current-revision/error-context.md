# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: regressions.spec.ts >> B04 a project conflict must recover after reopening on the current revision
- Location: docs/audits/2026-09-08-workflows/regressions/regressions.spec.ts:84:1

# Error details

```
Error: expect(locator).toBeHidden() failed

Locator:  getByRole('dialog', { name: 'Переименовать направление', exact: true })
Expected: hidden
Received: visible
Timeout:  3000ms

Call log:
  - Expect "toBeHidden" getByRole('dialog', { name: 'Переименовать направление', exact: true }) with timeout 3000ms
  - waiting for getByRole('dialog', { name: 'Переименовать направление', exact: true })
    10 × locator resolved to <div id="_r_1j_" data-open="" role="dialog" tabindex="-1" data-base-ui-focusable="" data-slot="dialog-content" aria-labelledby="base-ui-_r_1l_" aria-describedby="base-ui-_r_1m_" class="fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-c…>…</div>
       - unexpected value "visible"

```

```yaml
- dialog "Переименовать направление":
    - heading "Переименовать направление" [level=2]
    - paragraph: Агентство
    - group
    - button "Close"
```

# Test source

```ts
  1   | import { test, expect, type Page } from '@playwright/test';
  2   | import { randomUUID } from 'node:crypto';
  3   |
  4   | // These assert the desired behavior. The audited implementation fails them.
  5   | const origin = 'http://localhost:4198';
  6   | async function snapshot(page: Page) {
  7   |   return (await page.request.get('/api/snapshot')).json();
  8   | }
  9   | async function command(page: Page, name: string, payload: object) {
  10  |   const state = await snapshot(page);
  11  |   return page.request.post('/api/commands', {
  12  |     headers: { Origin: origin },
  13  |     data: { generation: state.generation, operationId: randomUUID(), command: name, payload },
  14  |   });
  15  | }
  16  | async function task(page: Page, title: string) {
  17  |   const id = randomUUID();
  18  |   expect((await command(page, 'task.create', { id, area: 'agency', title })).ok()).toBe(true);
  19  |   await expect(page.getByRole('button', { name: `Открыть: ${title}`, exact: true })).toBeVisible();
  20  |   return id;
  21  | }
  22  | async function open(page: Page, title: string) {
  23  |   await page.getByRole('button', { name: `Открыть: ${title}`, exact: true }).click();
  24  |   await expect(page.getByRole('dialog', { name: 'Редактирование задачи', exact: true })).toBeVisible();
  25  | }
  26  | test.beforeEach(async ({ page }, testInfo) => {
  27  |   // The local fixture has no Nginx. Give each independent test client an IP
  28  |   // rather than spending the shared login-rate-limit bucket across tests.
  29  |   const caseNumber = Number(testInfo.title.match(/B(\d+)/)?.[1] ?? 1);
  30  |   await page.context().setExtraHTTPHeaders({ 'x-real-ip': `192.0.2.${caseNumber}` });
  31  |   await page.goto('/');
  32  |   await page.getByRole('textbox', { name: 'Почта', exact: true }).fill('owner@example.test');
  33  |   await page.getByRole('textbox', { name: 'Пароль', exact: true }).fill('TaskIndex-e2e-password-2026');
  34  |   await page.getByRole('button', { name: 'Войти', exact: true }).click();
  35  |   await expect(page.getByRole('heading', { name: 'Агентство', exact: true })).toBeVisible();
  36  | });
  37  |
  38  | test('B01 saving tab B must not delete the unsaved task draft in tab A', async ({ page, context }) => {
  39  |   await task(page, 'B01 исходное название');
  40  |   await open(page, 'B01 исходное название');
  41  |   const other = await context.newPage();
  42  |   await other.goto(page.url());
  43  |   await expect(other.getByRole('textbox', { name: 'Название задачи', exact: true })).toHaveValue('B01 исходное название');
  44  |   await page.getByRole('textbox', { name: 'Название задачи', exact: true }).fill('B01 важный несохранённый текст');
  45  |   // Ensure the effect has written the draft before B starts saving.
  46  |   await expect(page.getByText('Есть изменения', { exact: true })).toBeVisible();
  47  |   await other.getByRole('textbox', { name: 'Название задачи', exact: true }).fill('B01 сохранено в Б');
  48  |   await other.getByRole('button', { name: 'Сохранить', exact: true }).click();
  49  |   await expect(other.getByRole('dialog', { name: 'Редактирование задачи', exact: true })).toBeHidden();
  50  |   await page.getByRole('button', { name: 'Закрыть карточку', exact: true }).click();
  51  |   await page.getByRole('button', { name: 'Закрыть с черновиком', exact: true }).click();
  52  |   await open(page, 'B01 сохранено в Б');
  53  |   await expect(page.getByRole('textbox', { name: 'Название задачи', exact: true })).toHaveValue('B01 важный несохранённый текст');
  54  | });
  55  |
  56  | test('B02 clearing a comment draft must stay cleared after reopening', async ({ page }) => {
  57  |   await task(page, 'B02 комментарий');
  58  |   await open(page, 'B02 комментарий');
  59  |   await page.getByRole('button', { name: 'Комментарии 0', exact: true }).click();
  60  |   const field = page.getByRole('textbox', { name: 'Новый комментарий', exact: true });
  61  |   await field.fill('B02 текст удалён пользователем');
  62  |   await field.fill('');
  63  |   await page.getByRole('button', { name: 'Закрыть карточку', exact: true }).click();
  64  |   await open(page, 'B02 комментарий');
  65  |   await page.getByRole('button', { name: 'Комментарии 0', exact: true }).click();
  66  |   await expect(field).toHaveValue('');
  67  | });
  68  |
  69  | test('B03 quick-create must consume the inline draft after creating its task', async ({ page }) => {
  70  |   await task(page, 'B03 доска не пуста');
  71  |   const add = page.getByRole('button', { name: 'Добавить задачу', exact: true });
  72  |   await add.nth(1).click();
  73  |   const field = page.getByRole('textbox', { name: 'Название новой задачи', exact: true });
  74  |   await field.fill('B03 создать ровно один раз');
  75  |   await field.press('Escape');
  76  |   await add.first().click();
  77  |   await expect(page.getByRole('textbox', { name: 'Что нужно сделать?', exact: true })).toHaveValue('B03 создать ровно один раз');
  78  |   await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  79  |   await expect(page.getByRole('dialog', { name: 'Новая задача', exact: true })).toBeHidden();
  80  |   await add.nth(1).click();
  81  |   await expect(field).toHaveValue('');
  82  | });
  83  |
  84  | test('B04 a project conflict must recover after reopening on the current revision', async ({ page }) => {
  85  |   const id = randomUUID();
  86  |   expect((await command(page, 'project.create', { id, area: 'agency', name: 'B04 направление', color: '#3465df' })).ok()).toBe(true);
  87  |   await page.getByRole('button', { name: 'B04 направление', exact: true }).click();
  88  |   async function editProject() {
  89  |     await page.getByRole('button', { name: 'Настройки доски', exact: true }).click();
  90  |     await page.getByRole('menuitem', { name: 'Переименовать проект', exact: true }).click();
  91  |   }
  92  |   await editProject();
  93  |   await page.getByRole('textbox', { name: 'Название направления', exact: true }).fill('B04 моё имя');
  94  |   expect((await command(page, 'project.update', { id, baseRevision: 1, name: 'B04 другая сессия' })).ok()).toBe(true);
  95  |   await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  96  |   await expect(page.getByRole('alert')).toHaveText('Запись изменилась. Ваш текст остался в форме.');
  97  |   await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  98  |   await editProject();
  99  |   await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
> 100 |   await expect(page.getByRole('dialog', { name: 'Переименовать направление', exact: true })).toBeHidden();
      |                                                                                              ^ Error: expect(locator).toBeHidden() failed
  101 | });
  102 |
  103 | test('B05 current version control must remain on-screen at mobile width', async ({ page }) => {
  104 |   const id = await task(page, 'B05 мобильный конфликт');
  105 |   await page.setViewportSize({ width: 320, height: 568 });
  106 |   await open(page, 'B05 мобильный конфликт');
  107 |   await page.getByRole('textbox', { name: 'Название задачи', exact: true }).fill('B05 мои правки');
  108 |   expect((await command(page, 'task.update', { id, baseRevision: 1, title: 'B05 другая сессия' })).ok()).toBe(true);
  109 |   await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  110 |   const summary = page.getByText('Актуальная версия', { exact: true });
  111 |   await expect(summary).toBeVisible();
  112 |   const box = (await summary.boundingBox())!;
  113 |   expect(box.x, 'The current-version control must be reachable without leaving the viewport').toBeGreaterThanOrEqual(0);
  114 | });
  115 |
  116 | test('B06 open activity must receive a new rejected operation without a data mutation', async ({ page }) => {
  117 |   await page.getByRole('button', { name: 'Активность', exact: true }).click();
  118 |   await expect(page.getByText('Загружаем активность…', { exact: true })).toBeHidden();
  119 |   const rejected = page.locator('.operation-row[data-outcome="rejected"]');
  120 |   const before = await rejected.count();
  121 |   expect((await command(page, 'task.update', { id: randomUUID(), baseRevision: 1, title: 'B06 отказ' })).status()).toBe(404);
  122 |   await expect(rejected).toHaveCount(before + 1);
  123 | });
  124 |
```
