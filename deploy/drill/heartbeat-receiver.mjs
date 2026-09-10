// @ts-check
// Локальный приёмник heartbeat Litestream для `deploy/local-drill.sh --heartbeat` (TI-002).
// Каждый запрос на /ping дописывает строку «<ISO-время> <метод>» в журнал и отвечает 204.
// Только для drill: в production получатель — healthchecks.io (см. deploy/README.md).
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';

const port = Number(process.env.HEARTBEAT_PORT ?? '8787');
const log = process.env.HEARTBEAT_LOG ?? '/tmp/heartbeat.log';
mkdirSync(dirname(log), { recursive: true });

const server = createServer((request, response) => {
  const path = (request.url ?? '/').split('?')[0];
  if (path !== '/ping') {
    response.writeHead(404).end();
    return;
  }
  appendFileSync(
    log,
    `${new Date().toISOString()} ${request.method ?? 'GET'}\n`,
  );
  response.writeHead(204).end();
});
server.listen(port, '0.0.0.0', () => {
  console.log(
    JSON.stringify({ ok: true, stage: 'heartbeat-receiver', port, log }),
  );
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
