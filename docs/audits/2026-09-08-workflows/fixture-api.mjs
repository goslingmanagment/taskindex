// Isolated audit fixture only. Uses the disposable owner from tests/e2e/server.ts.
import { randomUUID } from 'node:crypto';
const base = 'http://localhost:4173';
const login = await fetch(base + '/api/auth/sign-in/email', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: base },
  body: JSON.stringify({
    email: 'owner@example.test',
    password: 'TaskIndex-e2e-password-2026',
  }),
});
if (!login.ok) throw new Error('Fixture sign-in failed: ' + login.status);
const cookie = login.headers
  .getSetCookie()
  .map((x) => x.split(';')[0])
  .join('; ');
export async function api(path, body) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { cookie, origin: base, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}
export async function command(command, payload) {
  const state = await api('/api/snapshot');
  return api('/api/commands', {
    operationId: randomUUID(),
    generation: state.generation,
    command,
    payload,
  });
}
if (process.argv[2] === 'seed') {
  const snapshot = await api('/api/snapshot');
  const commands = [
    {
      command: 'project.create',
      payload: {
        id: 'qa-dev',
        area: 'development',
        name: 'QA Продукт',
        color: '#3465df',
      },
    },
    {
      command: 'project.create',
      payload: {
        id: 'qa-home',
        area: 'personal',
        name: 'QA Дом',
        color: '#3465df',
      },
    },
    ...[
      {
        id: 'qa-today',
        area: 'development',
        projectId: 'qa-dev',
        title: 'QA Сегодня проверить сборку',
        due: '2026-09-08',
      },
      {
        id: 'qa-later',
        area: 'development',
        projectId: 'qa-dev',
        title: 'QA Потом проверить импорт',
        due: '2026-09-15',
      },
      {
        id: 'qa-doing',
        area: 'development',
        projectId: 'qa-dev',
        title: 'QA В работе документация',
        status: 'doing',
      },
      {
        id: 'qa-done',
        area: 'development',
        projectId: 'qa-dev',
        title: 'QA Готовая задача',
        status: 'done',
      },
      {
        id: 'qa-personal',
        area: 'personal',
        projectId: 'qa-home',
        title: 'QA Проверить лампу',
        note: 'маркер поиска фотометрия',
        focus: true,
      },
      { id: 'qa-agency', area: 'agency', title: 'QA Задача без направления' },
    ].map((payload) => ({ command: 'task.create', payload })),
  ];
  console.log(
    JSON.stringify(
      await api('/api/commands/batch', {
        operationId: randomUUID(),
        generation: snapshot.generation,
        commands,
      }),
      null,
      2,
    ),
  );
}
