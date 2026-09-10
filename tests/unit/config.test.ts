import { it, expect } from 'vitest';
import {
  ConfigError,
  loadAdminConfig,
  loadServerConfig,
} from '../../src/server/config.js';
const secret = 'test-only-32-character-secret-value-never-used-outside-tests';
const failure = (env: Record<string, string | undefined>) => {
  try {
    loadServerConfig(env);
  } catch (error) {
    return error as ConfigError;
  }
  throw new Error('expected a ConfigError');
};
it('rejects a missing or short secret and unknown levels with a Russian message naming the variable', () => {
  const missing = failure({});
  expect(missing).toBeInstanceOf(ConfigError);
  expect(missing.issues).toEqual([
    'BETTER_AUTH_SECRET: переменная обязательна',
  ]);
  expect(missing.message).toContain('Неверная конфигурация окружения');
  expect(failure({ BETTER_AUTH_SECRET: 'short' }).issues).toEqual([
    'BETTER_AUTH_SECRET: не меньше 32 символов',
  ]);
  expect(
    failure({ BETTER_AUTH_SECRET: secret, LOG_LEVEL: 'verbose' }).issues,
  ).toEqual(['LOG_LEVEL: допустимые значения: debug, info, warn, error']);
  expect(
    failure({ BETTER_AUTH_SECRET: secret, PORT: '70000', BASE_URL: 'nope' })
      .issues,
  ).toHaveLength(2);
  expect(
    failure({ BETTER_AUTH_SECRET: secret, TASKINDEX_WRITES: 'closed' })
      .issues[0],
  ).toMatch(/^TASKINDEX_WRITES: /);
});
it('derives loopback defaults outside production and 0.0.0.0 inside, ignores BUILD_ID and empty values', () => {
  expect(
    loadServerConfig({ BETTER_AUTH_SECRET: secret, BUILD_ID: 'x' }),
  ).toEqual({
    production: false,
    port: 3001,
    host: '127.0.0.1',
    baseURL: 'http://localhost:3001',
    secret,
    databasePath: './data/dev.db',
    build: 'development',
    writes: 'open',
    deploymentId: undefined,
    webDir: undefined,
    migrationsDir: undefined,
    logLevel: 'info',
  });
  expect(
    loadServerConfig({ NODE_ENV: 'production', BETTER_AUTH_SECRET: secret }),
  ).toMatchObject({
    production: true,
    port: 3000,
    host: '0.0.0.0',
    baseURL: 'http://localhost:3000',
  });
  expect(
    loadServerConfig({
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: secret,
      HOST: '10.0.0.5',
      PORT: '8080',
      BASE_URL: 'https://tasks.example.test',
      TASKINDEX_WRITES: 'held',
      TASKINDEX_DEPLOYMENT: 'deploy-1',
      TASKINDEX_WEB_DIR: '/srv/web',
      TASKINDEX_MIGRATIONS_DIR: '/srv/migrations',
      LOG_LEVEL: 'debug',
      BUILD: 'abc123',
    }),
  ).toEqual({
    production: true,
    port: 8080,
    host: '10.0.0.5',
    baseURL: 'https://tasks.example.test',
    secret,
    databasePath: './data/dev.db',
    build: 'abc123',
    writes: 'held',
    deploymentId: 'deploy-1',
    webDir: '/srv/web',
    migrationsDir: '/srv/migrations',
    logLevel: 'debug',
  });
  expect(
    loadServerConfig({
      BETTER_AUTH_SECRET: secret,
      BASE_URL: '',
      PORT: '',
      HOST: '',
    }),
  ).toMatchObject({
    port: 3001,
    host: '127.0.0.1',
    baseURL: 'http://localhost:3001',
  });
});
it('requires only DATABASE_PATH for admin commands', () => {
  expect(() => loadAdminConfig({})).toThrow(ConfigError);
  expect(loadAdminConfig({ DATABASE_PATH: ':memory:' })).toEqual({
    databasePath: ':memory:',
    timezone: undefined,
    migrationsDir: undefined,
    deploymentId: undefined,
    logLevel: 'info',
  });
});
