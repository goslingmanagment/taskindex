import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import type { Task } from '../../src/shared/model';
import { command, openWorkspace } from './helpers';
// TI-078, TI-029 (план 13, шаги 8–9): вид «Стол» на экране Focus. Спека идёт в
// проекте `functional` на базе `main`; задачи создаёт сама через `/api/commands`,
// поэтому не зависит от порядка спек. Снимки desktop и mobile складываются в
// `test-results/e2e-desk` — для просмотра глазами, не в эталон.
const ARTIFACTS = 'test-results/e2e-desk';
test.beforeAll(() => mkdirSync(ARTIFACTS, { recursive: true }));
const shoot = (page: Page, name: string) =>
  page.screenshot({
    path: `${ARTIFACTS}/${name}.png`,
    animations: 'disabled',
    fullPage: true,
  });
type Seed = {
  id: string;
  title: string;
  focus?: boolean;
  status?: Task['status'];
  steps?: string[];
  waitingFor?: string;
  followUp?: string;
};
async function seed(page: Page, tasks: Seed[]) {
  for (const task of tasks)
    await command(page, 'task.create', {
      id: task.id,
      area: 'agency',
      title: task.title,
      status: task.status ?? 'todo',
      focus: task.focus ?? false,
      ...(task.waitingFor ? { waitingFor: task.waitingFor } : {}),
      ...(task.followUp ? { followUp: task.followUp } : {}),
      checklist: (task.steps ?? []).map((text, index) => ({
        id: `${task.id}-step-${index + 1}`,
        text,
        done: false,
      })),
    });
}
const read = async (page: Page, id: string): Promise<Task> =>
  (await page.request.get(`/api/tasks/${id}`)).json();
const current = (page: Page) =>
  page.getByRole('region', { name: 'Текущая задача', exact: true });
const later = (page: Page) => page.locator('.desk-next');

test('the desk shows one current task, takes the next one, marks steps and opens the contexts drawer', async ({
  page,
}) => {
  await openWorkspace(page);
  const yesterday = new Date(Date.now() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  await seed(page, [
    { id: 'e2e-desk-a', title: 'Стол: первая', focus: true },
    {
      id: 'e2e-desk-b',
      title: 'Стол: вторая',
      focus: true,
      steps: ['Собрать вводные', 'Написать черновик'],
    },
    { id: 'e2e-desk-c', title: 'Стол: третья', focus: true },
    {
      id: 'e2e-desk-w',
      title: 'Стол: жду макет',
      status: 'waiting',
      waitingFor: 'Дизайнер',
      followUp: yesterday,
    },
    { id: 'e2e-desk-p', title: 'Стол: отложенная' },
  ]);
  await page.getByRole('button', { name: /^Фокус/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Фокус', exact: true }),
  ).toBeVisible();
  // TI-029: the sidebar badge is the desk size, the same number `/api/focus`
  // reports, not «new from agents».
  const desk = (await (await page.request.get('/api/focus')).json()) as {
    counts: { focus: number };
  };
  expect(desk.counts.focus).toBeGreaterThanOrEqual(3);
  await expect(page.locator('.workspace-sidebar .focus-count')).toHaveText(
    String(desk.counts.focus),
  );
  // The first task taken into focus is the current one; the other two wait
  // in «Потом»; legacy waiting records remain available in the contexts drawer.
  await expect(
    current(page).getByRole('heading', { name: 'Стол: первая', exact: true }),
  ).toBeVisible();
  await expect(later(page).getByRole('button')).toHaveCount(2);
  await expect(page.locator('#desk-waiting')).toHaveCount(0);
  await page.mouse.move(0, 0);
  await shoot(page, 'desktop-desk');
  // Taking a task from «Потом» moves it to the head of the desk.
  await page
    .getByRole('button', { name: 'Взять в фокус: Стол: вторая', exact: true })
    .click();
  await expect(
    current(page).getByRole('heading', { name: 'Стол: вторая', exact: true }),
  ).toBeVisible();
  await expect(
    later(page).getByRole('button', {
      name: 'Взять в фокус: Стол: первая',
      exact: true,
    }),
  ).toBeVisible();
  // Space marks the first open step through `checklist.update`, not a full save.
  await expect(current(page).getByText('Шаги 0 из 2')).toBeVisible();
  await current(page).locator('.desk-eyebrow').click();
  await page.keyboard.press('Space');
  await expect(current(page).getByText('Шаги 1 из 2')).toBeVisible();
  await expect
    .poll(async () => (await read(page, 'e2e-desk-b')).checklist[0]?.done)
    .toBe(true);
  expect((await read(page, 'e2e-desk-b')).checklist[1]?.done).toBe(false);
  // «Отложенные контексты» opens the drawer with its filter in the URL.
  await page.getByRole('button', { name: /^Отложенные контексты/ }).click();
  const drawer = page.getByRole('dialog', {
    name: 'Все контексты',
    exact: true,
  });
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(/contexts=1/);
  await expect(page).toHaveURL(/status=todo/);
  await expect(page).toHaveURL(/parked=1/);
  await expect(
    drawer.getByRole('button', { name: /Стол: отложенная/ }),
  ).toBeVisible();
  await expect(
    drawer.getByRole('button', { name: /Стол: жду макет/ }),
  ).toBeVisible();
  await expect(
    drawer.getByRole('button', { name: /Стол: первая/ }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(page).not.toHaveURL(/contexts=1/);
  // Completing the current task drops it from the desk; the next one steps up.
  await page
    .getByRole('button', { name: 'Задача готова', exact: true })
    .click();
  await expect(
    current(page).getByRole('heading', { name: 'Стол: первая', exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await read(page, 'e2e-desk-b')).status)
    .toBe('done');
  expect((await read(page, 'e2e-desk-b')).focus).toBe(false);
  // N takes the first task of «Потом».
  await current(page).locator('.desk-eyebrow').click();
  await page.keyboard.press('n');
  await expect(
    current(page).getByRole('heading', { name: 'Стол: третья', exact: true }),
  ).toBeVisible();
  await expect(
    later(page).getByRole('button', {
      name: 'Взять в фокус: Стол: первая',
      exact: true,
    }),
  ).toBeVisible();
  // Mobile: one column, the rail goes below the current task.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('heading', { name: 'Фокус', exact: true }),
  ).toBeVisible();
  const columns = await page
    .locator('.desk-workbench')
    .evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(columns.trim().split(/\s+/)).toHaveLength(1);
  await page.mouse.move(0, 0);
  await shoot(page, 'mobile-desk');
});
