import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { LogLevel } from './log.js';
// The built client ships next to the server: <root>/dist/web both from
// src/server and from dist/server, whatever the working directory is.
export function webDirectory(override?: string): string {
  return resolve(
    override ?? fileURLToPath(new URL('../../dist/web', import.meta.url)),
  );
}
const level = z.enum(['debug', 'info', 'warn', 'error']);
const path = z.string().min(1);
const serverSchema = z.object({
  NODE_ENV: z
    .enum(['production', 'development', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  HOST: z.string().min(1).optional(),
  BASE_URL: z.url().optional(),
  BETTER_AUTH_SECRET: z.string().min(32, 'не меньше 32 символов'),
  DATABASE_PATH: path.default('./data/dev.db'),
  BUILD: path.default('development'),
  TASKINDEX_WRITES: z.enum(['held', 'open']).default('open'),
  TASKINDEX_DEPLOYMENT: path.optional(),
  TASKINDEX_WEB_DIR: path.optional(),
  TASKINDEX_MIGRATIONS_DIR: path.optional(),
  LOG_LEVEL: level.default('info'),
});
const adminSchema = z.object({
  DATABASE_PATH: path,
  TIMEZONE: path.optional(),
  TASKINDEX_MIGRATIONS_DIR: path.optional(),
  TASKINDEX_DEPLOYMENT: path.optional(),
  LOG_LEVEL: level.default('info'),
});
export type Environment = Record<string, string | undefined>;
export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(
      `Неверная конфигурация окружения:\n${issues.map((i) => `  ${i}`).join('\n')}`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}
// Empty values count as unset: `.env` templates ship `NAME=` placeholders.
function parse<T extends z.ZodObject>(schema: T, env: Environment): z.infer<T> {
  const present: Environment = {};
  for (const key of Object.keys(schema.shape))
    if (env[key] !== undefined && env[key] !== '') present[key] = env[key];
  const result = schema.safeParse(present);
  if (result.success) return result.data;
  throw new ConfigError(
    result.error.issues.map((issue) => {
      const name = issue.path.join('.') || 'окружение';
      const detail =
        issue.code === 'invalid_value' && 'values' in issue
          ? `допустимые значения: ${(issue.values as unknown[]).map(String).join(', ')}`
          : issue.code === 'invalid_type' && issue.input === undefined
            ? 'переменная обязательна'
            : issue.message;
      return `${name}: ${detail}`;
    }),
  );
}
export type ServerConfig = {
  production: boolean;
  port: number;
  host: string;
  baseURL: string;
  secret: string;
  databasePath: string;
  build: string;
  writes: 'held' | 'open';
  deploymentId?: string;
  webDir?: string;
  migrationsDir?: string;
  logLevel: LogLevel;
};
// Dev binds to loopback; only the container (NODE_ENV=production) or an
// explicit HOST listens on all interfaces.
export function loadServerConfig(env: Environment = process.env): ServerConfig {
  const c = parse(serverSchema, env);
  const production = c.NODE_ENV === 'production';
  const port = c.PORT ?? (production ? 3000 : 3001);
  return {
    production,
    port,
    host: c.HOST ?? (production ? '0.0.0.0' : '127.0.0.1'),
    baseURL: c.BASE_URL ?? `http://localhost:${port}`,
    secret: c.BETTER_AUTH_SECRET,
    databasePath: c.DATABASE_PATH,
    build: c.BUILD,
    writes: c.TASKINDEX_WRITES,
    deploymentId: c.TASKINDEX_DEPLOYMENT,
    webDir: c.TASKINDEX_WEB_DIR,
    migrationsDir: c.TASKINDEX_MIGRATIONS_DIR,
    logLevel: c.LOG_LEVEL,
  };
}
export type AdminConfig = {
  databasePath: string;
  timezone?: string;
  migrationsDir?: string;
  deploymentId?: string;
  logLevel: LogLevel;
};
export function loadAdminConfig(env: Environment = process.env): AdminConfig {
  const c = parse(adminSchema, env);
  return {
    databasePath: c.DATABASE_PATH,
    timezone: c.TIMEZONE,
    migrationsDir: c.TASKINDEX_MIGRATIONS_DIR,
    deploymentId: c.TASKINDEX_DEPLOYMENT,
    logLevel: c.LOG_LEVEL,
  };
}
