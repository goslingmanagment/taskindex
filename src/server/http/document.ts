import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Env } from './deps.js';

// The security schemes and the document header. Routes describe themselves;
// this only names the API and how a caller proves who it is.
export function describeApi(api: OpenAPIHono<Env>, baseURL: string): void {
  api.openAPIRegistry.registerComponent('securitySchemes', 'bearer', {
    type: 'http',
    scheme: 'bearer',
    description: 'Ключ агента в Authorization: Bearer <ключ>',
  });
  api.openAPIRegistry.registerComponent('securitySchemes', 'apiKey', {
    type: 'apiKey',
    in: 'header',
    name: 'x-api-key',
    description: 'Ключ агента в заголовке x-api-key',
  });
  api.openAPIRegistry.registerComponent('securitySchemes', 'ownerSession', {
    type: 'apiKey',
    in: 'cookie',
    name: 'better-auth.session_token',
    description:
      'Сессия владельца после входа через /api/auth; записи требуют доверенный Origin',
  });
  api.doc('/api/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'TaskIndex',
      version: '2.0.0',
      description:
        'Задачи, проекты, комментарии и безопасные команды владельца и агентов. Документ отдаётся по тому же ключу, что и остальные чтения.',
    },
    servers: [{ url: baseURL }],
    security: [{ bearer: [] }, { apiKey: [] }, { ownerSession: [] }],
    tags: [
      { name: 'health', description: 'Состояние сервера' },
      { name: 'commands', description: 'Запись: команды и пакеты' },
      { name: 'tasks', description: 'Задачи, снимок и Focus' },
      { name: 'projects', description: 'Проекты' },
      { name: 'comments', description: 'Комментарии' },
      { name: 'operations', description: 'Журнал операций' },
      { name: 'events', description: 'События и поток' },
      { name: 'context', description: 'Справочник, сводка, экспорт' },
    ],
  });
}
