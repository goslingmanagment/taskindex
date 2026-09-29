import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { OWNER, STATIC_URL } from './helpers';

// TI-085: opt-in timing regression on the production bundle, in a fresh static
// fixture. Chrome/CPU x4 is a reproducible local stress profile, not a CI SLA.
// TASKINDEX_UI_PERF=1 npm run e2e -- latency.static.spec.ts --project=static
test.use({
  baseURL: STATIC_URL,
  channel: 'chrome',
  viewport: { width: 1440, height: 1000 },
  // Trace snapshots traverse the entire DOM after every Playwright call and
  // become long tasks themselves. Keep them out of a performance regression.
  trace: 'off',
});
test.skip(!process.env.TASKINDEX_UI_PERF, 'Opt-in local UI timing regression');
test.describe.configure({ mode: 'serial', timeout: 120000 });
let ownerCookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];

async function signIn(page: Page) {
  const response = await page.request.post('/api/auth/sign-in/email', {
    headers: { Origin: STATIC_URL },
    data: OWNER,
  });
  expect(response.ok()).toBe(true);
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ baseURL: STATIC_URL });
  await signIn(page);
  ownerCookies = await page.context().cookies();
  const state = await (await page.request.get('/api/snapshot')).json();
  const commands = Array.from({ length: 1500 }, (_, i) => ({
    command: 'task.create',
    payload: {
      id: `latency-${i}`,
      area: i % 10 < 6 ? 'agency' : i % 10 < 9 ? 'development' : 'personal',
      status: ['todo', 'doing', 'waiting', 'done'][Math.floor(i / 10) % 4],
      title: `Задача ${String(i).padStart(4, '0')} — Проверить материалы`,
      note: 'Проверить материалы, подготовить решение и согласовать следующий шаг. '.repeat(
        14,
      ),
      due: i % 3 === 0 ? '2030-09-14' : null,
      waitingFor: Math.floor(i / 10) % 4 === 2 ? 'Ответ исполнителя' : '',
      followUp: Math.floor(i / 10) % 4 === 2 ? '2030-09-14' : null,
      checklist: [0, 1, 2].map((item) => ({
        id: `step-${i}-${item}`,
        text: `Шаг ${item}`,
        done: item === 0,
      })),
    },
  }));
  for (let offset = 0; offset < commands.length; offset += 50) {
    const response = await page.request.post('/api/commands/batch', {
      headers: { Origin: STATIC_URL },
      data: {
        generation: state.generation,
        operationId: crypto.randomUUID(),
        commands: commands.slice(offset, offset + 50),
      },
    });
    expect(response.ok()).toBe(true);
  }
  await page.close();
});

test.beforeEach(async ({ page }) => {
  // Reuse the fixture session; timing tests do not exercise login rate limits.
  await page.context().addCookies(ownerCookies);
  await page.goto('/?area=agency&project=all&view=board');
  await expect(page.locator('[data-task-open]')).toHaveCount(900);
  await expect(page.locator('.sync-status')).toHaveAttribute(
    'data-connection',
    'online',
  );
  await page.evaluate(() => document.fonts.ready);
});

async function observe(page: Page) {
  await page.evaluate(() => {
    const durations: number[] = [];
    const entries: { start: number; duration: number }[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const event of list.getEntries()) {
        durations.push(event.duration);
        entries.push({ start: event.startTime, duration: event.duration });
      }
    });
    observer.observe({ type: 'longtask' });
    Object.assign(window, { latencyProbe: { durations, entries, observer } });
  });
}

async function longestTask(page: Page) {
  // Flush the observer after the interaction has settled, without timing the
  // Playwright locator itself or treating DOM attachment as a paint timestamp.
  await page.waitForTimeout(150);
  return page.evaluate(() => {
    const probe = (
      window as unknown as {
        latencyProbe: { durations: number[]; observer: PerformanceObserver };
      }
    ).latencyProbe;
    probe.observer.disconnect();
    return Math.max(0, ...probe.durations);
  });
}

test('TI-085 search and view changes avoid long blocking work', async ({
  page,
}, info) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  if (process.env.TASKINDEX_UI_PROFILE) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
  }
  const durations: Record<string, number> = {};
  try {
    for (const view of ['Список', 'Доска']) {
      await observe(page);
      await page
        .locator('.view-tabs [role="tab"]')
        .filter({ hasText: view })
        .click();
      await expect(
        page.locator('.view-tabs [role="tab"]').filter({ hasText: view }),
      ).toHaveAttribute('aria-selected', 'true');
      durations[view] = await longestTask(page);
    }
    const search = page.locator('.search-field');
    await search.click();
    await observe(page);
    await search.pressSequentially('0042', { delay: 35 });
    await expect(page.locator('[data-task-open]')).toHaveCount(1);
    durations.search = await longestTask(page);
    await observe(page);
    await page.locator('[aria-label="Очистить поиск"]').click();
    await expect(page.locator('[data-task-open]')).toHaveCount(900);
    durations.clear = await longestTask(page);
  } finally {
    if (process.env.TASKINDEX_UI_PROFILE) {
      const { profile } = await cdp.send('Profiler.stop');
      writeFileSync(
        info.outputPath('cpu-profile.json'),
        JSON.stringify(profile),
      );
      await info.attach('cpu-profile', {
        body: JSON.stringify(profile),
        contentType: 'application/json',
      });
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await cdp.detach();
  }
  await info.attach('blocking-ms', {
    body: JSON.stringify(durations, null, 2),
    contentType: 'application/json',
  });
  writeFileSync(
    info.outputPath('blocking.json'),
    JSON.stringify(durations, null, 2),
  );
  // The baseline has 950–1400 ms tasks. This budget leaves headroom for local
  // variance while catching the original second-long main-thread stalls.
  for (const duration of Object.values(durations))
    expect.soft(duration).toBeLessThan(400);
});

test('TI-085 drag activation stays within the blocking budget and persists', async ({
  page,
}, info) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  let duration: number;
  const phases: Record<string, number> = {};
  if (process.env.TASKINDEX_UI_PROFILE) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
  }
  try {
    const a = (await page
      .locator('[data-task-open="latency-0"]')
      .boundingBox())!;
    const b = (await page
      .locator('[data-task-open="latency-10"]')
      .boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await observe(page);
    phases.activate = await page.evaluate(() => performance.now());
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, {
      steps: 2,
    });
    await expect(page.locator('article.dragging')).toHaveCount(1);
    phases.move = await page.evaluate(() => performance.now());
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 24 });
    phases.drop = await page.evaluate(() => performance.now());
    await page.mouse.up();
    await expect
      .poll(
        async () =>
          (await (await page.request.get('/api/tasks/latency-0')).json())
            .status,
      )
      .toBe('doing');
    duration = await longestTask(page);
    writeFileSync(
      info.outputPath('drag-phases.json'),
      JSON.stringify(
        {
          phases,
          entries: await page.evaluate(
            () =>
              (window as unknown as { latencyProbe: { entries: unknown[] } })
                .latencyProbe.entries,
          ),
        },
        null,
        2,
      ),
    );
  } finally {
    if (process.env.TASKINDEX_UI_PROFILE) {
      const { profile } = await cdp.send('Profiler.stop');
      writeFileSync(
        info.outputPath('cpu-profile.json'),
        JSON.stringify(profile),
      );
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await cdp.detach();
  }
  await info.attach('blocking-ms', {
    body: JSON.stringify({ drag: duration }),
    contentType: 'application/json',
  });
  writeFileSync(
    info.outputPath('blocking.json'),
    JSON.stringify({ drag: duration }),
  );
  expect(duration).toBeLessThan(400);
});

test('TI-085 offscreen cards support keyboard movement and viewport changes', async ({
  page,
}) => {
  const card = page
    .locator('article.task-card')
    .filter({ has: page.locator('[data-task-open="latency-1485"]') });
  const previous = await (
    await page.request.get('/api/tasks/latency-1484')
  ).json();
  await card.locator('.drag-handle').focus();
  await expect(card).toBeInViewport();
  await page.keyboard.press('Space');
  await expect(page.locator('article.dragging')).toHaveCount(1);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.keyboard.press('ArrowUp');
  // Keyboard scrolling may keep the overlay at the same viewport position.
  // Wait for DnD's selected target before dropping, then check the saved order.
  await expect(
    page.getByRole('status').filter({
      hasText: 'latency-1485 was moved over droppable area latency-1484',
    }),
  ).toHaveCount(1);
  await page.keyboard.press('Space');
  await expect
    .poll(
      async () =>
        (await (await page.request.get('/api/tasks/latency-1485')).json())
          .orderKey < previous.orderKey,
    )
    .toBe(true);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const view of ['Список', 'Доска']) {
      await page
        .locator('.view-tabs [role="tab"]')
        .filter({ hasText: view })
        .click();
      await card.locator('.card-open').focus();
      await expect(card).toBeInViewport();
      await page.keyboard.press('Enter');
      await expect(page.locator('.task-sheet .editor-title')).toHaveValue(
        /1485/,
      );
      await page
        .getByRole('button', { name: 'Закрыть карточку', exact: true })
        .click();
      await expect(page.locator('.task-sheet')).toHaveCount(0);
      await expect(page.locator('[data-task-open]')).toHaveCount(900);
    }
  }
});
