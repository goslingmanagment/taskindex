# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: regressions.spec.ts >> B06 open activity must receive a new rejected operation without a data mutation
- Location: docs/audits/2026-09-08-workflows/regressions/regressions.spec.ts:116:1

# Error details

```
Error: expect(locator).toHaveCount(expected) failed

Locator:  locator('.operation-row[data-outcome="rejected"]')
Expected: 4
Received: 3
Timeout:  3000ms

Call log:
  - Expect "toHaveCount" locator('.operation-row[data-outcome="rejected"]') with timeout 3000ms
  - waiting for locator('.operation-row[data-outcome="rejected"]')
    10 × locator resolved to 3 elements
       - unexpected value "3"

```

# Page snapshot

```yaml
- generic [ref=e1]:
  - generic [ref=e3]:
    - generic [ref=e6]:
      - generic [ref=e7]: TaskIndex
      - generic [ref=e12]:
        - list [ref=e13]:
          - listitem [ref=e14]:
            - button "Фокус" [ref=e15] [cursor=pointer]
          - listitem [ref=e20]:
            - button "Активность" [active] [ref=e21] [cursor=pointer]
          - listitem [ref=e28]:
            - button "Агентство" [ref=e29] [cursor=pointer]
          - listitem [ref=e36]:
            - button "Разработка" [ref=e37] [cursor=pointer]
          - listitem [ref=e44]:
            - button "Личное" [ref=e45] [cursor=pointer]
        - generic [ref=e51]: Направления
        - list [ref=e53]:
          - listitem [ref=e54]:
            - button "Все задачи" [ref=e55] [cursor=pointer]
          - listitem [ref=e62]:
            - button "B04 другая сессия" [ref=e63] [cursor=pointer]
          - listitem [ref=e66]:
            - button "Без направления" [ref=e67] [cursor=pointer]
        - button "Добавить направление" [ref=e70] [cursor=pointer]
      - generic [ref=e71]:
        - button "Архив" [ref=e72] [cursor=pointer]
        - generic [ref=e73]:
          - button "Дмитрий" [ref=e74] [cursor=pointer]
          - generic [ref=e79]: Приватно
    - main [ref=e80]:
      - generic [ref=e81]:
        - generic [ref=e82]:
          - heading "Активность" [level=1] [ref=e85]
          - generic [ref=e86]:
            - generic [ref=e87]:
              - button "Открыть поиск" [ref=e88] [cursor=pointer]
              - textbox "Найти во всех областях" [ref=e92]:
                - /placeholder: Найти во всех областях…
              - generic [ref=e93]: ⌘ K
            - button "Добавить задачу" [ref=e94] [cursor=pointer]:
              - generic [ref=e95]: Задача
        - generic [ref=e96]:
          - status [ref=e97]: Изменения пространства
          - button "Настройки доски" [ref=e99] [cursor=pointer]
      - generic [ref=e101]:
        - paragraph [ref=e102]: Изменения владельца и агентов. Операцию можно раскрыть и отменить целиком.
        - generic [ref=e103]:
          - generic [ref=e104]:
            - generic [ref=e105]:
              - button "Дмитрий Операция отклонена 8 сент., 17:40" [ref=e106] [cursor=pointer]:
                - strong [ref=e107]: Дмитрий
                - generic [ref=e108]: Операция отклонена
                - generic [ref=e109]: 8 сент., 17:40
              - button "Отменить" [disabled]
            - paragraph [ref=e110]: Запись изменилась. Ваш текст остался в форме.
          - generic [ref=e111]:
            - generic [ref=e112]:
              - button "Дмитрий Изменена задача · 1 задача 8 сент., 17:40" [ref=e113] [cursor=pointer]:
                - strong [ref=e114]: Дмитрий
                - generic [ref=e115]: Изменена задача · 1 задача
                - generic [ref=e116]: 8 сент., 17:40
              - button "Отменить" [ref=e117] [cursor=pointer]
            - paragraph [ref=e118]: B05 другая сессия
          - generic [ref=e119]:
            - generic [ref=e120]:
              - button "Дмитрий Создана задача · 1 задача 8 сент., 17:40" [ref=e121] [cursor=pointer]:
                - strong [ref=e122]: Дмитрий
                - generic [ref=e123]: Создана задача · 1 задача
                - generic [ref=e124]: 8 сент., 17:40
              - button "Отменить" [ref=e125] [cursor=pointer]
            - paragraph [ref=e126]: B05 другая сессия
          - generic [ref=e127]:
            - generic [ref=e128]:
              - button "Дмитрий Операция отклонена 8 сент., 17:40" [ref=e129] [cursor=pointer]:
                - strong [ref=e130]: Дмитрий
                - generic [ref=e131]: Операция отклонена
                - generic [ref=e132]: 8 сент., 17:40
              - button "Отменить" [disabled]
            - paragraph [ref=e133]: Запись изменилась. Ваш текст остался в форме.
          - generic [ref=e134]:
            - generic [ref=e135]:
              - button "Дмитрий Операция отклонена 8 сент., 17:40" [ref=e136] [cursor=pointer]:
                - strong [ref=e137]: Дмитрий
                - generic [ref=e138]: Операция отклонена
                - generic [ref=e139]: 8 сент., 17:40
              - button "Отменить" [disabled]
            - paragraph [ref=e140]: Запись изменилась. Ваш текст остался в форме.
          - generic [ref=e142]:
            - button "Дмитрий Изменено направление 8 сент., 17:40" [ref=e143] [cursor=pointer]:
              - strong [ref=e144]: Дмитрий
              - generic [ref=e145]: Изменено направление
              - generic [ref=e146]: 8 сент., 17:40
            - button "Отменить" [ref=e147] [cursor=pointer]
          - generic [ref=e149]:
            - button "Дмитрий Создано направление 8 сент., 17:40" [ref=e150] [cursor=pointer]:
              - strong [ref=e151]: Дмитрий
              - generic [ref=e152]: Создано направление
              - generic [ref=e153]: 8 сент., 17:40
            - button "Отменить" [disabled]
          - generic [ref=e154]:
            - generic [ref=e155]:
              - button "Дмитрий Создана задача · 1 задача 8 сент., 17:40" [ref=e156] [cursor=pointer]:
                - strong [ref=e157]: Дмитрий
                - generic [ref=e158]: Создана задача · 1 задача
                - generic [ref=e159]: 8 сент., 17:40
              - button "Отменить" [ref=e160] [cursor=pointer]
            - paragraph [ref=e161]: B03 создать ровно один раз
          - generic [ref=e162]:
            - generic [ref=e163]:
              - button "Дмитрий Создана задача · 1 задача 8 сент., 17:40" [ref=e164] [cursor=pointer]:
                - strong [ref=e165]: Дмитрий
                - generic [ref=e166]: Создана задача · 1 задача
                - generic [ref=e167]: 8 сент., 17:40
              - button "Отменить" [ref=e168] [cursor=pointer]
            - paragraph [ref=e169]: B03 доска не пуста
          - generic [ref=e170]:
            - generic [ref=e171]:
              - button "Дмитрий Создана задача · 1 задача 8 сент., 17:40" [ref=e172] [cursor=pointer]:
                - strong [ref=e173]: Дмитрий
                - generic [ref=e174]: Создана задача · 1 задача
                - generic [ref=e175]: 8 сент., 17:40
              - button "Отменить" [ref=e176] [cursor=pointer]
            - paragraph [ref=e177]: B02 комментарий
          - generic [ref=e178]:
            - generic [ref=e179]:
              - button "Дмитрий Сохранена карточка · 1 задача 8 сент., 17:39" [ref=e180] [cursor=pointer]:
                - strong [ref=e181]: Дмитрий
                - generic [ref=e182]: Сохранена карточка · 1 задача
                - generic [ref=e183]: 8 сент., 17:39
              - button "Отменить" [ref=e184] [cursor=pointer]
            - paragraph [ref=e185]: B01 сохранено в Б
          - generic [ref=e186]:
            - generic [ref=e187]:
              - button "Дмитрий Создана задача · 1 задача 8 сент., 17:39" [ref=e188] [cursor=pointer]:
                - strong [ref=e189]: Дмитрий
                - generic [ref=e190]: Создана задача · 1 задача
                - generic [ref=e191]: 8 сент., 17:39
              - button "Отменить" [ref=e192] [cursor=pointer]
            - paragraph [ref=e193]: B01 сохранено в Б
  - generic:
    - region "Notifications"
```

# Test source

```ts
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
  113 |   expect(box.x, 'The current-version control must be reachable without leaving the viewport').toBeGreaterThanOrEqual(0);
  114 | });
  115 | 
  116 | test('B06 open activity must receive a new rejected operation without a data mutation', async ({ page }) => {
  117 |   await page.getByRole('button', { name: 'Активность', exact: true }).click();
  118 |   await expect(page.getByText('Загружаем активность…', { exact: true })).toBeHidden();
  119 |   const rejected = page.locator('.operation-row[data-outcome="rejected"]');
  120 |   const before = await rejected.count();
  121 |   expect((await command(page, 'task.update', { id: randomUUID(), baseRevision: 1, title: 'B06 отказ' })).status()).toBe(404);
> 122 |   await expect(rejected).toHaveCount(before + 1);
      |                          ^ Error: expect(locator).toHaveCount(expected) failed
  123 | });
  124 | 
```