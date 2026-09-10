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
// The fixture has no Nginx: each test gets its own client IP (derived from the
// stable test id) so the login rate limit is never shared between tests.
export function clientIp(testInfo: TestInfo): string {
  const hash = createHash('sha256').update(testInfo.testId).digest();
  return `10.${hash[0]}.${hash[1]}.${hash[2]}`;
}
export async function signIn(page: Page, testInfo: TestInfo) {
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': clientIp(testInfo) });
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
