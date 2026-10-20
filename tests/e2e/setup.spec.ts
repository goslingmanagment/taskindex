import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { AUTH_DIR, BASE, OWNER, clientIp } from './helpers';
// Проект `setup`: база поднимается пустой, вход владельца по паролю проходит
// здесь один раз, а сессия сохраняется в `storageState`. Остальные тесты
// стартуют уже с ней и не тратят на вход ни времени, ни лимита попыток.
test.beforeAll(() => mkdirSync(AUTH_DIR, { recursive: true }));
for (const base of [BASE])
  test(`вход владельца на базе «${base.name}»`, async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({
      baseURL: base.url,
      extraHTTPHeaders: { 'x-real-ip': clientIp(testInfo) },
    });
    const page = await context.newPage();
    await page.goto('/');
    await page
      .getByRole('textbox', { name: 'Почта', exact: true })
      .fill(OWNER.email);
    await page
      .getByRole('textbox', { name: 'Пароль', exact: true })
      .fill(OWNER.password);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Агентство', exact: true }),
    ).toBeVisible();
    // Пространство пустое: никаких задач из другого проекта здесь быть не может.
    const snapshot = await (await page.request.get('/api/snapshot')).json();
    expect(snapshot.tasks, `база «${base.name}» должна быть пустой`).toEqual(
      [],
    );
    // Только cookies: localStorage проекта `setup` (область черновиков, выбор
    // темы) не должен протекать во все остальные контексты.
    const state = await context.storageState();
    writeFileSync(
      base.storageState,
      `${JSON.stringify({ cookies: state.cookies, origins: [] }, null, 2)}\n`,
    );
    await context.close();
  });
