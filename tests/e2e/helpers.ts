import {
  expect,
  type APIResponse,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { createHash } from 'node:crypto';
import type { OperationSuccess, Snapshot } from '../../src/shared/model';
// TI-070: shared fixture helpers so every spec isolates its state the same way.
export const OWNER = {
  email: 'owner@example.test',
  password: 'TaskIndex-e2e-password-2026',
} as const;
// TI-070: каждый проект Playwright работает со своей чистой базой, поэтому у
// каждой базы своя пара портов и свой файл `storageState`. Порты фиксированы
// (не «свободный порт»); 4001/4173 сохранены за основной базой ради
// совместимости.
//
// Port slots: TASKINDEX_E2E_SLOT=N shifts every fixture port (five API, five
// web, the static server) by N × PORT_SLOT_STEP, so several e2e runs can share
// one machine. CI runners on the owner's PC (winpc-taskindex-N) share one
// network stack and run with slot N; GitHub-hosted and local runs use slot 0,
// the historical ports. One slot spans 4001–4373, less than the step, so two
// slots never overlap, and the highest slot stays below 10000, where the PC's
// ephemeral port range begins.
export const PORT_SLOT_STEP = 500;
export const MAX_PORT_SLOT = 11;
export function portSlot(raw: string | undefined): number {
  const value = raw?.trim() ?? '';
  if (value === '') return 0;
  if (!/^\d+$/.test(value) || Number(value) > MAX_PORT_SLOT)
    throw new Error(
      `TASKINDEX_E2E_SLOT: ожидалось целое от 0 до ${MAX_PORT_SLOT}, получено «${raw}».`,
    );
  return Number(value);
}
const PORT_OFFSET = portSlot(process.env.TASKINDEX_E2E_SLOT) * PORT_SLOT_STEP;
export type BaseName = 'main' | 'visual' | 'dark' | 'webkit' | 'webkit-dark';
export type Base = {
  readonly name: BaseName;
  readonly api: number;
  readonly web: number;
  readonly url: string;
  readonly storageState: string;
  /** Фиксированное время сервера, если снимкам проекта нужна воспроизводимость. */
  readonly now?: string;
};
// TI-070: четыре сцены эталона показывали относительное время и различались
// между прогонами. Визуальный проект получает это время и на сервере (`now` в
// `createApp`), и в браузере (`page.clock.setFixedTime`), поэтому подписи
// «Сегодня»/«Завтра» и метки ленты больше не зависят от даты запуска. Дата
// совпадает с датой съёмки эталона и со сроками в `reference-data.json`.
export const VISUAL_NOW = '2026-09-08T09:00:00.000Z';
// `board.tsx:58`: TouchSensor activationConstraint.delay. Ожидание идёт по
// наблюдаемому состоянию, а константа задаёт только бюджет ожидания.
export const TOUCH_HOLD_MS = 220;
export const AUTH_DIR = 'test-results/e2e-auth';
function base(name: BaseName, api: number, web: number, now?: string): Base {
  return {
    name,
    api: api + PORT_OFFSET,
    web: web + PORT_OFFSET,
    url: `http://localhost:${web + PORT_OFFSET}`,
    storageState: `${AUTH_DIR}/${name}.json`,
    ...(now ? { now } : {}),
  };
}
export const BASES: readonly Base[] = [
  base('main', 4001, 4173),
  base('visual', 4002, 4174, VISUAL_NOW),
  base('dark', 4003, 4175),
  base('webkit', 4004, 4176),
  base('webkit-dark', 4005, 4177),
];
export function baseOf(name: BaseName): Base {
  return BASES.find((item) => item.name === name)!;
}
// TI-069: the `static` project's production server (`static-server.ts`).
export const STATIC_PORT = 4373 + PORT_OFFSET;
export const STATIC_URL = `http://localhost:${STATIC_PORT}`;
// TI-076: a second author in the fixture, so the activity feed has something to
// filter. The key is seeded by `server.ts` with this exact value.
export const AGENT = {
  id: 'e2e-agent',
  label: 'Помощник Э2Э',
  key: 'ti_e2e_fixture_agent_key_2026',
} as const;
export async function agentCommand(
  page: Page,
  command: string,
  payload: object,
): Promise<APIResponse> {
  const state = await snapshot(page);
  return page.request.post('/api/commands', {
    headers: {
      'x-api-key': AGENT.key,
      Origin: new URL(page.url()).origin,
    },
    data: {
      generation: state.generation,
      operationId: crypto.randomUUID(),
      command,
      payload,
    },
  });
}
// The fixture has no Nginx: each test gets its own client IP (derived from the
// stable test id) so the login rate limit is never shared between tests.
export function clientIp(testInfo: TestInfo): string {
  const hash = createHash('sha256').update(testInfo.testId).digest();
  return `10.${hash[0]}.${hash[1]}.${hash[2]}`;
}
// TI-070: проект `setup` кладёт сессию владельца в `storageState`, поэтому в
// обычном тесте формы входа уже нет. Хелпер идемпотентен: заполняет форму, если
// она открыта, и в любом случае возвращает управление на открытом пространстве.
export async function signIn(page: Page, testInfo: TestInfo, url = '/') {
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': clientIp(testInfo) });
  await page.goto(url);
  const email = page.getByRole('textbox', { name: 'Почта', exact: true });
  const heading = page.getByRole('heading', {
    name: 'Агентство',
    exact: true,
  });
  await expect
    .poll(async () =>
      (await email.count()) > 0
        ? 'form'
        : (await heading.count()) > 0
          ? 'workspace'
          : 'loading',
    )
    .not.toBe('loading');
  if ((await email.count()) > 0) {
    await email.fill(OWNER.email);
    await page
      .getByRole('textbox', { name: 'Пароль', exact: true })
      .fill(OWNER.password);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
  }
  await expect(heading).toBeVisible();
}
// Пространство уже открыто сессией из `setup`: спеке нужен только переход.
export async function openWorkspace(page: Page, url = '/') {
  await page.goto(url);
  await expect(
    page.getByRole('heading', { name: 'Агентство', exact: true }),
  ).toBeVisible();
}
export async function snapshot(page: Page): Promise<Snapshot> {
  return (await page.request.get('/api/snapshot')).json();
}
export async function postCommand(
  page: Page,
  command: string,
  payload: object,
): Promise<APIResponse> {
  const state = await snapshot(page);
  return page.request.post('/api/commands', {
    headers: { Origin: new URL(page.url()).origin },
    data: {
      generation: state.generation,
      operationId: crypto.randomUUID(),
      command,
      payload,
    },
  });
}
export async function command(
  page: Page,
  name: string,
  payload: object,
): Promise<OperationSuccess> {
  const response = await postCommand(page, name, payload);
  expect(response.ok()).toBe(true);
  return response.json();
}
// TI-070: фикстура эталона больше не принадлежит одной спеке. Визуальный и
// тёмный проекты работают каждый на своей чистой базе и наполняют её сами,
// поэтому порядок файлов внутри прогона больше ничего не значит.
export async function seedReferenceData(page: Page): Promise<void> {
  const state = await snapshot(page);
  // Идемпотентно: повторный вызов в том же пространстве ничего не создаёт,
  // поэтому спека не зависит от того, наполнил ли базу другой её тест.
  if (state.tasks.some((task) => task.id.startsWith('visual-'))) return;
  const fixture = (
    await import('./reference-data.json', { with: { type: 'json' } })
  ).default;
  const commands = [
    ...fixture.projects.map((project) => ({
      command: 'project.create',
      payload: {
        id: `visual-${project.id}`,
        area: project.area,
        name: project.name,
        color: project.color,
      },
    })),
    ...fixture.tasks.map((task) => ({
      command: 'task.create',
      payload: {
        id: `visual-${task.id}`,
        area: task.area,
        projectId: task.projectId ? `visual-${task.projectId}` : null,
        title: task.title,
        status: task.status,
        note: task.note,
        due: task.due || null,
        waitingFor: task.waitingFor,
        followUp: task.followUp || null,
        focus: 'focus' in task ? task.focus : false,
        checklist: task.checklist.map((item) => ({
          ...item,
          id: `visual-${item.id}`,
        })),
      },
    })),
    {
      command: 'task.archive',
      payload: { id: 'visual-reference-archive', baseRevision: 1 },
    },
  ];
  const response = await page.request.post('/api/commands/batch', {
    headers: { Origin: new URL(page.url()).origin },
    data: {
      generation: state.generation,
      operationId: crypto.randomUUID(),
      commands,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
}
