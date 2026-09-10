# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: regressions.spec.ts >> B05 current version control must remain on-screen at mobile width
- Location: docs/audits/2026-09-08-workflows/regressions/regressions.spec.ts:103:1

# Error details

```
Error: The current-version control must be reachable without leaving the viewport

expect(received).toBeGreaterThanOrEqual(expected)

Expected: >= 0
Received:    -75.015625
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
    - main [ref=e4]:
        - generic [ref=e5]:
            - generic [aria-hidden] [ref=e6]:
                - generic [ref=e7]:
                    - button [ref=e8] [cursor=pointer]:
                        - generic [ref=e9]: Toggle Sidebar
                    - heading [level=1] [ref=e11]: Агентство
                - generic [ref=e12]:
                    - button [ref=e14] [cursor=pointer]
                    - button [ref=e18] [cursor=pointer]
            - generic [ref=e19]:
                - generic [aria-hidden] [ref=e20]:
                    - tablist [ref=e21]:
                        - tab [selected] [ref=e22] [cursor=pointer]: Доска
                        - tab [ref=e23] [cursor=pointer]: Список
                    - tabpanel [ref=e24]: Задачи по колонкам
                - generic [ref=e25]:
                    - generic [aria-hidden] [ref=e26] [cursor=pointer]:
                        - checkbox [ref=e27]
                        - checkbox [aria-hidden] [ref=e28]
                        - generic [ref=e29]: На сегодня
                    - button [aria-hidden] [ref=e30] [cursor=pointer]
        - generic [ref=e31]:
            - generic [aria-hidden] [ref=e32]:
                - generic [ref=e33]:
                    - generic [ref=e35]:
                        - heading [level=2] [ref=e37]: Очередь
                        - generic [ref=e38]: '5'
                    - generic [ref=e39]:
                        - article [ref=e40] [cursor=pointer]:
                            - button [ref=e41]
                            - generic [ref=e42]:
                                - button [ref=e43]
                                - heading [level=3] [ref=e46]: B01 сохранено в Б
                            - button [ref=e47]: ···
                            - button [ref=e48]
                        - article [ref=e56] [cursor=pointer]:
                            - button [ref=e57]
                            - generic [ref=e58]:
                                - button [ref=e59]
                                - heading [level=3] [ref=e62]: B02 комментарий
                            - button [ref=e63]: ···
                            - button [ref=e64]
                        - article [ref=e72] [cursor=pointer]:
                            - button [ref=e73]
                            - generic [ref=e74]:
                                - button [ref=e75]
                                - heading [level=3] [ref=e78]: B03 доска не пуста
                            - button [ref=e79]: ···
                            - button [ref=e80]
                        - article [ref=e88] [cursor=pointer]:
                            - button [ref=e89]
                            - generic [ref=e90]:
                                - button [ref=e91]
                                - heading [level=3] [ref=e94]: B03 создать ровно один раз
                            - button [ref=e95]: ···
                            - button [ref=e96]
                        - article [ref=e104] [cursor=pointer]:
                            - button [ref=e105]
                            - generic [ref=e106]:
                                - button [ref=e107]
                                - heading [level=3] [ref=e110]: B05 другая сессия
                            - button [ref=e111]: ···
                            - button [ref=e112]
                    - button [ref=e120] [cursor=pointer]: Добавить задачу
                - generic [ref=e121]:
                    - generic [ref=e123]:
                        - heading [level=2] [ref=e125]: В работе
                        - generic [ref=e126]: '0'
                    - generic [ref=e127]: Начни с одной задачи
                    - button [ref=e130] [cursor=pointer]: Добавить задачу
                - generic [ref=e131]:
                    - generic [ref=e133]:
                        - heading [level=2] [ref=e135]: Жду
                        - generic [ref=e136]: '0'
                    - generic [ref=e137]: Ничего не ждёт ответа
                    - button [ref=e140] [cursor=pointer]: Добавить задачу
                - generic [ref=e141]:
                    - generic [ref=e143]:
                        - heading [level=2] [ref=e145]: Готово
                        - generic [ref=e146]: '0'
                    - generic [ref=e147]: Здесь будут маленькие победы
                    - button [ref=e150] [cursor=pointer]: Добавить задачу
            - status [ref=e151]
    - generic:
        - region "Notifications"
    - dialog [ref=e155]:
        - generic [ref=e156]:
            - generic [ref=e157]: ЗАДАЧА
            - button "Закрыть карточку" [ref=e159] [cursor=pointer]
            - heading "Редактирование задачи" [level=2] [ref=e160]
            - paragraph [ref=e161]: Задача, состояние, заметки и шаги
        - group [ref=e162]:
            - textbox "Название задачи" [ref=e163]:
                - /placeholder: Что нужно сделать?
                - text: B05 мои правки
            - generic [ref=e165]:
                - text: Состояние
                - combobox "Состояние задачи" [ref=e166] [cursor=pointer]:
                    - generic [ref=e167]: Очередь
                    - img [aria-hidden]: ▼
                - textbox [aria-hidden] [ref=e168]: todo
            - generic [ref=e170]:
                - generic [ref=e171]: Агентство / Без направления
                - button "Переместить" [ref=e172] [cursor=pointer]
            - generic [ref=e173]:
                - button "Заметка" [ref=e174] [cursor=pointer]
                - button "Срок" [ref=e175] [cursor=pointer]
                - button "Шаги" [ref=e176] [cursor=pointer]
            - generic [ref=e177]:
                - button "В начало очереди" [disabled]
                - button "В архив" [disabled]
            - generic [ref=e178]:
                - button "Комментарии 0" [ref=e180] [cursor=pointer]:
                    - text: Комментарии
                    - generic [ref=e181]: '0'
                - button "История" [ref=e183] [cursor=pointer]
        - contentinfo [ref=e184]:
            - alert [ref=e185]: Запись изменилась. Ваш текст остался в форме.
            - generic [ref=e186]:
                - group [ref=e187]:
                    - generic "Актуальная версия" [ref=e188]
                - paragraph [ref=e189]: 'Совместим версии: оставим изменённые тобой поля, остальные возьмём из последней версии.'
                - button "Совместить и проверить" [ref=e190] [cursor=pointer]
            - generic [ref=e191]:
                - button "Закрыть" [ref=e192] [cursor=pointer]
                - button "Сохранить" [ref=e193] [cursor=pointer]
```

# Test source

```ts
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
  100 |   await expect(page.getByRole('dialog', { name: 'Переименовать направление', exact: true })).toBeHidden();
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
> 113 |   expect(box.x, 'The current-version control must be reachable without leaving the viewport').toBeGreaterThanOrEqual(0);
      |                                                                                               ^ Error: The current-version control must be reachable without leaving the viewport
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
