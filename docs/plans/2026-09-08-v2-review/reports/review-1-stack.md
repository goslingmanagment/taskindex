# Ревью 1: технический стек TaskIndex v2

Дата: 2026-09-08. Объект: незакоммиченное дерево `main` в `/Users/dmitriy/code/taskindex` (v2, ~12k строк). Режим: только чтение; запускались typecheck, lint, format-check, vitest и пробные скрипты в scratchpad под Node 24.20.0.

## (a) Итоговый вердикт

1. Стек в целом выбран верно и согласован с продуктом «один владелец + агенты, один VPS, low-ops»: Node 24 + Hono + SQLite (WAL, `synchronous=FULL`) + SSE + React/Vite SPA + Litestream + Docker Compose — каждая часть на месте, ни одну заменять срочно не нужно.
2. Главная несостыковка — не в выборе библиотек, а в том, как используется слой данных: сервер держит модель «загрузить всё состояние и весь журнал событий в память → применить чистый редьюсер → записать diff». Drizzle ORM и индексы SQLite при этом почти ничего не делают (ни одного `WHERE` по предметным полям, `readState`/`readEvents(db)` без лимита на каждую команду и почти каждое чтение). Сейчас это безопасно, но это единственная точка, где стек «не платит за себя» и где появится потолок по мере роста `events` (журнал по плану не сжимается).
3. Better Auth оправдан для входа владельца (пароль + passkey — WebAuthn руками писать не стоит), но плагин API-ключей — избыточен: 27-колоночная таблица ради `agent_id + scope + hash`, scope хранится трижды, и каждая проверка ключа делает **две реальные записи в БД** (`lastRequest`, `updatedAt`) — то есть каждый GET агента = 2 fsync-транзакции и трафик Litestream.
4. Фронтенд несёт два стилевых мира: Tailwind 4 + shadcn/Base UI + cva + tw-animate + tailwind-merge живут только в 18 примитивах `src/web/ui`, а всё приложение (`src/web/app`, 158 `className`) стилизовано вручную 2713-строчным CSS с 527 селекторами. Плюс один чанк 1.03 MB (294 KB gzip) без code-splitting, полный Zod 4 в браузере, `date-fns` не используется, `shadcn` (CLI) фактически стал runtime-зависимостью через `@import 'shadcn/tailwind.css'`.
5. Тулинг (tsdown, tsx, oxlint+oxfmt, vitest 4, fast-check, Playwright) — хороший современный минимум; замечания косметические (двойной typecheck, polling-watch в Vite, lint не покрывает `deploy/database.mjs`).
6. Деплой продуман выше среднего (held/open-writes, drill, откат парой «образ + копия»). Docker оправдан именно из-за Litestream-сайдкара и пиннинга Node. Замечания: сборка образа на VPS, нет сжатия/кэш-заголовков для статики, нет HSTS/HTTP/2 в Nginx.
7. Рекомендуемый порядок работ: (1) заменить api-key-плагин своей таблицей хешированных ключей; (2) выправить слой данных — точечные SQL-запросы для чтения одной задачи/истории/операций и ограничить `history`, передаваемую в `applyCommand`; (3) фронтенд-гигиена: убрать `date-fns`, вынести `shadcn/tailwind.css` в репозиторий и убрать `shadcn` из зависимостей, `zod/mini` или отказ от клиентской валидации, `@tailwindcss/vite`, разбиение чанка; (4) решить, нужен ли OpenAPI вообще — сейчас его никто не потребляет.

## (b) Сводная таблица

| Элемент | Вердикт | Причина одной строкой |
|---|---|---|
| Node 24 (engines `>=24.11 <25`, `.nvmrc`, `.node-version`, Dockerfile `24.20.0`) | keep | Согласовано между файлами; нижняя граница диктуется tsdown (`^24.11`) |
| `overrides.undici: 7.29.1` | remove (вместе с shadcn) | Затрагивает только dev-дерево `shadcn → @dotenvx/dotenvx → undici`; исчезнет, если `shadcn` не будет установлен |
| `type: module`, ESM везде | keep | Единый формат, tsdown/vite/vitest без CJS-мостов |
| better-sqlite3 | keep (с планом ухода) | Работает, drill пройден; `node:sqlite` в 24.20 уже без флага/предупреждения, но у Drizzle 0.45 нет драйвера для него — переход означает отказ от Drizzle |
| Drizzle ORM | simplify | Используется как маппер строк для CRUD; ни одного предметного запроса; настоящий «движок запросов» — JS над полным состоянием |
| drizzle-kit + собственный мигратор | simplify | Kit только генерирует SQL; применяет свой `__taskindex_migrations`; SQL подправлен руками (`COLLATE BINARY`) — снапшот об этом не знает |
| Hono + `@hono/node-server` | keep | Лёгкий, `app.request` даёт in-process API-тесты, SSE через `ReadableStream` |
| `@hono/zod-openapi` | simplify | OpenAPI генерируется и отдаётся, но ни CLI, ни скилл, ни агенты его не читают; `z` реэкспортируется из него в shared/web/CLI |
| Zod 4 | keep | Используется последовательно (`z.iso.datetime`, `z.url`, `z.toJSONSchema`, `.nonoptional`), `.describe()` есть на предметных полях; совместимость с zod-openapi 1.6.3 подтверждена (peer `zod ^4`) |
| Better Auth core + passkey | keep | Passkey/WebAuthn + сессии + rate-limit входа за 40 строк конфигурации; `@simplewebauthn/server` под капотом |
| Better Auth api-key plugin | replace | 2 записи в БД на каждую проверку ключа; 27 колонок; scope хранится трижды; своя таблица `agent_keys` — 30–50 строк |
| React 19 + Vite 8 SPA без роутера | keep | 10 URL-параметров через `URLSearchParams` — роутер лишний |
| `useSyncExternalStore` + свой store | keep | Store покрыт тестами, DOM-независим, содержит outbox/optimistic-логику, которую стейт-библиотека не дала бы |
| Base UI 1.7 + shadcn (base-nova) | keep | 16 компонентов из `@base-ui/react/*` реально импортируются |
| Tailwind 4 + cva + tailwind-merge + clsx + tw-animate-css | simplify | Живут только в `src/web/ui`; приложение — ручной CSS на 2713 строк; выбрать один подход |
| `shadcn` (devDependency) | remove из зависимостей | CLI-инструмент, но его `dist/tailwind.css` импортируется в сборку — вынести 16 KB CSS в репозиторий, CLI вызывать через `npx` |
| `date-fns` | remove | 0 импортов; лишь опциональный peer Base UI |
| `fractional-indexing` | keep | 1 импорт в `commands.ts`, бинарное сравнение соблюдено |
| dnd-kit (core/sortable/utilities) | keep | Mouse/Touch/Keyboard-сенсоры с activationConstraint, `touch-action`, e2e с `hasTouch` |
| SSE + polling | keep | Правильный транспорт для одного сервера; `Last-Event-ID`, heartbeat, `X-Accel-Buffering`, nginx-локация настроены верно |
| tsdown | keep | Два бандла, `target: node24`, native внешний |
| tsx (dev/admin) | keep | `node --watch --import tsx` — без nodemon |
| oxlint (type-aware) + oxfmt | keep | Быстро, без eslint-конфигурационного ада; `typeCheck: true` дублирует `tsc` в `check` |
| vitest 4 + fast-check + Playwright 1.63 | keep | Слои разделены верно; e2e ходит на Vite dev, а не на `dist/web` |
| Docker (multi-stage, bookworm, tini) | keep | Оправдан сайдкаром Litestream и пиннингом; systemd + бинарь не дал бы атомарного отката «образ + копия» |
| Litestream 0.5.12 | keep | Правильнее cron `.backup` (непрерывность, TXID-restore); `auto-recover: false`, retention 720h |
| Nginx-конфиг | simplify | SSE-локация корректна; нет `http2`, HSTS, `ssl_session_cache`, gzip/brotli, `expires` для хешированных ассетов |

## (c) Детальные находки

### Слой данных

**D1. Полная загрузка состояния и журнала на каждую команду и почти каждое чтение — важно.**
- `src/server/operations.ts:93-95`: `executeOperation` делает `readState(db)` (все задачи, чеклисты, комментарии) и `readEvents(db)` (весь журнал без лимита), затем `history: [...history, ...events]` (`:106`) копирует весь массив на каждую команду пакета (до 100 команд → до 100 копий журнала).
- `src/server/app.ts:559, 599, 614, 630, 641, 874, 957, 1039`: `/api/tasks`, `/api/tasks/by-origin`, `/api/tasks/{id}`, `/api/projects`, комментарии, `/api/context`, `/api/digest`, `/api/focus` — каждое чтение начинается с `readState(db)`; `/api/tasks/{id}` загружает все задачи, чтобы найти одну.
- `src/server/app.ts:679`: `/api/tasks/{id}/history` читает **весь** `events` и фильтрует в JS, хотя есть индекс `events_entity_revision`.
- `src/server/db.ts:235-273`: `readOperations` читает все `operations` и для каждой делает до 3 отдельных `SELECT title` (N+1); вызывается из `/api/operations`, `/api/operations/{id}` (`app.ts:713, 736`), digest и export.
- `src/server/db.ts:165-234`: `writeState` находит изменения через `JSON.stringify` полного объекта каждой записи против предыдущего состояния.
- Следствие для стека: Drizzle, индексы SQLite и `COLLATE BINARY` в этой модели декоративны; всё сравнение и фильтрация — в JS. Сегодня (сотни задач, тысячи событий) это доли миллисекунды; журнал по плану не сжимается («Событий в первой версии не сжимают»), и стоимость каждой команды растёт линейно с историей.
- Рекомендация: (1) в `applyCommand` передавать не весь журнал, а только события нужной сущности/операции (для undo нужны именно они) — точечный `SELECT ... WHERE entity_kind=? AND entity_id=?` / `WHERE operation_id=?`; (2) `GET /api/tasks/{id}`, `/history`, `/operations/{id}` перевести на точечные запросы; (3) `readOperations` — один JOIN/подзапрос вместо N+1. Trade-off: чуть больше SQL в `db.ts`, зато ORM начинает работать по назначению; API и тесты не меняются.

**D2. Drizzle — маппер, а не ORM; собственный мигратор поверх drizzle-kit — желательно.**
- Весь Drizzle-код — `select().from(t).all()/get()`, `insert…onConflictDoUpdate`, `update`, `delete` (`db.ts`, `admin.ts`, `auth.ts:54-65`). Ни одного JOIN, агрегата или условия по предметному полю.
- Миграции применяет собственный цикл (`db.ts:46-96`, таблица `__taskindex_migrations`), а не `drizzle-orm/better-sqlite3/migrator`; `meta/_journal.json` и 1313-строчный `0000_snapshot.json` нужны только для `db:generate`.
- Дрейф: `drizzle/v2/0000_taskindex.sql:166` содержит `order_key text COLLATE BINARY`, `src/server/schema.ts:41` и снапшот — нет (в снапшоте 0 упоминаний `COLLATE`). Тест `tests/api/migrations.test.ts:103-106` проверяет `coll === 'BINARY'` в индексе — это дефолтная коллация SQLite, поэтому ручная правка ничего не меняет, но показывает, что SQL редактируется после генерации и снапшот не является источником правды.
- Причина, по которой Drizzle вообще нужен: адаптер Better Auth (`auth.ts:19`) и типизация схемы. Альтернативы: (а) оставить Drizzle только как источник схемы + kit generate, а рантайм-чтения писать `db.sqlite.prepare(...)` — уже делается для `latestSeq`, `migrate`, health; (б) Better Auth умеет работать с `better-sqlite3` напрямую (peer `better-sqlite3 ^12`, `kysely 0.29.5` уже установлен как его зависимость) — тогда Drizzle можно убрать целиком, но auth-таблицы придётся мигрировать через `@better-auth/cli generate`. Верно любое; текущее «и то, и другое» — самый дорогой вариант.

**D3. better-sqlite3 против `node:sqlite` — желательно (не сейчас).**
- Используется: `pragma()` для `foreign_keys/journal_mode/synchronous/busy_timeout` (`db.ts:21-24`), `transaction(...).immediate()` (`db.ts:50-95`, `operations.ts:51-198`, `admin.ts`), `prepare/exec`, `backup()` (`deploy/database.mjs:45, 89`), `readonly/fileMustExist` (`database.mjs:27`).
- Проверено локально: `node:sqlite` в 24.20.0 импортируется без `ExperimentalWarning`, флаг `--experimental-sqlite` принимается как no-op, экспорты `DatabaseSync, StatementSync, Session, backup, constants`; `PRAGMA journal_mode=WAL / synchronous=FULL` работают; `@types/node@24.13.3` по-прежнему помечает модуль `@experimental` (Stability 1.1). Нет `.transaction()`-хелпера (нужен ручной `BEGIN IMMEDIATE/COMMIT/ROLLBACK`), нет `.pragma()` (через `exec/prepare`), `backup` — асинхронная функция модуля. `drizzle-orm@0.45.2` драйверов для `node:sqlite` не содержит (есть `better-sqlite3, bun-sqlite, d1, durable-sqlite, expo-sqlite, libsql, op-sqlite, sqlite-proxy`).
- Нативный модуль реально мешает: на этой машине `better-sqlite3` не грузится под Node 26; в Docker это закрыто пином `node:24.20.0-bookworm` и сборочной стадией с `python3 make g++` (`deploy/Dockerfile:3`). Alpine избегают правильно.
- Вывод: оставить, но зафиксировать как путь упрощения после D2 — если Drizzle уходит, `node:sqlite` убирает toolchain из Dockerfile и ABI-зависимость. Trade-off: better-sqlite3 быстрее и зрелее; `node:sqlite` пока Stability 1.1.

### Сервер и контракты

**S1. Каждая проверка API-ключа агента — две реальные записи в БД — важно.**
- `src/server/auth.ts:51`: `auth.api.verifyApiKey` на каждый запрос агента (включая GET).
- В `@better-auth/api-key@1.7.3` (`dist/index.mjs:1717-1730` `claimUsageInDatabase`): `consumeRateLimit` → при `rateLimitEnabled: false` возвращает `{type:'skip', lastRequest: now}` и делает `adapter.update({lastRequest})` (`:1796-1804`), затем безусловно `adapter.update({updatedAt: new Date()})` (`:1721-1727`). Плюс раз в 10 с `deleteAllExpiredApiKeys` (`:2060-2064`).
- При `synchronous=FULL` это два fsync-коммита и два набора WAL-кадров на каждое чтение агента; Litestream реплицирует их в S3. Для продукта, где агенты «сначала context/digest, потом команды», чтений больше, чем записей. Опция `deferUpdates` лишь переносит запись в фон.
- Схема: `src/server/schema.ts:201-228` — 27 колонок (`refillInterval`, `rateLimitTimeWindow`, `remaining`, `permissions`, `metadata`…), реально читаются 2 своих (`agentId`, `scope`, `auth.ts:59`). Scope хранится трижды: `metadata.scope`, `permissions.workspace`, колонка `scope` (`admin.ts:160-173`).
- Рекомендация: своя таблица `agent_keys(id, agent_id, scope, key_hash, created_at, revoked_at)`; хеш SHA-256 (как в плагине), сравнение `timingSafeEqual`, `Authorization: Bearer` уже разбирается вручную в `auth.ts:47-49`. Это убирает плагин, 27 колонок, две записи на запрос и тройное хранение scope; `agent create/agent-key create/revoke/list` в `admin.ts` остаются с той же формой. Trade-off: теряются функции плагина, которые всё равно выключены (rate-limit по ключу, refill, expiry).

**S2. Better Auth для владельца — правильно; замечания к конфигурации — желательно.**
- `auth.ts:14-39`: `disableSignUp`, `ipAddressHeaders: ['x-real-ip']` (совпадает с nginx `proxy_set_header X-Real-IP $remote_addr`), `rateLimit.enabled` (память, один процесс — достаточно), passkey `rpID` из `BASE_URL`. Владелец создаётся напрямую в таблицы (`admin.ts:34-70`) через `hashPassword` из `better-auth/crypto` — совместимо с `emailAndPassword`.
- `authorizeRequest` (`auth.ts:75-77`) вызывает `getSession` без `session.cookieCache` → два SELECT (session+user) на каждый запрос владельца. Для одного пользователя приемлемо; `cookieCache` сократит до нуля при большинстве запросов.
- Origin-проверка для мутаций владельца (`app.ts:313-318`) — верно.
- Альтернатива «руками» (`@simplewebauthn/server` + своя сессия) дала бы ~300–500 строк и ответственность за WebAuthn-корнер-кейсы; не стоит того. Вердикт: keep.

**S3. `@hono/zod-openapi`: контракт генерируется, но не потребляется — желательно.**
- `app.ts:1056-1065`: `doc('/api/openapi.json')`. Потребители: только `tests/api/commands.test.ts:752` и `recovery-and-history.test.ts:155`. `skills/taskindex/SKILL.md` OpenAPI не упоминает; агенты получают схемы из `/api/context`, который строится нативным `z.toJSONSchema` (`app.ts:893-896`) — zod-openapi для этого не нужен. CLI (`src/cli/client.ts`) — ручной `fetch`, кроме двух POST через `hc`.
- Цена: `createRoute` с 6 одинаковыми `responses` на каждый маршрут (`readErrors`, `app.ts:84-91`), `OpenAPIHono<Env>`, зависимость `@asteasolutions/zod-to-openapi` + `openapi3-ts`.
- Скрытая цена: `src/shared/schemas.ts:1` — `import { z } from '@hono/zod-openapi'`, и через него `src/web` и `src/cli` зависят от серверного пакета. В `dist/cli/domain-schemas-*.js` есть `from "@hono/zod-openapi"` (замерено: +7 мс к загрузке `zod`, старт `taskindex --help` 50–80 мс — на практике незаметно, но слои перепутаны). В веб-бандле сам zod-openapi tree-shaking убрал (0 совпадений `OpenAPIHono/zod-to-openapi`), а Zod остался (581 вхождение `_zod`).
- Рекомендация: либо (а) `import { z } from 'zod'` в shared и `@hono/zod-validator` на сервере, `/api/openapi.json` убрать — минус зависимость и ~80 строк boilerplate; либо (б) оставить OpenAPI как контракт «на будущий MCP», но тогда научить CLI/скилл им пользоваться. Сейчас платят за (б), пользуются как (а).

**S4. Ручная дубликация 16 вариантов `discriminatedUnion` — желательно.** `src/shared/schemas.ts:219-430`: `commandSchema` и `commandEnvelopeSchema` — по 16 копий одинакового `z.object({command: z.literal(k), payload: schemas[k]})`. Zod 4 позволяет собрать оба из `Object.entries(schemas).map(...)`; это не ошибка стека, но признак, что API Zod используется «в лоб». Не влияет на поведение.

**S5. Пути относительно cwd — желательно.** `db.ts:52` `resolve('drizzle/v2')`, `index.ts:37-38` `./dist/web` — работают благодаря `WORKDIR /app` и запуску из корня; `taskindex-admin` из `/usr/local/bin` вне `/app` упадёт на `migrate`. Есть обход `TASKINDEX_MIGRATIONS_DIR`; лучше резолвить от `import.meta.url`.

### Фронтенд

**F1. Два стилевых подхода одновременно — важно (для сопровождения).**
- `src/web/styles.css`: 2713 строк, ≈527 селекторов классов, 3 `@apply`, 0 `@utility`. `src/web/app/*.tsx`: 158 атрибутов `className`, из них 3 похожи на Tailwind-утилиты, 0 вызовов `cn()`. `src/web/ui/*.tsx`: 117 `className`, 93 `cn()`, 4 `cva()`, 55 классов `tw-animate-css`.
- То есть Tailwind 4, `class-variance-authority`, `tailwind-merge`, `clsx`, `tw-animate-css`, `shadcn/tailwind.css` (16 KB) обслуживают 18 примитивов, а весь продуктовый UI — обычный CSS. Это соответствует решению «один в один по эталону», но означает, что проект платит за Tailwind-пайплайн (`@tailwindcss/postcss`, oxide), не используя его там, где 90% разметки. Выбрать одно: либо перенести `app/` на утилиты, либо сузить Tailwind до `ui/` и не тащить `shadcn/tailwind.css`.
- `--font-geist-sans` (`styles.css:10, 52, 83`) — шрифт Geist не подключён, переменная разворачивается в системный стек; наследие шаблона.

**F2. `shadcn` как зависимость сборки и причина `overrides.undici` — желательно.**
- `styles.css:3` `@import 'shadcn/tailwind.css'` → `node_modules/shadcn/dist/tailwind.css` (16 041 байт). Значит `shadcn@4.18.0` (33 зависимости, среди них `@dotenvx/dotenvx → undici`) обязан быть установлен на этапе `vite build` (в Dockerfile так и есть: `npm ci --include=dev`). `overrides.undici: 7.29.1` существует только ради этой ветки (`npm ls undici`: единственный потребитель — `shadcn` и `@dotenvx/dotenvx`, оригинальные диапазоны `^7.27.2` / `^7.11.0`).
- Рекомендация: скопировать `tailwind.css` в `src/web/`, убрать `shadcn` и `overrides`; компоненты добавлять `npx shadcn@latest add`. Минус ~33 пакета из dev-дерева, минус override.

**F3. Вес и состав бандла — желательно.**
- `dist/web/assets/index-*.js`: 1 034 223 байт / 294 201 gzip, один чанк, без source map, без `manualChunks`/`React.lazy`. Маркеры: `_zod` ×581 (полный Zod 4 classic — `applyCommand` в store вызывает `parseCommand`, `store.ts:88`), better-auth client + `nanostores`, `passkey` ×26, `data-slot` ×80 (Base UI), `aria-` ×153.
- Отдача: `@hono/node-server/serve-static` не ставит `Cache-Control` (только `Last-Modified`, `serve-static.cjs:116`), `precompressed` не включён; в `deploy/nginx/taskindex.conf` нет `gzip`/`brotli`/`expires`. Если на хосте `gzip on` не унаследован из `nginx.conf`, браузер владельца тянет 1 MB при каждом открытии.
- Рекомендации по убыванию эффекта: `Cache-Control: public, max-age=31536000, immutable` для `/assets/` в nginx + `gzip_proxied any`/`gzip_types application/javascript` (или `precompressed: true` в serveStatic и сборка `.br/.gz`); `zod/mini` для `src/shared` или валидация только на сервере (клиент и так получает отказ `invalid`); `build.rollupOptions.output.manualChunks` (react/base-ui/better-auth) и `lazy()` для `activity.tsx` (504 строки) и `editor.tsx` (693). Trade-off: `zod/mini` меняет синтаксис (`z.string().min()` → `z.string().check(z.minLength())`) во всём shared.

**F4. Vite: postcss-плагин вместо `@tailwindcss/vite`, polling-watch — желательно.**
- `vite.config.ts:2, 15`: `@tailwindcss/postcss` — рабочий, но для Vite Tailwind рекомендует `@tailwindcss/vite` (быстрее dev/HMR, без postcss-обёртки). `@tailwindcss/vite` не установлен.
- `vite.config.ts:20`: `watch: { useFsEvents: false, usePolling: true }` безусловно. В старом конфиге (`git diff vite.config.ts`) это было условием `CODEX_SANDBOX === 'seatbelt'`; теперь polling всегда — лишний CPU в обычной разработке. Вернуть условие или убрать.

**F5. Что во фронтенде выбрано верно (для баланса).** Отказ от роутера при 10 параметрах (`url.ts:3-14`), `useSyncExternalStore` с DOM-независимым store, покрытым 368 строками тестов без jsdom (`tests/web/store.test.ts`), Base UI 1.7 (16 реальных импортов `@base-ui/react/*`), dnd-kit с `MouseSensor {distance: 8}`, `TouchSensor {delay: 220, tolerance: 6}`, `KeyboardSensor` (`board.tsx:54-60`) и `touch-action: none/pan-y` (`styles.css:2539, 2546`), e2e-профиль `isMobile + hasTouch` (`workspace.spec.ts:570-572`). `fractional-indexing` — 1 импорт, сравнение через `<`/`>` (`queries.ts:2-5`).

### Синхронизация

**Y1. SSE — верный выбор, реализация корректна — проблем не найдено.** `app.ts:752-866`: `id: <generation>:<seq>`, `Last-Event-ID` парсится по последнему `:`, `event: reset` при чужом поколении, `: connected` сразу, heartbeat 25 с с `unref`, подписка добавляется до чтения бэклога (`:847-851`, окна потери нет), backpressure-защита `desiredSize < -1000`, `X-Accel-Buffering: no`. Nginx `location = /api/events/stream` (`taskindex.conf:25-36`): `proxy_buffering off`, `proxy_http_version 1.1`, `Connection ""`, `proxy_read_timeout 1h` — как в плане. Клиент (`sync.ts`) переоткрывает поток при смене поколения, догоняет по `since` и раз в минуту при `!connected`. WebSocket ничего бы не добавил (поток однонаправленный, команды идут POST с idempotency).

### Инструменты и сборка

**T1. `npm run check`: тип-проверка выполняется дважды — желательно.** `.oxlintrc.json:23-26` `typeAware: true, typeCheck: true` («experimental type checking, includes TypeScript compiler diagnostics» по `--help` oxlint) + отдельный `tsc --noEmit`. Работает (oxlint на тестовом файле с `any`/`var` выдал ошибки), но `typeCheck` можно снять, оставив `typeAware`.

**T2. Покрытие lint/format — желательно.** `package.json` `lint` перечисляет `scripts/dev.mjs`, `scripts/setup-dev.mjs`, но не `deploy/database.mjs` (130 строк рантайм-кода в образе); shell-скрипты `deploy/*.sh` (≈400 строк с `trap ERR`, `flock`, `jq`) не проверяются `shellcheck`. Для такого объёма деплой-логики это заметный пробел.

**T3. tsdown/tsx/oxfmt — проблем не найдено.** `tsdown.config.ts`: два бандла, `target: node24`, native и `hono` внешние (`dist/server/index.js` импортирует `better-sqlite3`, `drizzle-orm`, `better-auth`, `@hono/*` как внешние — правильно для Node). CLI-бандл 22 KB + общий чанк 24 KB. Cold `tsc --noEmit` — 3.3 с, цепочка `OpenAPIHono` типов не тормозит.

### Развёртывание

**P1. Сборка образа на VPS — желательно.** `deploy/deploy.sh:41` `dc build app` на проде: Vite + tsdown + компиляция better-sqlite3 (`Dockerfile:3` ставит `g++`), в момент когда старый релиз ещё работает. На маленьком VPS это память и время; при неудаче сборки деплой падает до остановки — безопасно, но медленно. Альтернатива: собирать локально/в CI под `linux/amd64` и переносить `docker save | ssh docker load` или реестр; `deploy.sh` уже принимает `TASKINDEX_IMAGE`.

**P2. `npm prune --omit=optional` в рантайм-стадии — желательно.** `Dockerfile:9`. Сейчас drill проходит, но `--omit=optional` снимает optionalDependencies у всех рантайм-пакетов; при обновлении зависимостей это может тихо убрать нужный платформенный модуль. Достаточно `--omit=dev`.

**P3. Nginx: TLS/кэш — желательно.** `taskindex.conf:12` `listen 443 ssl` без `http2 on`; нет `add_header Strict-Transport-Security`, `ssl_session_cache`, `ssl_prefer_server_ciphers`; `location /` без `expires`/`gzip` (см. F3). SSE-локация — без замечаний.

**P4. Docker против systemd — Docker оправдан.** Причины в коде: сайдкар Litestream в том же volume (`compose.yml:41-59`), точный пин `node:24.20.0`, откат парой «тег образа + `.db`-копия» (`rollback.sh:38-45`), `stop_grace_period`, healthcheck, лог-ротация `json-file 10m×3`. systemd-вариант потребовал бы воспроизвести это руками. Верно и то, что `restart: unless-stopped` + `TASKINDEX_WRITES: held` не ломает перезапуск: `approved_deployment` хранится в БД (`admin.ts:464-481`).

**P5. Litestream 0.5.12 — верный выбор.** Непрерывная репликация + `restore -txid` + `sync -wait` дают точку восстановления, которую cron `sqlite3 .backup` или Restic не дадут без остановки записи; `auto-recover: false`, `shutdown-sync-timeout`, socket — по документации 0.5. Ограничение честно записано в README: проверен только `file://` backend.

### Зависимости

**Z1. Точные пины, lockfile v3 в синхроне — проблем не найдено.** `npm ls --depth=0` под Node 24.20.0 — без `invalid/missing/extraneous`; `package-lock.json` (706 пакетов) соответствует `package.json` по deps/devDeps/engines; рантайм-дерево (`npm ls --omit=dev --all`) — 184 записи. Лицензии проверенных пакетов: MIT, Apache-2.0 (drizzle-orm).

**Z2. Лишние/сомнительные — желательно.** `date-fns@4.1.0` — 0 импортов (только опциональный peer `@base-ui/react`) — убрать. `shadcn`/`overrides.undici` — см. F2. `zod` не импортируется напрямую ни разу (всё через `@hono/zod-openapi`) — см. S3. `kysely@0.29.5` приезжает с `better-auth` и не используется при Drizzle-адаптере (неизбежно, пока Better Auth). `@types/better-sqlite3@9.6.0` отстаёт от `better-sqlite3@12` по major, но `tsc` проходит.

### Тесты

**Q1. Разбиение по слоям верное — проблем не найдено.** `tests/api/helpers.ts:58` — `app.request` in-process с `:memory:` и настоящими миграциями; `tests/cli/cli.test.ts:36-49` — инъекция `fetch` в `runCli`; `tests/cli/agent-cycle.test.ts` — настоящий Better Auth + два ключа; `tests/property` — fast-check по последовательностям команд; `tests/web/store.test.ts` — store без DOM; `tests/api/durability.test.ts` — файловая БД, `journal_mode=wal`, `synchronous=2` после переоткрытия; `tests/api/migrations.test.ts` — `drizzle-kit/api` подтверждает отсутствие дрейфа схемы относительно снапшота. 75 тестов / 14 файлов проходят за 1.8 с.

**Q2. E2E не покрывает production-раздачу статики — желательно.** `tests/e2e/server.ts:33-44` поднимает Vite dev server с proxy; `serveStatic` + SPA-fallback из `src/server/index.ts:37-38` и заголовки отдачи ни одним тестом не проверяются (только ручным шагом 14 в `docs/audits/.../REPORT.md`). Один e2e-проект на `dist/web` через `node dist/server/index.js` закрыл бы это.

## (d) Что запускалось и что получилось

Все команды — под `PATH=/private/tmp/taskindex-v2-tools/node-v24.20.0-darwin-arm64/bin:$PATH`, `node v24.20.0`, `npm 11.19.0`, из `/Users/dmitriy/code/taskindex`, без изменений в репозитории.

| Команда | Результат |
|---|---|
| `npm ls --depth=0` | 41 верхнеуровневый пакет, ошибок peer/invalid нет, exit 0 |
| `npm ls undici` | `shadcn@4.18.0 → @dotenvx/dotenvx@1.75.1 → undici@7.29.1 deduped`, `shadcn → undici@7.29.1 overridden` |
| `npm ls --omit=dev --all --parseable \| wc -l` | 184 |
| `npx tsc --noEmit` | без вывода (0 ошибок), 2.0 с инкрементально; cold (`--incremental false --tsBuildInfoFile <scratch>`) 3.3 с |
| `npx oxlint src tests/unit tests/api tests/property tests/web tests/cli tests/e2e scripts/dev.mjs scripts/setup-dev.mjs` | без вывода, exit 0; контроль на scratch-файле с `any`/`var`: `error typescript(no-explicit-any)`, `error eslint(no-var)` — линтер работает |
| `npx oxfmt --check …` | `All matched files use the correct format. Finished in 82ms on 88 files` |
| `npx vitest run` | `Test Files 14 passed (14)`, `Tests 75 passed (75)`, `Duration 1.82s` |
| Пробный скрипт `node:sqlite` (scratchpad) | `bundled sqlite 3.53.4`; WAL/FULL применяются; экспорты `DatabaseSync,Session,StatementSync,backup,constants,default`; `DatabaseSync.backup` как метод отсутствует; импорт без ExperimentalWarning; `node --experimental-sqlite -e 1` → exit 0 |
| Пробный скрипт WAL (node:sqlite и better-sqlite3, `wal_autocheckpoint=0`) | 5× `UPDATE settings SET value=value` → `walDelta: 0, dataVersionDelta: 0`; 5× реальных `UPDATE … value\|\|'x'` → `walDelta: 20600, dataVersionDelta: 1` (обе библиотеки одинаково) |
| `node dist/cli/index.js --help` ×3 | real 0.08 / 0.05 / 0.06 с |
| Загрузка модулей | `zod` 19 мс, `+@hono/zod-openapi` 7 мс, `+hono/client` 1 мс |
| Анализ `dist/` | `index-C5sBns2A.js` 1 034 223 B / 294 201 gz; `index-vr3rlxsL.css` 109 217 / 19 923 gz; `dist/server/index.js` 89 413; `dist/cli/index.js` 22 851 + `domain-schemas-*.js` 24 270; `admin.js` 37 781; source map для веб-бандла отсутствует |
| Импорты зависимостей (grep по `src tests scripts deploy` и конфигам) | `date-fns` 0, `zod` 0 (прямых), остальные ≥1; `@base-ui/react` 16, `lucide-react` 15, `class-variance-authority` 4 |
| `node_modules/*/package.json` | `@hono/zod-openapi@1.6.3` peer `hono >=4.10, zod ^4`; `@asteasolutions/zod-to-openapi@9.1.0` peer `zod ^4`; `better-auth@1.7.3` peer opt. `better-sqlite3 ^12`, `drizzle-orm ^0.45.2`; `tsdown@0.23.0` engines `^22.18 \|\| ^24.11 \|\| >=26`; `better-sqlite3@12.11.1` engines `20–26.x`, бинарь `build/Release/better_sqlite3.node` Mach-O arm64; `@simplewebauthn/server@13.3.3`, `kysely@0.29.5`, `undici@7.29.1` установлены |
| `git status` | 10 `M`, 20 `??` (новое дерево), остальное `D` старого прототипа; `git log -8` — последний коммит `4b780e4` (docs) |

## (e) Что проверено и признано в порядке

- **Health-check не пишет в БД.** `UPDATE settings SET value=value` (`app.ts:178-180, 410-412`) выглядит как запись каждые 10 с (`compose.yml:34`), но измерение показало 0 байт WAL и неизменный `data_version` — SQLite не фиксирует транзакцию без изменённых страниц; при этом `SQLITE_READONLY` всё равно сработал бы. Нагрузки на Litestream от healthcheck нет.
- **Согласованность версий Node**: `.nvmrc` `24`, `.node-version` `24.20.0`, `engines >=24.11.0 <25`, `Dockerfile` `node:24.20.0-bookworm(-slim)`; нижняя граница объясняется `tsdown` (`^24.11.0`).
- **Zod 4 используется последовательно**: единый `z` (Zod 4 classic), `.describe()` на предметных полях (`schemas.ts`, `domain-schemas.ts`), `z.toJSONSchema` для `/api/context`; `@hono/zod-openapi 1.6.3` и `zod-to-openapi 9.1.0` официально требуют `zod ^4`.
- **SQLite-настройки**: `foreign_keys`, `journal_mode=WAL`, `synchronous=FULL`, `busy_timeout=5000` на каждом соединении (`db.ts:21-24`), включая admin-команды (тот же `openDatabase`); `transaction(...).immediate()` для всех записей; проверено тестом durability.
- **SSE и nginx-локация** — см. Y1.
- **Docker**: multi-stage, glibc (bookworm), non-root `node`, `tini`, `STOPSIGNAL SIGTERM`, `stop_grace_period 20s` против 10-секундного таймаута в `index.ts:49-53`; в рантайме `sqlite3` CLI только для ручных операций (бэкап делается через `db.backup()` better-sqlite3 в `database.mjs`).
- **Litestream**: 0.5.12 пиннут, `auto-recover: false`, retention 720h, socket для `sync -wait`, отдельный meta-path; процедуры quarantine/восстановления учитывают `-wal/-shm/-journal` и tracking-каталог (`database.mjs:99-111`).
- **Lockfile и пины**: точные версии, `package-lock.json` v3 согласован, `npm ls` чистый.
- **Тестовый стек по слоям** — см. Q1; `vitest.config.ts` включает все пять каталогов; Playwright — один воркер, `webServer` с изолированной SQLite в `/tmp`.
- **CLI**: аргументы парсятся своим кодом (`arguments.ts`, 104 строки) — `node:util.parseArgs` сделал бы то же, но это вкусовщина, не дефект; outbox с `link()`-публикацией и fsync каталога (`outbox.ts:100-131`) — аккуратно.
- **tsdown/tsx/oxfmt**, `scripts/dev.mjs` (`node --watch --import tsx`), `setup-dev.mjs` (`.env` с `0600`, `wx`) — без замечаний.
