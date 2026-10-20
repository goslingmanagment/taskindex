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
// Один проект на одной чистой базе; порты фиксированы (4001/4173 в слоте 0).
//
// Port slots: TASKINDEX_E2E_SLOT=N shifts the fixture ports by
// N × PORT_SLOT_STEP, so several e2e runs can share one machine. CI runners on
// the owner's PC (winpc-taskindex-N) share one network stack and run with slot
// N; GitHub-hosted and local runs use slot 0. The step is 450, not 500: with
// 500, slot 2 put the web server on 5173 — Vite's default and `npm run dev`'s
// port — which a dev server in the owner's other WSL distro may hold.
export const PORT_SLOT_STEP = 450;
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
// `board.tsx:58`: TouchSensor activationConstraint.delay. Ожидание идёт по
// наблюдаемому состоянию, а константа задаёт только бюджет ожидания.
export const TOUCH_HOLD_MS = 220;
export const AUTH_DIR = 'test-results/e2e-auth';
export const BASE = {
  name: 'main',
  api: 4001 + PORT_OFFSET,
  web: 4173 + PORT_OFFSET,
  url: `http://localhost:${4173 + PORT_OFFSET}`,
  storageState: `${AUTH_DIR}/main.json`,
} as const;
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
