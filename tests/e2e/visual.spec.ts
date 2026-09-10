import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { OperationError, Snapshot } from '../../src/shared/model';
import { resolveArtifactDir } from './artifacts';
import {
  VISUAL_NOW,
  command,
  openWorkspace,
  seedReferenceData,
} from './helpers';
// TI-070: единственная спека, снимающая эталон. Она идёт отдельным проектом
// `visual` на своей чистой базе, поэтому в кадре нет записей других сцен, а
// часы заморожены с двух сторон: сервер получает `now` из окружения
// (`playwright.config.ts` → `tests/e2e/server.ts`), браузер — через
// `page.clock.setFixedTime`. Из-за этого «Сегодня», «Завтра» и метки времени в
// ленте одинаковы на двух прогонах подряд, и `screenshots-sha256.json` совпадает.
//
// TI-058: по умолчанию `test-results/e2e-artifacts`; эталон в `docs/reference`
// обновляется только `npm run e2e:publish-reference` (см. `tests/e2e/artifacts.ts`).
const artifacts = resolveArtifactDir();
test.beforeAll(() => {
  mkdirSync(artifacts, { recursive: true });
});
test.afterAll(() => {
  const hashes = Object.fromEntries(
    readdirSync(artifacts)
      .filter((name) => name.endsWith('.png'))
      .sort()
      .map((name) => [
        name,
        createHash('sha256')
          .update(readFileSync(`${artifacts}/${name}`))
          .digest('hex'),
      ]),
  );
  writeFileSync(
    `${artifacts}/screenshots-sha256.json`,
    `${JSON.stringify(hashes, null, 2)}\n`,
  );
});
test('эталонные сцены снимаются на чистой базе и замороженных часах', async ({
  page,
  browser,
}) => {
  await page.clock.setFixedTime(new Date(VISUAL_NOW));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkspace(page);
  writeFileSync(
    `${artifacts}/environment.json`,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        node: process.version,
        browser: browser.version(),
        playwright: '1.63.0',
        desktop: { width: 1440, height: 1000 },
        mobile: { width: 390, height: 844 },
        origin: test.info().project.use.baseURL,
        frozenClock: VISUAL_NOW,
        data: 'tests/e2e/reference-data.json via real /api/commands/batch',
      },
      null,
      2,
    ) + '\n',
  );
  await seedReferenceData(page);
  const shoot = (name: string) =>
    page.screenshot({
      path: `${artifacts}/${name}.png`,
      animations: 'disabled',
    });
  await page.goto('/?area=agency&project=all&view=board');
  await expect(
    page.getByRole('heading', {
      name: 'Выбрать контент-менеджера',
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('.sync-status')).toHaveAttribute(
    'data-connection',
    'online',
  );
  await page.mouse.move(0, 0);
  await shoot('desktop-board');
  await page.getByRole('tab', { name: 'Список', exact: true }).click();
  await shoot('desktop-list');
  await page.getByRole('tab', { name: 'Доска', exact: true }).click();
  await page
    .getByRole('button', {
      name: 'Открыть: Выбрать контент-менеджера',
      exact: true,
    })
    .click();
  await shoot('desktop-editor');
  await command(page, 'comment.add', {
    taskId: 'visual-a1',
    text: 'Короткий список собран. Следующий шаг — проверить тестовые.',
  });
  await page.getByRole('button', { name: /^Комментарии/ }).click();
  await page.getByRole('button', { name: 'История', exact: true }).click();
  await expect(
    page.getByText(
      'Короткий список собран. Следующий шаг — проверить тестовые.',
      { exact: true },
    ),
  ).toBeVisible();
  // История подгружается отдельным запросом. Без ожидания последней записи
  // `scrollHeight` растёт уже после прокрутки, и кадр между прогонами съезжает.
  await expect(
    page
      .getByRole('button', { name: 'Технические детали', exact: true })
      .last(),
  ).toBeVisible();
  const body = page.locator('.editor-body');
  let height = -1;
  await expect
    .poll(async () => {
      const current = await body.evaluate((element) => element.scrollHeight);
      const stable = current === height;
      height = current;
      return stable;
    })
    .toBe(true);
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await shoot('desktop-discussion');
  await page
    .getByRole('button', { name: 'Закрыть карточку', exact: true })
    .click();
  await page.getByRole('button', { name: 'Активность', exact: true }).click();
  await expect(page.locator('.operation-row').first()).toBeVisible();
  await shoot('desktop-activity');
  // Отказ сервера виден в уже открытой ленте: русская причина, Undo недоступен.
  const state = (await (
    await page.request.get('/api/snapshot')
  ).json()) as Snapshot;
  const rejection = await page.request.post('/api/commands', {
    headers: { Origin: new URL(page.url()).origin },
    data: {
      operationId: crypto.randomUUID(),
      generation: state.generation,
      command: 'task.update',
      payload: {
        id: 'does-not-exist',
        baseRevision: 1,
        title: 'Отклонённое изменение',
      },
    },
  });
  expect(rejection.status()).toBe(404);
  const result = (await rejection.json()) as OperationError;
  const row = page.locator('.operation-row').first();
  await expect(row).toHaveAttribute('data-outcome', 'rejected');
  await expect(
    row.getByText('Операция отклонена', { exact: true }),
  ).toBeVisible();
  await expect(
    row.getByRole('button', { name: 'Отменить', exact: true }),
  ).toBeDisabled();
  await row.locator('.operation-heading').getByRole('button').first().click();
  await expect(
    row.getByText('Загружаем изменения…', { exact: true }),
  ).toBeHidden();
  await expect(row.locator('[role="alert"]')).toHaveCount(0);
  await expect(row.getByText(result.message, { exact: true })).toBeVisible();
  await shoot('desktop-activity-rejected');
  await page.getByRole('button', { name: 'Агентство', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.mouse.move(0, 0);
  await shoot('mobile-board');
  await page
    .getByRole('button', { name: 'Открыть навигацию', exact: true })
    .click();
  await page.getByRole('button', { name: /^Фокус/ }).click();
  // Кадр снимается после того, как навигация закрылась: иначе в него попадает
  // затухающая подложка диалога, и снимок отличается между прогонами.
  await expect(
    page.getByRole('dialog', { name: 'Навигация', exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole('heading', { name: 'Фокус', exact: true }),
  ).toBeVisible();
  await shoot('mobile-focus');
});
