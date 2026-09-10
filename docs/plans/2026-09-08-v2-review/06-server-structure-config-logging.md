# Структура сервера, конфигурация и логирование

Статус: предложение, 2026-09-08. Источник: сводное ревью v2 (см. `README.md` в этой папке).
Приоритет: P0 для шагов 1..5 (логирование ошибок, версия схемы, bind dev-сервера, пути, `/health`: все S и нужны до переключения), P1 для шагов 6..12 (разрез `app.ts` и `admin.ts`, хелперы транзакций). Оценка: M..L, 2..3 дня (шаги 1..7 около 1 дня, 8..12 около 1.5 дня). Зависимости: нет входящих; на этот план опираются `01-performance-history-and-pagination.md` (модули `http/pagination.ts`, `sse.ts`), `05-auth-and-agent-keys.md` (`http/auth-middleware.ts`, версия схемы без константы), `04-api-contract-and-schemas.md` (код ошибки `internal`, `issues` в ответах валидации), `10-code-quality-and-tests.md` (правило `max-lines` как страховка разреза), `11-deploy-and-ops.md` (allowlist `/health` в nginx, `HOST` в compose).

## 1. Проблема

Все ссылки проверены по текущему дереву 2026-09-08; номера строк отчётов совпали.

### 1.1. `app.ts` как god-module (V2, R3, B5)

`src/server/app.ts` 1072 строки, из них `createApp` `:175-1071` (897 строк). Внутри одного замыкания:

| Строки | Что |
|---|---|
| 75..174 | `json()`, `pageQuery`, `readErrors`, `cursorSchema`, `focusGroupSchema`, `contextSchema`, `digestSchema` |
| 178..180 | пробная запись в `settings` при старте |
| 183..185 | хабы SSE: `subscribers`, `operationSubscribers`, `closers` (замыкания, тестируемые только через HTTP) |
| 196..244 | движок курсоров `page()` |
| 245..258 | `defaultHook` (ошибка валидации Zod) |
| 259..295 | `onError` |
| 296..339 | middleware: авторизация, Origin, gate `held`, лог запроса в одном `try/finally` |
| 340..371 | `bodyLimit` для команд и пакетов |
| 372..387 | монтирование Better Auth |
| 389..751 | 14 маршрутов чтения и команд |
| 752..866 | SSE-стрим |
| 867..937 | сборка `context` |
| 938..1011 | сборка `digest` |
| 1012..1055 | `focus` |
| 1056..1070 | OpenAPI-документ, `Object.assign(completeApi, { closeStreams })` |

Обработчики `POST /api/commands` (`:469-482`) и `POST /api/commands/batch` (`:496-509`) идентичны, кроме `commandName`. Тип `AppType = ReturnType<typeof createApp>` (`:1072`) используется CLI для `hc<AppType>` (`src/cli/client.ts:3, 49, 64`, вызовы `rpc.api.commands.$post` и `rpc.api.commands.batch.$post` `:94-102`), поэтому разрез должен сохранять цепочку типов.

`src/server/admin.ts` (481 строка): владелец и пароль `:34-104`, агенты и ключи `:105-206`, экспорт/проверка/импорт `:207-449` (в том числе вторая копия `canonical()` `:231-238`, первая в `operations.ts:27-34`), `mark-restored`/gate записи `:450-481`, реэкспорты `migrate`/`createAuth` `:25-26` как фасад для `src/cli/admin-run.ts:5` (`import * as admin`). Потребители: `app.ts:58` (`exportWorkspace`, `writesAreOpen`), тесты `tests/api/auth.test.ts:10-18`, `tests/api/recovery-and-history.test.ts:3-7`, `tests/cli/agent-cycle.test.ts:9-13`, `tests/e2e/server.ts:8`.

### 1.2. Конфигурация без схемы (quality §7, Ж6, B6)

- Переменные окружения читаются ad hoc: `src/server/index.ts:6-25` (8 переменных, в том числе `BUILD ?? BUILD_ID` `:22`; `BUILD_ID` не задаёт ни `deploy/compose.yml:16`, ни `deploy/Dockerfile:13`), `src/cli/admin-run.ts:85, 94-96, 136-137, 204` (6), `scripts/dev.mjs:11-13` (3).
- `LOG_LEVEL` объявлен в `deploy/compose.yml:15`, `deploy/.env.example:7` и плане §12 (`docs/plans/2026-09-08-taskindex-v2.md:755`), в `src/` не читается (grep пуст).
- `TIMEZONE` передаётся в контейнер приложения (`compose.yml:14`, `.env.example:6`, `scripts/setup-dev.mjs:15`), но приложение читает пояс только из `settings.timezone` (`app.ts:187`); переменную использует лишь `taskindex-admin migrate` (`admin-run.ts:94` → `db.ts:91-92`), и только при первой инициализации, когда настройки ещё нет. План §12 подаёт её как переменную приложения.
- Проверка `BETTER_AUTH_SECRET` только на наличие (`index.ts:10-11`).

### 1.3. Логирование внутренних ошибок (V4)

- `app.ts:285` `console.error(JSON.stringify({ code: 'internal', error: error.name }))`: ни сообщения, ни стека, ни `requestId`. В `docker logs` детерминированный баг (исключение не-`DomainError` из `applyCommand`, `writeState`, сериализации) выглядит как `{"code":"internal","error":"TypeError"}`.
- `:286-294` любая неизвестная ошибка отвечает `503 unavailable, retryable: true`. Store повторяет до 4 раз с паузой (`src/web/app/store.ts:345-363`) и оставляет конверт в localStorage; CLI повторяет 4 раза (`src/cli/client.ts:132-137`) и оставляет конверт в outbox навсегда, потому что исход «повторяемый».
- Лог запросов `:327-337` пишется только для `/api/commands*`; `requestId` берётся из заголовка или генерируется (`:330`), но клиенту не возвращается, поэтому сопоставить ошибку агента с строкой лога нельзя.
- `errorCodeSchema` (`src/shared/domain-schemas.ts`, перечисление `invalid … unavailable`) не содержит кода для внутренней ошибки; `DomainError.retryable` = `code === 'unavailable'` (`src/shared/errors.ts:32`).

### 1.4. Версия схемы как ручная константа (V6, B4)

- `src/shared/model.ts:86` `SCHEMA_VERSION = 1`. Мигратор `src/server/db.ts:46-96` применяет все `*.sql` из каталога и затем пишет `schema_version = SCHEMA_VERSION` (`:93`); `assertSchema` (`:98-104`) сравнивает настройку с константой; `:61-68` отказывает старому мигратору на более новой схеме тоже по константе. `/health` отдаёт `schemaVersion: SCHEMA_VERSION` (`app.ts:419`), `admin initialize` тоже (`admin.ts:32`), импорт сверяет `settings.schema_version` с константой (`admin.ts:371`).
- Журнал Drizzle `drizzle/v2/meta/_journal.json` содержит одну запись (`tag: 0000_taskindex`); тест `tests/api/migrations.test.ts:57-61` сверяет `__taskindex_migrations` с журналом, `:11-25` снапшот со `schema.ts`, но ничто не связывает `SCHEMA_VERSION` с числом миграций. Новый `0001_*.sql` без поднятой константы пройдёт `assertSchema` на любом образе (ровно то, что план §12 обещает исключить, `2026-09-08-taskindex-v2.md:759-764`). README требует поднимать константу словами (`README.md:66`).
- Деплой сравнивает `/health.schemaVersion` с выводом `taskindex-admin migrate` (`deploy/common.sh:34`, `deploy/deploy.sh:81-84`): оба значения должны идти из одного места.

### 1.5. `/health` (B-10, V7)

- `app.ts:389-426`: без авторизации отдаёт `ok, generation, seq, dbWritable, schemaVersion, build, writes`. Nginx `deploy/nginx/taskindex.conf:37` проксирует `location /` целиком, то есть `/health` доступен из интернета: коммит (`build`), поколение базы и счётчик событий. Потребители внутри периметра: `deploy/common.sh:34` (`ok, dbWritable, writes, build, schemaVersion`), `deploy/deploy.sh:34-36` (`ok, writes, build`), `deploy/local-drill.sh:37, 91`, `compose.yml:32` (`ok`), `vite.config.ts:23` (прокси в dev), `tests/api/auth.test.ts:191`. Поля `generation` и `seq` никто из скриптов не читает (`deploy/database.mjs inspect` берёт их из базы напрямую).
- Пробная запись `UPDATE settings SET value=value WHERE key='generation'` (`:410-412`, а также при старте `:178-180`) выглядит как запись в базу каждые 10 с (`compose.yml:34`). Замерено дважды (ревью 1 §e; ревью 3, `scratchpad/repro/health-write2.mts`: после 20 вызовов `/health` WAL не растёт, `PRAGMA data_version` соседнего соединения не меняется): SQLite не фиксирует транзакцию без изменённых страниц, при этом `SQLITE_READONLY` всё равно сработал бы. Проба корректна, но ни строчки комментария рядом нет, и `dbWritable: true` захардкожен (`:418`).

### 1.6. Bind и пути (B-12, S5)

- `src/server/index.ts:39` `hostname: '0.0.0.0'` и в dev, и в prod. `npm run dev` в общей сети открывает API с `data/dev.db` и cookie-сессиями по HTTP на `http://<LAN-IP>:3001`; Vite проксирует на `127.0.0.1:3001` (`vite.config.ts:22-23`), так что dev-серверу внешний интерфейс не нужен. Контейнеру `0.0.0.0` нужен (`compose.yml:21` публикует порт на `127.0.0.1:3100`). e2e-фикстура сама слушает `localhost` (`tests/e2e/server.ts:32`).
- `src/server/db.ts:52` `resolve(options.migrationsDir ?? 'drizzle/v2')` и `src/server/index.ts:37-38` `./dist/web` зависят от cwd. Работает благодаря `WORKDIR /app` (`Dockerfile:14`) и запуску из корня; `taskindex-admin migrate` из другого каталога упадёт (обход: `TASKINDEX_MIGRATIONS_DIR`, `admin-run.ts:95-96`). `serveStatic` из `@hono/node-server` соединяет `root` с путём через `join` (`node_modules/@hono/node-server/dist/serve-static.cjs:86`) и предупреждает в консоль, если `root` не существует (`:74`), поэтому абсолютный путь допустим.

### 1.7. Транзакции и инлайн-ошибки (quality §3, §5, §7)

- `db.sqlite.transaction(fn).immediate()` в шести местах (`operations.ts:52/198`, `admin.ts:42/69, 78/103, 377/448, 454/461`, `db.ts:51/95`) и три транзакции чтения без `.immediate()` (`app.ts:443-453` snapshot, `:956-1007` digest, `admin.ts:208-229` export). Хелпера нет, `.immediate()` легко забыть.
- Литералы `{ ok: false, code, message, retryable }` мимо `DomainError.toJSON()` (`errors.ts:27-35`): на сервере 8 из 13 по ревью качества: `app.ts:248-256` (валидация параметров), `:263-271` (`ZodError`), `:276-284` (`SQLITE_BUSY/READONLY`), `:286-294` (неизвестная ошибка), `:344-353` и `:361-370` (`bodyLimit`), `:378-386` (auth не настроен), `index.ts:27-35` (404 для `/api/*`). Остальные 5 в web и CLI (`src/web/app/api.ts:30-35, 41-49`; `src/cli/client.ts:110-117, 194-205`; `src/cli/run.ts:345-352`) относятся к планам 07 и 03.

## 2. Цель и критерии приёмки

1. Ни один файл в `src/server` не длиннее 400 строк (`wc -l`), `createApp` только собирает приложение из модулей; `tsc` зелёный, в том числе `src/cli/client.ts` с `hc<AppType>` без правок в CLI.
2. Неизвестная ошибка обработчика отвечает `500 { ok: false, code: 'internal', retryable: false }` и пишет в stderr одну JSON-строку с `level: 'error'`, `requestId`, `method`, `path`, `actor`, `message`, `stack` (без тела запроса). Ошибки SQLite `BUSY`, `READONLY`, `IOERR`, `FULL`, `CANTOPEN` по-прежнему `503 unavailable retryable: true`.
3. Каждый ответ `/api/*` несёт заголовок `x-request-id` (входящий, если был, иначе сгенерированный); строка лога команды содержит тот же `requestId`.
4. `LOG_LEVEL` из `debug | info | warn | error` (по умолчанию `info`) фильтрует вывод: `debug` добавляет строку на каждый запрос `/api/*`, `warn` убирает строки успешных команд. Неверное значение останавливает запуск с понятным сообщением.
5. Версия схемы вычисляется из набора миграций в образе; константа `SCHEMA_VERSION` удалена; `migrate`, `assertSchema`, `/health`, `admin initialize`, `import` используют одну функцию; новый `.sql` без правки кода автоматически меняет версию, а несовпадение имён применённых миграций с набором образа даёт `unavailable` при старте (тесты).
6. `npm run dev` слушает `127.0.0.1:3001`; в контейнере (`NODE_ENV=production`) `0.0.0.0`; `HOST` переопределяет.
7. `taskindex-admin migrate` и запуск сервера работают из любого cwd (тест меняет `process.cwd()`).
8. `/health` тело не меняется; рядом с пробной записью комментарий с ссылкой на замер; `dbWritable` вычисляется из результата пробы.
9. Все `db.sqlite.transaction` в `src/server` идут через `withWrite`/`withRead`; в серверном коде нет литералов `ok: false` вне `DomainError.toJSON()` (grep в тесте).
10. `npm run check` и `npm run e2e` зелёные; `bash deploy/local-drill.sh` проходит (проверяет `schemaVersion` и `build` через `/health`).

## 3. Решение

Разрез по ответственности, не по размеру: HTTP-инфраструктура (`http/*`), маршруты (`routes/*`), чистые сборщики (`context.ts`, `digest.ts`), хаб SSE (`sse.ts`), конфигурация (`config.ts`), логгер (`log.ts`). `createApp(options)` собирает зависимости в объект `Deps` и передаёт его модулям.

Сохранение типа для `hc`: каждый модуль маршрутов экспортирует обобщённую функцию, которая принимает текущее приложение и возвращает его же с добавленными `.openapi(...)`, например `export const registerCommandRoutes = <T extends OpenAPIHono<Env>>(app: T, deps: Deps) => app.openapi(...).openapi(...)`. `createApp` вызывает их цепочкой, `export type AppType = ReturnType<typeof createApp>` остаётся как есть, компилятор сам проверит `client.ts:94-102`. Альтернатива через `app.route('/', sub)` отклонена: у `OpenAPIHono` `defaultHook` задаётся на экземпляр, его пришлось бы дублировать в каждом под-приложении, а `onError` под-приложений имеет свои правила наследования; обобщённые функции держат один экземпляр и один `defaultHook`.

Логирование: маленький `log.ts` (около 30 строк) вместо зависимости (`pino` и подобные не окупаются при одном процессе и одном потребителе `docker logs`). Формат: одна JSON-строка на событие, `level`, `time`, поля события. Решение по `LOG_LEVEL`: реализовать, а не удалять: переменная уже в контракте деплоя (compose, `.env.example`, план §12), а уровень `debug` с построчным логом всех запросов нужен для разбора проблем агентов (ревью 5). Удаление тоже возможно (три файла и план), но даёт меньше.

Внутренние ошибки: новый код `internal` (500, `retryable: false`). Клиенты уже правильно обрабатывают неповторяемый исход: store удаляет конверт и пробрасывает ошибку (`store.ts:355-359`), CLI считает исход окончательным и удаляет конверт (`client.ts:145-147`). Это лучше вечного повтора; агент получает `operationId` и решает сам. Контракт (перечисление кодов, OpenAPI, SKILL) фиксирует план 04.

Версия схемы: `schemaVersion = число *.sql в каталоге миграций образа`, дополнительно `assertSchema` сверяет имена в `__taskindex_migrations` с набором образа (сейчас проверяется только «нет неизвестных», `db.ts:75-76`; добавляется «нет пропущенных»). Это убирает константу, которую можно забыть, и делает `/health.schemaVersion` и вывод `migrate` производными одного списка. Отвергнуто «`SCHEMA_VERSION === journal.entries.length` только тестом»: константа остаётся, а рантайм-мигратор журнал Drizzle не читает.

`/health`: тело не сокращать. Скрипты деплоя опираются на текущие поля, а ограничение доступа извне это задача nginx (`11-…md`: `location = /health { allow 127.0.0.1; allow ::1; deny all; }`); дублировать allowlist в приложении нет смысла, у Node-порта нет внешнего интерфейса (`compose.yml:21`). Пробная запись остаётся: она дёшева (без изменённых страниц нет коммита, замер в §1.5) и единственная проверка `SQLITE_READONLY` до открытия записи.

## 4. Шаги

Шаги 1..5 самостоятельны и могут идти отдельными коммитами. Шаги 8..11 делать в одном worktree подряд, каждый шаг заканчивать `npm run check`.

1. `src/server/config.ts`:
   ```ts
   const schema = z.object({
     NODE_ENV: z.enum(['production', 'development', 'test']).default('development'),
     PORT: z.coerce.number().int().min(1).max(65535).optional(),
     HOST: z.string().min(1).optional(),
     BASE_URL: z.url().optional(),
     BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET: не меньше 32 символов'),
     DATABASE_PATH: z.string().min(1).default('./data/dev.db'),
     BUILD: z.string().min(1).default('development'),
     TASKINDEX_WRITES: z.enum(['held', 'open']).default('open'),
     TASKINDEX_DEPLOYMENT: z.string().min(1).optional(),
     LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
   });
   export function loadServerConfig(env = process.env) { /* parse → { production, port, host, baseURL, secret, databasePath, build, writes, deploymentId, logLevel } */ }
   export function loadAdminConfig(env = process.env) { /* DATABASE_PATH обязателен, TIMEZONE, TASKINDEX_MIGRATIONS_DIR, TASKINDEX_DEPLOYMENT, BASE_URL, BETTER_AUTH_SECRET по требованию команды */ }
   ```
   Производные: `port = PORT ?? (production ? 3000 : 3001)`, `host = HOST ?? (production ? '0.0.0.0' : '127.0.0.1')`, `baseURL = BASE_URL ?? http://localhost:${port}`. `BUILD_ID` убрать (производителя нет). Ошибка разбора печатает `issues` по-русски и завершает процесс кодом 1 до открытия базы. `src/server/index.ts:6-25` и `src/cli/admin-run.ts:85-97, 136-137, 204` переходят на эти функции. Проверка `min(32)` для секрета: `scripts/setup-dev.mjs:16` генерирует 64 hex-символа, тестовые секреты не короче 32 (`tests/api/auth.test.ts:31`, `tests/e2e/server.ts:22`). Проверка: `npm run dev`, `npm run admin -- migrate`, тесты `tests/cli/admin.test.ts`.

2. `src/server/log.ts` и обработка ошибок:
   - `createLogger(level)` → `{ debug, info, warn, error }`, каждый принимает объект и пишет `JSON.stringify({ level, time, ...fields })` в stdout (`debug`/`info`) или stderr (`warn`/`error`); ниже порога ничего не пишет. Экземпляр создаётся в `index.ts` из конфига и передаётся в `createApp` через `AppOptions.logger` (по умолчанию `createLogger('info')`, в тестах можно передать сборщик записей).
   - `src/shared/errors.ts:15-25`: добавить `internal: 500`; `retryable` остаётся `code === 'unavailable'`. `src/shared/domain-schemas.ts` `errorCodeSchema`: добавить `'internal'` (согласовать с `04-…md`).
   - `onError` (`app.ts:259-295` → `http/errors.ts` на шаге 8): `DomainError` как сейчас; `ZodError` → `new DomainError('invalid', 'Проверьте поля запроса.')`; ошибки с `code`, начинающимся на `SQLITE_BUSY`, `SQLITE_READONLY`, `SQLITE_IOERR`, `SQLITE_FULL`, `SQLITE_CANTOPEN` → `unavailable`; всё остальное → `logger.error({ event: 'internal_error', requestId, method, path, actor, message, stack })` и `new DomainError('internal', 'Внутренняя ошибка сервера. Операция не выполнена.')`. Тело запроса и заголовки в лог не попадают.
   - `x-request-id`: в начале middleware `/api/*` (`app.ts:297`) `const requestId = c.req.header('x-request-id') ?? randomUUID(); c.set('requestId', requestId); c.header('x-request-id', requestId)`; лог команды (`:327-337`) использует `c.get('requestId')`. При `LOG_LEVEL=debug` строка `{ event: 'request', requestId, method, path, actor, code, durationMs }` пишется для каждого `/api/*`; при `info` только для `/api/commands*` (как сейчас); при `warn` только отказы (`code >= 400`).
   Проверка: тесты раздела 5, п. 2..4.

3. Версия схемы из набора миграций. `src/server/db.ts`:
   - `export function migrationsDirectory(override?: string)` → `override ?? fileURLToPath(new URL('../../drizzle/v2/', import.meta.url))` (из `src/server/` и из `dist/server/`, `dist/cli/` это `<корень>/drizzle/v2`; в образе `/app/drizzle/v2`, `Dockerfile:20`); `export function bundledMigrations(dir)` → отсортированные имена `*.sql`; `export function schemaVersion(dir?)` → `bundledMigrations(dir).length`.
   - `migrate` (`:46-96`): `SCHEMA_VERSION` → `schemaVersion(dir)`; проверка `:61-68` сравнивает `settings.schema_version` с этим числом.
   - `assertSchema` (`:98-104`): кроме числа, сверять множество имён `__taskindex_migrations` с `bundledMigrations(dir)`: любое расхождение → `fail('unavailable', 'Схема базы не соответствует образу. Запустите миграции подходящим образом.')`.
   - Убрать `SCHEMA_VERSION` из `src/shared/model.ts:86`; `app.ts:419` → `schemaVersion()`, `admin.ts:32`, `:371` → `schemaVersion()`. README `:66`: вместо «повышается `SCHEMA_VERSION`» написать «версия схемы равна числу миграций в `drizzle/v2`».
   Проверка: `tests/api/migrations.test.ts` плюс новые проверки (раздел 5, п. 5); `/health.schemaVersion` в drill равен выводу `migrate`.

4. Bind и пути. `index.ts:39` `hostname: config.host`; `index.ts:37-38` `serveStatic({ root: webRoot })` и `serveStatic({ path: join(webRoot, 'index.html') })`, где `webRoot = process.env.TASKINDEX_WEB_DIR ?? fileURLToPath(new URL('../../dist/web/', import.meta.url))` (из `src/server` и `dist/server` это `<корень>/dist/web`). `db.ts:52` → `migrationsDirectory(options.migrationsDir)`; `TASKINDEX_MIGRATIONS_DIR` (`admin-run.ts:95-96`) остаётся переопределением для тестов и drill. `deploy/README.md`: отметить, что `taskindex-admin` работает из любого каталога. Проверка: тест раздела 5, п. 6; `npm run build && npm start` из каталога вне корня.

5. `/health` (`app.ts:389-426`): над пробной записью комментарий:
   ```ts
   // Write probe. UPDATE without changed pages produces no commit and no WAL
   // frames (measured 2026-09-08: WAL size and PRAGMA data_version unchanged
   // after 20 calls), but still raises SQLITE_READONLY on a read-only file.
   ```
   `dbWritable` вычислять: `try { probe(); dbWritable = true } catch (e) { if (SQLITE_READONLY) dbWritable = false; else throw e }` и отвечать 503 `unavailable` при `false` (сейчас исключение и так уходит в `onError`; явная ветка делает `dbWritable: false` достижимым и документированным). Тело без изменений; решение о доступе извне записать в `11-…md` (nginx allowlist). Проверка: `tests/api/auth.test.ts:188-192`, drill.

6. `src/server/db.ts`: `export const withWrite = <T>(db, fn: () => T): T => db.sqlite.transaction(fn).immediate()` и `withRead = <T>(db, fn: () => T): T => db.sqlite.transaction(fn)()`. Заменить девять мест из §1.7. Проверка: тесты `durability`, `commands`, `recovery-and-history`.

7. Инлайн-литералы на сервере → `DomainError`: `app.ts:248-256` и `:263-271` → `c.json(new DomainError('invalid', …).toJSON(), 400)`; `:344-353`, `:361-370` → `DomainError('invalid', 'Слишком большой запрос.')` / `'Слишком большой пакет.'`; `:378-386` → `DomainError('unauthorized', 'Авторизация не настроена.')`; `index.ts:27-35` → `DomainError('not_found', 'Метод API не найден.')`; `:276-294` покрыты шагом 2. Поле `issues` для ошибок валидации (A8) добавляет план 04 через `details`. Проверка: тест раздела 5, п. 9 (grep).

8. Выделить HTTP-инфраструктуру: `src/server/http/errors.ts` (`onError`, `defaultHook`, `bodyLimitError(message)`), `src/server/http/auth-middleware.ts` (`app.ts:296-322`: авторизация, Origin, gate `held`, запрет `/api/auth/api-key/*` из плана 05), `src/server/http/request-log.ts` (`:323-338` плюс `requestId`), `src/server/http/pagination.ts` (`page()`, `cursorSchema`, `checkGeneration`; план 01 заменит содержимое на keyset, интерфейс `page(items, query, identity)` сохраняется до этого). `Env.Variables` расширить `requestId: string`. `createApp` подключает их в том же порядке, что сейчас (`use('/api/*')`, затем `bodyLimit`, затем монтирование auth).

9. Выделить `src/server/sse.ts`: `createEventHub()` → `{ publish(events: DomainEvent[]), notifyOperations(), subscribe(onEvents, onOperations): () => void, closeAll() }` (замена `subscribers`, `operationSubscribers`, `closers` `app.ts:183-185`); `createStreamResponse(deps, request)` содержит тело `app.ts:772-865`. `src/server/context.ts`: `buildContext(deps): Context` (`:873-936`) и `contextSchema`; `src/server/digest.ts`: `buildDigest(deps, since)` (`:955-1007`) и `digestSchema`; `focusGroupSchema` рядом с `digest.ts` или в `src/shared/domain-schemas.ts` (перенос без изменения формы; решение о потреблении схем клиентом в `04-…md`). Хаб тестируется без HTTP (раздел 5, п. 10).

10. Маршруты: `src/server/routes/{health,commands,reads,history,operations,stream,context,digest,focus}.ts`, каждый экспортирует `register…Routes<T extends OpenAPIHono<Env>>(app: T, deps: Deps)`. В `routes/commands.ts` один `runOperation(c, input, commandName)` для `/api/commands` и `/api/commands/batch` (`app.ts:469-482`, `:496-509`): `c.set('operationId')`, `c.set('commandName')`, `executeOperation`, `hub.publish` при `freshEvents`, `hub.notifyOperations()` при `freshOperation`, `c.json(result.body, result.status)`. `Deps = { db, options, logger, hub, now, timezone, opened, checkGeneration, page }`. `createApp` (`app.ts`, целевой размер до 150 строк): конфиг по умолчанию, `assertSchema`, пробная запись, хаб, `OpenAPIHono` с `defaultHook`, middleware, цепочка `register…`, `.doc(...)`, возврат `Object.assign(api, { closeStreams: hub.closeAll })`. `AppType` без изменений по имени. Проверка: `tsc` (в том числе `src/cli/client.ts`), все тесты `tests/api`, `tests/cli` (`agent-cycle` проходит через `runCli` с реальным `createApp`).

11. `src/server/admin.ts` → `owner.ts` (`:34-104`), `agents.ts` (`:105-206`; после плана 05 это обёртки над `agent-keys.ts`), `backup.ts` (`:207-449`, `canonical()` заменить импортом из `src/shared/canonical-json.ts`, который вводит план 10, либо временно из `operations.ts`), `deployment.ts` (`:450-481`). `admin.ts` остаётся barrel-файлом с реэкспортами, чтобы `admin-run.ts:5`, `app.ts:58` и тесты не менялись. Проверка: `tests/cli/admin.test.ts`, `tests/api/recovery-and-history.test.ts`.

12. Документация в объёме плана: `deploy/compose.yml:14` оставить `TIMEZONE` с комментарием «читается только `taskindex-admin migrate` при первой инициализации»; `deploy/.env.example:6-7` те же пояснения; `README.md` («Локальный запуск»: `LOG_LEVEL`, `HOST`, версия схемы); план §12 (`2026-09-08-taskindex-v2.md:754-758`): перечислить `HOST`, `LOG_LEVEL` с уровнями, `TIMEZONE` только для миграции, формат строк лога (`level`, `requestId`, `event`). Остальные документы в `12-…md`.

## 5. Тесты

| # | Файл | Сценарий | Ожидание |
|---|---|---|---|
| 1 | `tests/unit/config.test.ts` (новый) | `loadServerConfig` с пустым env; без `BETTER_AUTH_SECRET`; с секретом короче 32; `LOG_LEVEL=verbose`; `NODE_ENV=production` без `PORT`/`HOST`; `BUILD_ID=x` без `BUILD` | ошибка с русским сообщением и путём переменной; в production `port 3000`, `host '0.0.0.0'`; в development `3001`, `'127.0.0.1'`; `build === 'development'` (`BUILD_ID` игнорируется) |
| 2 | `tests/api/errors.test.ts` (новый) | `createApp({ authorize: () => { throw new TypeError('boom') }, logger: collector })`, `GET /api/me` | 500, тело `{ ok:false, code:'internal', retryable:false }`; в `collector` одна запись `level:'error'` с `message:'boom'`, `stack` содержит `TypeError`, `requestId` равен заголовку ответа `x-request-id` |
| 3 | `tests/api/errors.test.ts` | `authorize` бросает `Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' })`; затем `{ code: 'SQLITE_CONSTRAINT' }` | 503 `unavailable retryable:true`; 500 `internal` |
| 4 | `tests/api/errors.test.ts` | запрос с заголовком `x-request-id: abc`; без заголовка; `LOG_LEVEL` `debug` / `info` / `warn` через `logger` с порогом | ответ несёт `x-request-id: abc`; без заголовка UUID; при `debug` строка `event:'request'` есть для `GET /api/snapshot`, при `info` нет, при `warn` нет строки для успешной команды и есть для 403 |
| 5 | `tests/api/migrations.test.ts` (дополнить) | `schemaVersion()` равен `journal.entries.length` и числу `*.sql`; `/health.schemaVersion` и `initialize(db).schemaVersion` равны ему; база с лишней записью в `__taskindex_migrations` и база с удалённой записью | `assertSchema` бросает `unavailable` в обоих случаях; `grep -r SCHEMA_VERSION src` пуст (проверка в тесте через чтение файлов не нужна: `tsc` упадёт при импорте удалённой константы) |
| 6 | `tests/api/paths.test.ts` (новый) | `process.chdir(tmpdir)`; `migrationsDirectory()` и `migrate(openDatabase(':memory:'))`; `webRoot()`; вернуть cwd в `afterEach` | каталог содержит `0000_taskindex.sql`; миграция проходит; `webRoot()` заканчивается на `dist/web` |
| 7 | `tests/api/auth.test.ts:188-192` (существующий) | `/health` при `held` | 200 с `writes:'held'`, `dbWritable:true` |
| 8 | `tests/api/durability.test.ts` (дополнить) | `withWrite` бросает исключение внутри | изменений в базе нет (`readState` прежний); `withRead` не открывает `immediate` (при параллельном `withWrite` из второго соединения на файловой базе чтение не ждёт `busy_timeout`; проверка по времени менее 100 мс) |
| 9 | `tests/unit/server-shape.test.ts` (новый) | прочитать `src/server/**/*.ts` | ни один файл не длиннее 400 строк; ни одна строка не содержит `ok: false` вне `src/shared/errors.ts` (литералы ошибок только через `DomainError`) |
| 10 | `tests/api/sse-hub.test.ts` (новый) | `createEventHub()`: две подписки, `publish([e1])`, `notifyOperations()`, отписка одной, `closeAll()` | обе получили события и уведомление; после отписки только одна; после `closeAll` подписок нет |
| 11 | `tests/api/commands.test.ts`, `tests/cli/agent-cycle.test.ts`, `tests/cli/cli.test.ts` (существующие) | после разреза маршрутов и `runOperation` | без изменений, зелёные; `tsc` подтверждает `hc<AppType>` в `client.ts:94-102` |
| 12 | `bash deploy/local-drill.sh` (вручную) | полный прогон | `schemaVersion` из `/health` совпадает с выводом `migrate`; `build` совпадает; drill зелёный |

## 6. Риски и откат

- Разрез маршрутов может сломать тип `AppType` (потеря цепочки при неверной сигнатуре обобщённой функции). Ловится `tsc` на `client.ts`; откат по шагам 8..10 это возврат файлов, поведение не менялось.
- Новый код `internal` меняет поведение клиентов при внутренней ошибке: конверт удаляется из outbox/localStorage (не повторяется). Это намеренно; агенту остаётся `operationId` в ответе и в логах. Если владелец предпочитает вечный повтор, оставить `unavailable`, но логирование (шаг 2) всё равно нужно.
- Производная версия схемы: при случайном лишнем `.sql` в каталоге образа версия изменится и старые базы не пройдут `assertSchema` (что и требуется). Риск: файл с опечаткой в имени; защита: тест 5 сверяет с журналом Drizzle.
- `HOST` по умолчанию `127.0.0.1` в dev ломает сценарий «открыть UI с телефона через Vite» только если кто-то обращался напрямую к Node-порту; Vite слушает `127.0.0.1` и так (`vite.config.ts:17`). Для проверки с телефона задать `HOST=0.0.0.0` явно.
- `BETTER_AUTH_SECRET` короче 32 символов теперь ошибка запуска: у существующего dev `.env` секрет 64 символа (`setup-dev.mjs:16`); в проде секрет из `op` проверить длину до деплоя (`12-…md`, `11-…md`).
- `x-request-id` берётся из входящего заголовка без проверки: ограничить длину 128 символов и набор `[A-Za-z0-9_-]`, иначе генерировать новый, чтобы клиент не писал в лог произвольные строки.
- Откат любого шага: revert коммита; схема базы этим планом не меняется (версия производная, миграций нет).

## 7. Вне объёма

- Keyset-пагинация, `sse.ts` с порционным бэклогом, кэш проекции: `01-performance-history-and-pagination.md` (здесь только модули и интерфейсы).
- `issues` в ответах валидации, документация кода `internal`, `GET /api/generation`, OpenAPI `operationId`/`summary`/`$ref`: `04-api-contract-and-schemas.md`.
- Запрет `/api/auth/api-key/*` и таблица `agent_keys`: `05-auth-and-agent-keys.md` (сюда входит только место в `http/auth-middleware.ts`).
- Правило `max-lines` в oxlint, `shared/canonical-json.ts`, `noUnusedLocals`, литералы ошибок в web и CLI: `10-code-quality-and-tests.md`, `07-web-client-fixes-and-structure.md`, `03-cli-outbox-and-ergonomics.md`.
- Allowlist `/health`, security-заголовки, `HOST` в compose, размер `BETTER_AUTH_SECRET` в `op`: `11-deploy-and-ops.md`.
- Drizzle как источник схемы, дрейф `COLLATE BINARY`, `node:sqlite`: `09-data-layer-and-dependencies.md`.

## Покрытые находки

| ID | Отчёт | Кратко | Где в плане |
|---|---|---|---|
| V2 | 2 (архитектура) | `app.ts` god-module, SSE и пагинация непроверяемы без HTTP | §1.1, шаги 8..10, тест 10 |
| R3 | 4 (качество, §d) | Разрезать `createApp`, `runOperation()` вместо двух копий, схемы `context/digest` наружу | шаги 8..10 |
| B5 | 5 (AI-готовность) | 1072 строки, `hc<AppType>` зависит от цепочки `.openapi()` | §1.1, §3 (обобщённые функции), шаг 10, тест 11 |
| quality §1 «`admin.ts` свалка» | 4 | Разрез на owner/agents/backup/deployment | шаг 11 |
| quality §7 «конфиг без схемы» | 4 | `server/config.ts` на Zod, `BUILD ?? BUILD_ID` | §1.2, шаг 1, тест 1 |
| Ж6 | 2 | Мёртвые `TIMEZONE`/`LOG_LEVEL` | §1.2, §3 (решение: `LOG_LEVEL` реализовать, `TIMEZONE` документировать как параметр миграции), шаги 2, 12 |
| B6 (часть про `LOG_LEVEL`) | 5 | Дрейф документации по `LOG_LEVEL` | шаги 2, 12 |
| V4 | 2 | Лог без сообщения и стека, всё неизвестное `retryable: true` | §1.3, шаг 2, тесты 2..4 |
| quality §5 «логирование» | 4 | `x-request-id` не возвращается | шаг 2, тест 4 |
| V6 | 2 | `SCHEMA_VERSION` не связана с миграциями | §1.4, шаг 3, тест 5 |
| B4 | 5 | Миграция без bump не ловится | §1.4, шаг 3, тест 5 |
| B-10 (часть приложения) | 3 | Что отдаёт `/health` | §1.5, §3, шаг 5; nginx в `11-…md` |
| V7 | 2 | «`/health` пишет в базу» | §1.5: замер показал отсутствие WAL-кадров; шаг 5 добавляет комментарий и вычисляемый `dbWritable` |
| B-12 | 3 | Dev слушает `0.0.0.0` | §1.6, шаги 1, 4, тест 1 |
| S5 | 1 (стек) | Пути от cwd | §1.6, шаги 3, 4, тест 6 |
| quality §7 «транзакции» | 4 | `withWrite`/`withRead` | §1.7, шаг 6, тест 8 |
| quality §3/§5 «13 литералов ошибок» | 4 | 8 серверных → `DomainError.toJSON()` | §1.7, шаг 7, тест 9; web/CLI в планах 07/03 |
| Astra Q-02 | astra / TI-020 | лог без `message`/`stack`, `LOG_LEVEL` мёртв, нет корреляции запроса и ошибки | §1.3, шаг 2 (совпало с V4); шаг 14 уточняет `retryable` |
| Astra B-01 (хаб) | astra / TI-001 | подписчик SSE не знает актора и не перепроверяет доступ | шаг 13; содержимое проверки в плане 05 |
| Astra S-03 (интерфейс) | astra / TI-013 | версия схемы сверяется по именам без контрольных сумм | шаг 15; колонка и backfill в плане 09 |
| FA:V7 снят | сверка / TI-075 | «`/health` пишет в базу» не подтверждено замером | §1.5, шаг 5 без изменений |

## Сверка с ревью Astra (2026-09-08)

Кратко: Astra Q-02 (`astra-20-structured-error-diagnostics.md`, реестр TI-020) совпадает с V4 (§1.3): паритет по точности; Astra дополнительно отмечает, что GET-ошибки логируются без контекста, а строка лога POST не связана с ошибкой общим id, и что `LOG_LEVEL` мёртв. Всё это закрывает шаг 2 (`requestId` в контексте, заголовок `x-request-id`, общий `logger.error` с методом, путём, сообщением и стеком). Одно уточнение принимается из `ASTRA-VS-FABLE.md` §4.7: правило «любая не-SQLite ошибка это `retryable:false`» опасно по классу исключения, потому что исключение может возникнуть после коммита (рассылка SSE, `c.json`); сегодня executor возвращается до уведомления подписчиков (`src/server/app.ts:473-481`). Решение: окончательный отказ только при известном исходе (шаг 14). Для Astra B-01 хабу SSE нужно знать актора (шаг 13, проверка в плане 05). Astra S-03 (контрольные суммы миграций) касается шага 3: интерфейс здесь, реализация в плане 09. V7 (реестр TI-075, СНЯТО): утверждение ревью-2 о записи `/health` в базу не подтвердилось; §1.5 и шаг 5 уже фиксируют замер (20 холостых `UPDATE` дают 0 байт WAL, `data_version` не меняется), сверка это повторила; Astra стоимости `/health` не утверждала.

### Добавлено по итогам сверки
| Пункт | Источник Astra | Реестр | План Astra | Что делаем здесь / где делается |
|---|---|---|---|---|
| Подписчик SSE несёт актора и credential и перепроверяет доступ перед доставкой | B-01 | TI-001 | `astra-01-sse-access-revocation.md`, шаги 2-5 | шаг 13 ниже; содержимое `check` в плане 05 (дополнительный шаг 10) |
| `x-request-id` в ответе, ошибка и строка лога с одним `requestId`, лог для GET | Q-02 | TI-020 | `astra-20` | уже шаг 2; без изменений |
| `LOG_LEVEL` подключить или убрать | Q-02 | TI-020 | `astra-20` | уже §3: реализовать; без изменений |
| `retryable:false` только при известном исходе операции | Q-02 и `ASTRA-VS-FABLE.md` §4.7 | TI-020 | `astra-20` | шаг 14 ниже |
| Контрольные суммы применённых миграций в `assertSchema` | S-03 | TI-013 | `astra-13-migration-checksums.md` | шаг 15 ниже (интерфейс); колонка, backfill и тесты в плане 09 (дополнительный шаг 11) |
| Курсор операций как отдельная сущность пагинации | B-04 | TI-008 | `astra-08-operation-feed-cursor.md` | шаг 8: интерфейс `page()` принимает ключ `after` для SQL-списков, как уже предусмотрено планом 01 (шаг 7); сам курсор в плане 04 |
| Стоимость `/health` | FA:V7 | TI-075 | нет | §1.5, шаг 5 без изменений; замер сверки подтверждает |

### Расхождения и решение
- Код `internal` и `retryable`. Здесь §3 выбирает `500 internal retryable:false`, чтобы клиенты не повторяли вечно; `ASTRA-VS-FABLE.md` §4.7: граница должна быть известностью результата, а не классом исключения. Решение: `internal` остаётся для исключений до и внутри `executeOperation` (транзакция откатывается `db.sqlite.transaction`), а ошибки после коммита не меняют ответ и только логируются (шаг 14). Критерий 2 дополняется этой оговоркой.
- Q-02: разногласий нет; у Astra есть артефакт probe, у нас следствие про `retryable:true` и вечный конверт (§1.3). Оба учтены.
- `/health`: разногласий нет; Astra ничего не утверждала, наше утверждение снято, проба записи сохраняется как проверка `SQLITE_READONLY`.

### Дополнительные шаги
13. `createEventHub` (шаг 9): `subscribe({ onEvents, onOperations, actor, credential, check, close })` возвращает функцию отписки; `publish(events)` и `notifyOperations()` вызывают `check()` для каждого подписчика перед доставкой и закрывают провалившихся через их `close('revoked')`; `closeFor(predicate)`; в `createStreamResponse` тик heartbeat вызывает `check()` и перед закрытием ставит в очередь `event: revoked`. `Deps` получает фабрику `check` из плана 05 (дополнительный шаг 10). Тест 10 расширить: подписчик с `check: () => false` ничего не получает на `publish` и удаляется; `closeFor` по `agentId` закрывает только совпадающих.
14. Граница известного исхода в `runOperation` (шаг 10): `executeOperation` коммитит внутри себя; последующие `hub.publish` и `hub.notifyOperations` обернуть в `try/catch`, который пишет `logger.error({ event: 'post_commit_error', requestId, operationId, message, stack })` и всё равно возвращает `c.json(result.body, result.status)`. Код `internal` (500, `retryable: false`) остаётся только для исключений, брошенных до или внутри `executeOperation`. В §3 и критерий 2 добавить фразу «`retryable:false` только при известном исходе». Тест `tests/api/errors.test.ts`: `createApp` с хабом, чей `publish` бросает → ответ 200 с сохранённым телом, одна запись `post_commit_error`; `GET /api/operations/{id}` возвращает операцию.
15. Дельта шага 3 (Astra S-03): `bundledMigrations(dir)` возвращает `{ name, sha256 }[]` (хеш байтов файла с нормализацией `\r\n` в `\n`); `assertSchema` сравнивает множество `{ name, sha256 }` из `__taskindex_migrations` с набором образа; несовпадение содержимого → `unavailable` «Содержимое применённой миграции <name> изменено». Колонка `sha256`, backfill существующих строк и проверка при `migrate` описаны в плане 09 (дополнительный шаг 11). Тест 5 расширить: изменённый байт во временной копии применённого SQL → `assertSchema` бросает.

## Решение владельца (2026-09-10, делегировано Fable)

- Граница окончательности ошибок: по известности результата, не по классу исключения (шаг 14). `internal` с `retryable: false` только для исключений до или внутри `executeOperation`; ошибки после коммита логируются и не меняют ответ. Вариант «любой не-SQLite Error окончателен» снят.
- `LOG_LEVEL` реализуется (уровни `error`, `info`, `debug`), а не удаляется, потому что уже объявлен в compose и документации. `TIMEZONE` остаётся переменной только для `migrate`, документация исправляется.
