import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { AUTH_DIR, OWNER, SERVERS, clientIp } from './helpers';
// TI-070: проект `setup`. Каждая база поднимается пустой, поэтому вход владельца
// по паролю проходит здесь один раз на базу, а результат сохраняется в
// `storageState`. Остальные проекты стартуют уже с сессией и не тратят на вход
// ни времени, ни лимита попыток. С TASKINDEX_E2E_PROJECTS вход идёт только на
// базах выбранных проектов: серверов остальных нет (`e2eServers` в helpers.ts).
test.beforeAll(() => mkdirSync(AUTH_DIR, { recursive: true }));
for (const base of SERVERS.bases)
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
