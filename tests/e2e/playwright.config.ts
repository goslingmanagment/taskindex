import { defineConfig, devices } from '@playwright/test';
import { BASES, STATIC_PORT, STATIC_URL, baseOf } from './helpers';
// TI-070: у каждого проекта своя чистая база (`tests/e2e/server.ts` берёт имя,
// порты и замороженные часы из окружения) и своя сессия владельца, записанная
// проектом `setup` в `storageState`. Ни один проект не видит записей другого,
// поэтому порядок файлов и порядок проектов больше ни на что не влияет.
//
// * `setup` — вход владельца по паролю на каждой базе;
// * `functional` — обычные спеки на базе `main` (порты 4001/4173 в слоте 0,
//   см. TASKINDEX_E2E_SLOT в `helpers.ts`);
// * `visual` — только `visual.spec.ts`: единственный проект, снимающий эталон,
//   на замороженных часах сервера и браузера;
// * `static` (TI-069) — production-сборка через `src/server/index.ts` на 4373
//   (слот 0);
// * `dark` (TI-025) — сцены с `prefers-color-scheme: dark`;
// * `webkit` и `webkit-dark` (TI-018) — `devices['Desktop Safari']`; браузер
//   ставится командой `npx playwright install webkit`.
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 7000 },
  use: {
    baseURL: baseOf('main').url,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  outputDir: '../../test-results',
  projects: [
    { name: 'setup', testMatch: /setup\.spec\.ts$/ },
    {
      name: 'functional',
      dependencies: ['setup'],
      testIgnore: /(setup|visual|static|dark|webkit)\.spec\.ts$/,
      use: { storageState: baseOf('main').storageState },
    },
    {
      name: 'visual',
      dependencies: ['setup'],
      testMatch: /visual\.spec\.ts$/,
      use: {
        baseURL: baseOf('visual').url,
        storageState: baseOf('visual').storageState,
      },
    },
    { name: 'static', testMatch: /static\.spec\.ts$/ },
    {
      name: 'dark',
      dependencies: ['setup'],
      testMatch: /dark\.spec\.ts$/,
      use: {
        colorScheme: 'dark',
        baseURL: baseOf('dark').url,
        storageState: baseOf('dark').storageState,
      },
    },
    {
      name: 'webkit',
      dependencies: ['setup'],
      testMatch: /webkit\.spec\.ts$/,
      grepInvert: /@dark/,
      use: {
        ...devices['Desktop Safari'],
        baseURL: baseOf('webkit').url,
        storageState: baseOf('webkit').storageState,
      },
    },
    // План 08, доп. шаг 17: доска, редактор и лента в тёмной теме на движке
    // WebKit. Снимки идут в `test-results`, эталон светлой темы не трогают.
    {
      name: 'webkit-dark',
      dependencies: ['setup'],
      testMatch: /webkit\.spec\.ts$/,
      grep: /@dark/,
      use: {
        ...devices['Desktop Safari'],
        colorScheme: 'dark',
        baseURL: baseOf('webkit-dark').url,
        storageState: baseOf('webkit-dark').storageState,
      },
    },
  ],
  webServer: [
    ...BASES.map((base) => ({
      cwd: process.cwd(),
      command: 'node node_modules/tsx/dist/cli.mjs tests/e2e/server.ts',
      url: base.url,
      reuseExistingServer: false,
      timeout: 90000,
      env: {
        TASKINDEX_E2E_BASE: base.name,
        TASKINDEX_E2E_API_PORT: String(base.api),
        TASKINDEX_E2E_WEB_PORT: String(base.web),
        ...(base.now ? { TASKINDEX_E2E_NOW: base.now } : {}),
      },
    })),
    {
      cwd: process.cwd(),
      command: 'node node_modules/tsx/dist/cli.mjs tests/e2e/static-server.ts',
      url: `${STATIC_URL}/health`,
      reuseExistingServer: false,
      timeout: 120000,
      env: { TASKINDEX_E2E_STATIC_PORT: String(STATIC_PORT) },
    },
  ],
});
