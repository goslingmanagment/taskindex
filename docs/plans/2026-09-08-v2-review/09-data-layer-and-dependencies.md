# Слой данных и зависимости

Статус: предложение, 2026-09-08. Источник: сводное ревью v2 (см. `README.md` в этой папке).
Приоритет: P1 для шагов 1..3 (удаление `date-fns`, вынос CSS shadcn и снятие `overrides.undici`, `typeCheck` в oxlint: от них зависит план 08 и они занимают час), P2 для остального. Оценка: M, 1.5..2 дня без варианта «уход с Drizzle» (он оценён отдельно в §3, около 1 дня, и не рекомендуется сейчас). Зависимости: `05-auth-and-agent-keys.md` (первая миграция после baseline, на ней проверяется правило «перенос данных руками, схема через kit»), `06-server-structure-config-logging.md` (версия схемы из набора миграций), `01-performance-history-and-pagination.md` (`readEventsForOperation` для сборки `result.events`), `04-api-contract-and-schemas.md` (описание семантики `dryRun` и `S3` про `@hono/zod-openapi`), `08-styling-skin-and-dark-theme.md` (зависит от шага 2 этого плана), `11-deploy-and-ops.md` (Dockerfile в целом).

Пометки: **делать** означает решение принято ревью и не требует выбора; **решение владельца** означает развилку с рекомендацией.

## 1. Проблема

Все ссылки проверены по текущему дереву 2026-09-08.

### 1.1. Drizzle используется как маппер строк, мигратор свой, SQL правлен руками (D2)

- Весь Drizzle-код это `select().from(t).all()/get()`, `insert…onConflictDoUpdate`, `update`, `delete` с условиями только по `id` (`src/server/db.ts`, `src/server/admin.ts`, `src/server/auth.ts:54-65`). Ни одного JOIN, агрегата или условия по предметному полю; фильтрация и соединение в JS (см. `01-…md`).
- Миграции применяет собственный цикл (`db.ts:46-96`) с таблицей `__taskindex_migrations`; `drizzle/v2/meta/_journal.json` (одна запись) и `0000_snapshot.json` (33 900 байт) нужны только `npm run db:generate` и тесту `tests/api/migrations.test.ts:11-25` (снапшот ↔ `schema.ts`) и `:57-61` (журнал ↔ `__taskindex_migrations`).
- Дрейф: `drizzle/v2/0000_taskindex.sql:166` содержит `order_key text COLLATE BINARY NOT NULL`; `src/server/schema.ts:41` `orderKey: text('order_key').notNull()` и снапшот (0 вхождений `COLLATE`) об этом не знают. Тест `migrations.test.ts:103-106` проверяет `coll === 'BINARY'` у колонки индекса `tasks_order`, но `BINARY` это коллация SQLite по умолчанию, поэтому проверка проходит и без ручной правки. Следствие: правка ничего не меняет в поведении, но показывает, что SQL редактируется после генерации, и снапшот не источник правды. README (`README.md:67`) запрещает редактировать применённые миграции; при этом v2 ещё не в проде, baseline применён только к dev-базам и тестовым `:memory:`.
- Зачем Drizzle нужен сейчас: адаптер Better Auth (`auth.ts:2, 19` `drizzleAdapter(db.orm, { provider: 'sqlite', schema })`) и типизация JSON-колонок (`schema.ts:51-53` `ownerFields`, `:109-111` `result`, `:130` `changes` через `$type<…>()`). Better Auth умеет работать с `better-sqlite3` напрямую (peer `better-sqlite3 ^12.0.0` в `node_modules/better-auth/package.json`; `kysely@0.29.5` уже установлен как его зависимость), но тогда таблицы auth генерируются `@better-auth/cli generate`, а типизация строк пишется руками или через Zod на границе.

### 1.2. `node:sqlite` вместо `better-sqlite3` (D3)

- Используемые возможности better-sqlite3: `pragma()` (`db.ts:21-24`), `transaction(fn).immediate()` (шесть мест, см. `06-…md` §1.7), `prepare/exec`, синхронный `db.backup(path)` (`deploy/database.mjs:45, 89`), опции `readonly`/`fileMustExist` (`database.mjs:27, 76-79`), `pragma(...)` в тестах (`tests/api/durability.test.ts:19-20, 33`, `tests/api/migrations.test.ts:63, 84, 95, 109`).
- `node:sqlite` в Node 24.20.0 (проверено ревью 1): импорт без `ExperimentalWarning`, `DatabaseSync`, `StatementSync`, `Session`, модульная асинхронная `backup`, `constants`; `PRAGMA journal_mode=WAL` и `synchronous=FULL` работают; `@types/node@24.13.3` помечает модуль `@experimental` (`node_modules/@types/node/sqlite.d.ts:37`). Нет `.transaction()` (нужен ручной `BEGIN IMMEDIATE/COMMIT/ROLLBACK`), нет `.pragma()` (через `exec`/`prepare`), `backup` асинхронная функция модуля.
- Drizzle 0.45.2 драйвера для `node:sqlite` не имеет (в `node_modules/drizzle-orm` есть `better-sqlite3`, `bun-sqlite`, `durable-sqlite`, `expo-sqlite`, `op-sqlite`, `sqlite-proxy`, `libsql`, `d1`). Переход возможен только вместе с уходом от Drizzle.
- Цена нативного модуля сегодня: на машине владельца `better-sqlite3` не загружается под Node 26 (`BACKLOG.md`, «Обычный локальный запуск использует несовместимый Node 26»); в образе нужен toolchain `python3 make g++` (`deploy/Dockerfile:3`) и пин `node:24.20.0-bookworm`.

### 1.3. События хранятся дважды (Ж1)

`src/server/operations.ts:161-170` собирает `body` успешной операции с полным массивом `events` и сохраняет его в `operations.result` (`:184`), те же события пишутся в `events` (`:173-174`). Каждое событие несёт `changes` с `from`/`to` (для правки заметки это две копии текста до 16 000 символов), поэтому журнал занимает вдвое больше места, а `readOperations` парсит `result` каждой операции ради `taskCount`/`titles` (`db.ts:244-252`). `validateExport` (`admin.ts:347-350`) сверяет `result.events` с журналом, то есть дублирование уже воспринимается как избыточность, требующая проверки.

### 1.4. `dryRun` входит в `command_hash` (Ж4)

`operations.ts:49-50` хеширует `canonical(envelope)` целиком, включая `dryRun`. Пробный прогон с `operationId` уже исполненной операции даёт `409 operation_mismatch` (`:71-75`) вместо сохранённого результата; обратная ситуация безвредна, потому что dry-run не сохраняется (`:135`, `:171`). Поведение не документировано ни в `skills/taskindex/SKILL.md`, ни в `/api/context.rules` (`app.ts:897-905`).

### 1.5. Ветвление по `EntityKind` руками (Ж11)

`EntityKind` (`task | project | comment`) разбирается вручную: `src/shared/commands.ts:55-61` (`isSubjectField`), `:112-118` (`records`), `:387/422/453` (диспетчеризация по префиксу имени команды), `:669-691` (`applyEvent`, ветка комментария); `src/server/db.ts:118-147` и `:165-234` (три блока чтения и записи); `src/server/admin.ts:295-300` (выбор списка в `validateExport`), `:380-394` и `:408-423` (порядок таблиц при импорте); `src/shared/domain-schemas.ts` (`entitySchema` union и `entityKind` enum в `eventSchema`). Новая сущность (вложения или ссылки, `BACKLOG.md` «За пределами первой версии») потребует правок во всех местах без проверки полноты компилятором.

### 1.6. Два формата времени (Ж12)

Домен хранит моменты ISO-текстом (`schema.ts:24-25, 55-56, 89-90, 97, 114, 122`), таблицы Better Auth хранят `integer` в миллисекундах (`schema.ts:9` хелпер `time()`, `:146-147, 151-154, 175-176, 182-184, 198`). Экспорт (`admin.ts:207-230`) таблицы auth не включает, но `deploy/database.mjs inspect` и любая аналитика по физической копии должны это знать.

### 1.7. Смена `generation` только ручная (Ж13)

Поколение меняют только `markRestored` (`admin.ts:450-463`) и `importWorkspace` (`:446`). Приложение не распознаёт подменённый файл базы: если оператор восстановит копию вручную без `mark-restored`, открытые вкладки и агенты продолжат применять события расходящегося журнала под тем же поколением (предположение ревью 2; подтвердить можно только ручным сценарием). Процедуры `deploy/README.md` («Восстановление», шаг 3) требуют `mark-restored`, но приложение это не проверяет.

### 1.8. Зависимости и сборка (Z2, F2, T1, P2)

- `date-fns@4.1.0` в `dependencies` (`package.json:38`), импортов в `src`, `tests`, `scripts` нет (grep пуст); он лишь опциональный peer `@base-ui/react`.
- `shadcn@4.18.0` в `devDependencies` (`package.json:62`), но `src/web/styles.css:3` `@import 'shadcn/tailwind.css'` тянет `node_modules/shadcn/dist/tailwind.css` (16 041 байт) в сборку Vite, поэтому CLI-инструмент стал зависимостью сборки (`Dockerfile:5` ставит dev-зависимости именно ради этого). `overrides.undici: 7.29.1` (`package.json:71-73`) существует только ради ветки `shadcn → @dotenvx/dotenvx → undici` (`npm ls undici`: единственный потребитель `shadcn@4.18.0`). План 08 (скин и тёмная тема) правит именно этот CSS-слой, ему нужен файл в репозитории.
- `.oxlintrc.json:20-23` `typeAware: true, typeCheck: true` (экспериментальная проверка типов oxlint) при том, что `npm run check` (`package.json:13`) уже запускает `tsc --noEmit` (`:14`). Одна и та же работа дважды.
- `deploy/Dockerfile:9` `npm prune --omit=dev --omit=optional`: снимает optionalDependencies у всех рантайм-пакетов. Сегодня drill проходит, значит нужных опциональных модулей нет; при обновлении зависимостей флаг может тихо убрать платформенный модуль, который появится как optional.

## 2. Цель и критерии приёмки

1. `package.json`: нет `date-fns`, нет `shadcn` в зависимостях, нет `overrides`; `npm ls` без `invalid/extraneous/missing`; `npm ls undici` не находит пакет в дереве или находит только через другие пути (тест-страж на манифест).
2. `src/web/vendor/shadcn-base.css` содержит скопированный `tailwind.css` из `shadcn@4.18.0` с заголовком (источник, версия, sha256), `styles.css` импортирует его относительным путём; `npm run build` даёт тот же CSS-бандл по содержанию (сравнить `dist/web/assets/index-*.css` до и после: размер отличается не больше чем на длину заголовка).
3. `npm run lint` не выполняет проверку типов (`typeCheck: false`), `tsc` остаётся в `check`; время `npm run lint` уменьшилось (зафиксировать до/после в PR).
4. `Dockerfile` использует `npm prune --omit=dev`; drill зелёный.
5. Решение по Drizzle зафиксировано в этом файле (§3) и в плане §2 (`2026-09-08-taskindex-v2.md:59`); дрейф SQL ↔ снапшот устранён (решение владельца о способе, §3); `drizzle/v2/README.md` описывает, что генерируется, что правится руками, что не трогается.
6. `operations.result` хранится без `events`; `GET /api/operations/{id}`, повтор операции по `operationId` и экспорт отдают `result.events` в прежней форме (тесты); размер строки `operations.result` для команды с заметкой 1 КБ не содержит текста заметки (`json_extract(result, '$.events') IS NULL`).
7. `dryRun: true` с `operationId` уже исполненной операции возвращает сохранённый результат (или, при обратном решении владельца, поведение задокументировано в `SKILL.md` и `context.rules`; тест закрепляет выбранное).
8. Реестр сущностей в `src/shared/entities.ts` покрывает все `EntityKind` (проверка `satisfies Record<EntityKind, …>` и рантайм-тест); `records`, `isSubjectField`, `entitySchema` и порядок таблиц импорта берутся из него.
9. Ж13: при запуске сервера расхождение `settings.generation` с сайдкаром рядом с базой даёт запись `warn` в лог (первый этап) и, после решения владельца, отказ старта.
10. `npm run check`, `npm run e2e`, `bash deploy/local-drill.sh` зелёные.

## 3. Решение

### D2. Drizzle: оставить как источник схемы и типизированный маппер, не как движок запросов (решение владельца; рекомендация ниже)

| Вариант | Плюсы | Минусы | Рекомендация |
|---|---|---|---|
| (а) Drizzle только как источник схемы + `drizzle-kit generate` + типизированные строки; предметные чтения через `db.sqlite.prepare(...)` там, где нужны индексы (как уже сделано для `latestSeq`, `migrate`, `/health`) | Ничего не ломается; снапшот и тест `migrations.test.ts:11-25` продолжают ловить дрейф схемы; Better Auth остаётся на адаптере; план 01 добавляет SQL-запросы точечно | Две библиотеки в рантайме (`drizzle-orm`) и на сборке (`drizzle-kit`, снапшот 34 КБ); собственный мигратор рядом с чужим журналом | **Рекомендуется** сейчас |
| (б) Убрать Drizzle: Better Auth на `better-sqlite3` напрямую, таблицы auth через `@better-auth/cli generate`, все чтения `prepare`, типы строк руками или Zod на границе | Минус две зависимости и снапшот; путь к `node:sqlite` открывается | Около 1 дня работы; теряется триангуляция снапшот ↔ схема ↔ база; типы JSON-колонок писать руками; ручные `CREATE TABLE` для auth при обновлениях Better Auth | Отложить до момента, когда `node:sqlite` станет целью (D3) |

Дрейф `COLLATE BINARY` (решение владельца): (1) **рекомендуется** убрать `COLLATE BINARY` из `drizzle/v2/0000_taskindex.sql:166` до рабочего переключения: `BINARY` это коллация по умолчанию, поведение не меняется, файл совпадает с выводом kit, тест `migrations.test.ts:103-106` продолжает проверять фактическую коллацию индекса; правило «применённые миграции не редактируются» пока не нарушается, потому что рабочих баз нет, а dev-базы пересоздаются `npm run setup:dev`. (2) Альтернатива: оставить и записать в `drizzle/v2/README.md` как документированное исключение. Вариант (1) предпочтителен, потому что после переключения он станет недоступен.

Правило для будущих миграций (обязательное, закрепить в `drizzle/v2/README.md`): схема меняется только в `schema.ts` → `npm run db:generate`; перенос данных (`INSERT … SELECT`, `UPDATE`) дописывается в тот же файл вручную между сгенерированными операторами и помечается комментарием `-- data migration (hand-written)`; снапшот и журнал руками не трогаются; тест снапшота гарантирует, что DDL совпадает со схемой. Первый пример: `0001_agent_keys.sql` из плана 05.

### D3. `node:sqlite`: не сейчас (решение владельца; рекомендация «после D2(б) и стабилизации типов»)

Что потребуется: заменить `openDatabase` (`db.ts:17-27`) на `DatabaseSync` с `exec('PRAGMA …')`; хелперы `withWrite/withRead` из плана 06 реализовать через `BEGIN IMMEDIATE/COMMIT/ROLLBACK` с обработкой исключений (better-sqlite3 делает это внутри `.transaction()`); `deploy/database.mjs` перевести на модульную `backup()` (асинхронная) и опции `readOnly` (`fileMustExist` заменить явной проверкой `access`); тесты `pragma(...)` переписать на `prepare('PRAGMA …').get()`; убрать `better-sqlite3`, `@types/better-sqlite3`, toolchain из `Dockerfile:3`. Что блокирует сегодня: Drizzle без драйвера (D2), `@experimental` в типах Node 24 (Stability 1.1), меньшая зрелость по сравнению с better-sqlite3. Что даст: снятие ABI-зависимости от версии Node (закрывает пункт BACKLOG про Node 26 иначе, чем пином), образ без компиляции. Переоценить, когда `node:sqlite` потеряет пометку `@experimental` в `@types/node` для используемой LTS-ветки.

### Ж1. Не хранить события внутри `result` (делать, P2)

Хранить в `operations.result` для успешной операции `{ ok, operationId, generation, firstSeq, lastSeq, results }` без `events`; при чтении собирать `events` через `readEventsForOperation(db, id)` (план 01, шаг 2; до него через `SELECT … WHERE operation_id = ? ORDER BY seq`) и добавлять `generation`. Для отклонённых операций `result` без изменений. Контракт клиентов не меняется: `storedOperationSchema.result` по-прежнему `operationResponseSchema` с `events`. Миграции данных до переключения не нужно; если данные уже есть, одноразовый `UPDATE operations SET result = json_remove(result, '$.events') WHERE json_type(result, '$.events') IS NOT NULL` в очередной миграции.

### Ж4. `dryRun` исключить из хеша (решение владельца; рекомендуется)

Хешировать конверт без `dryRun`: пробный прогон с известным `operationId` возвращает сохранённый результат операции (что уже произошло), а не `operation_mismatch`. Это согласуется с идемпотентностью «тот же id → тот же ответ» и полезно агенту, который потерял ответ и проверяет исход через `--dry-run`. Альтернатива: оставить и задокументировать в `SKILL.md`/`context.rules`: «`--dry-run` с использованным `operationId` даёт `operation_mismatch`». Семантику записать в `04-…md`.

### Ж11. Реестр сущностей: общая часть сейчас, серверная при появлении новой сущности (решение владельца)

`src/shared/entities.ts`: `ENTITY_KINDS = ['task', 'project', 'comment'] as const`; `entities: Record<EntityKind, { collection: keyof WorkspaceState; subjectFields: ReadonlySet<string>; schema: ZodType }>`; `records(state, kind)` и `isSubjectField(kind, key)` в `commands.ts:55-61, 112-118` берут данные из реестра; `entitySchema` и `entityKind` enum в `domain-schemas.ts` строятся из `ENTITY_KINDS`; `admin.ts:295-300` использует `entities[kind].collection`. Серверный реестр таблиц (`toRow/fromRow`, порядок импорта) откладывается до реальной новой сущности: без неё это абстракция с одним потребителем. Диспетчеризация по имени команды (`commands.ts:387/422/453`) и `switch` с `assertNever` относятся к R1 в `10-…md`.

### Ж12. Оставить, задокументировать (не делать)

Таблицы Better Auth принадлежат библиотеке, их формат менять нельзя. Новые собственные таблицы (например `agent_keys` из плана 05) хранят ISO-текст. Записать в `deploy/README.md` (раздел «Восстановление») одну фразу: «в физической копии таблицы `user/session/account/verification/passkey` хранят время как integer в миллисекундах, домен как ISO-8601».

### Ж13. Сайдкар поколения (решение владельца; рекомендуется в два этапа)

`migrate`, `markRestored`, `importWorkspace` пишут файл `<DATABASE_PATH>.generation` с текущим `generation` (атомарно через временный файл и `rename`). При старте сервера `assertGeneration(db, path)`: если файл есть и не совпадает с `settings.generation`, этап 1: `logger.warn({ event: 'generation_sidecar_mismatch', … })`; этап 2 (после подтверждения на drill): `fail('unavailable', 'Файл базы заменён без mark-restored.')` и выход до открытия порта. `deploy/database.mjs quarantine-and-install` (`:99-111`) переносит сайдкар в карантин вместе с `-wal/-shm`; после `mark-restored` файл пересоздаётся. Для `:memory:` и тестов проверка пропускается. Альтернатива «не делать»: полагаться на процедуру README и `deploy/.runtime/current.json`. Рекомендация: этап 1 сейчас (дёшево, ничего не ломает), этап 2 после одного квартального drill.

### Z2, F2, T1, P2 (делать)

Удалить `date-fns`; скопировать CSS shadcn в репозиторий и снять `shadcn` с `overrides`; `typeCheck: false`; `--omit=dev` без `--omit=optional`. Компоненты shadcn при необходимости добавляются `npx shadcn@latest add …` без установки в проект; `components.json` остаётся для этого сценария.

## 4. Шаги

Шаги 1..3 первыми (час работы, разблокируют план 08). Дальше по приоритету; каждый шаг заканчивается `npm run check`.

1. Зависимости: `package.json` удалить `"date-fns"` (`:38`) и `"shadcn"` (`:62`), удалить блок `overrides` (`:71-73`); `npm install` в worktree обновляет `package-lock.json`; `npm ls`, `npm ls undici`. Проверка: `npm run build` и `npm run check` зелёные; тест-страж (раздел 5, п. 1).

2. Вынос CSS: `mkdir src/web/vendor`; `cp node_modules/shadcn/dist/tailwind.css src/web/vendor/shadcn-base.css` до удаления пакета (или взять из `npx shadcn@4.18.0` кэша); в начало файла комментарий `/* Vendored from shadcn@4.18.0 dist/tailwind.css, sha256 <hex>, 2026-09-08. Do not edit; replace whole file to upgrade. */`; `src/web/styles.css:3` → `@import './vendor/shadcn-base.css';`. Если `oxfmt --check` (`package.json:17`) начнёт форматировать этот CSS, добавить `src/web/vendor/**` в игнор форматтера (`.oxfmtrc.json`, `ignorePatterns`) и в `.oxlintrc.json:24-32`. План 08 дальше работает с этим файлом. Проверка: `npm run build`; сравнить `dist/web/assets/index-*.css` до и после (размер и набор селекторов, например `grep -c '{'`), e2e-скриншоты `tests/e2e/workspace.spec.ts` без изменений.

3. `.oxlintrc.json:22` `"typeCheck": false` (оставить `"typeAware": true`). Проверка: `npm run lint` на контрольном файле с `any` по-прежнему ругается (`typescript/no-explicit-any` не требует typeCheck); замерить `time npm run lint` до/после и записать в PR.

4. `deploy/Dockerfile:9`: `npm run build && npm prune --omit=dev`. Проверка: `bash deploy/local-drill.sh`; сравнить размер образа (`docker images`) до/после, ожидание в пределах нескольких мегабайт.

5. Дрейф SQL: по решению владельца либо убрать `COLLATE BINARY` из `drizzle/v2/0000_taskindex.sql:166`, либо оставить. В обоих случаях создать `drizzle/v2/README.md`: назначение каталога; что генерируется (`*.sql` DDL, `meta/*`); правило переноса данных руками с маркером; запрет правки применённых миграций после рабочего переключения; список того, что проверяет `tests/api/migrations.test.ts`; ссылка на `06-…md` про версию схемы. В `docs/plans/2026-09-08-taskindex-v2.md:59` заменить «Drizzle ORM в рантайме» на «Drizzle как источник схемы и типизированный маппер; предметные запросы через подготовленные SQL по индексам». Проверка: `tests/api/migrations.test.ts` зелёный.

6. Ж1: `src/server/operations.ts:161-190`: сохранять `result` без `events` (`const { events: _e, ...stored } = body`), в ответе HTTP по-прежнему полный `body`; повтор (`:76-81`) собирает `body: { ...old.result, events: readEventsForOperation(db, id) }` для `ok: true`; `db.ts` `readOperation`/`readOperationsPage` (план 01) и `exportWorkspace` (`admin.ts:227`) добавляют `events` тем же способом; `readOperations` для `taskCount`/`titles` берёт id из собранных событий (или, дешевле, из `SELECT DISTINCT entity_id, task_id FROM events WHERE operation_id IN (…)`); `validateExport` (`admin.ts:339-350`) сверяет собранные события с журналом как сейчас (проверка остаётся: она ловит рассинхрон `first_seq/last_seq` и границ). Проверка: тесты раздела 5, п. 5..6; `tests/api/durability.test.ts:35` (`toEqual(first.body)`) зелёный.

7. Ж4 (по решению владельца): `operations.ts:50` хешировать `canonical({ ...envelope, dryRun: undefined })`; описать в `04-…md` и `SKILL.md`. Проверка: тест раздела 5, п. 7.

8. Ж11: `src/shared/entities.ts` по §3; `commands.ts:39-61, 112-118` и `domain-schemas.ts` (`entitySchema`, `eventSchema.entityKind`, `operationErrorSchema.conflicts[].entityKind`) переходят на реестр; `admin.ts:295-300` тоже. Проверка: `tests/unit/shared.test.ts` (новый кейс), property-тесты без изменений.

9. Ж13, этап 1: `src/server/db.ts` `writeGenerationSidecar(path, generation)` вызывается из `migrate` (`:89-90`, при создании поколения и при каждом запуске миграций), `admin.ts markRestored` (`:455`) и `importWorkspace` (через `markRestored`); `src/server/index.ts` после `openDatabase` вызывает `checkGenerationSidecar(db, path, logger)` (для `:memory:` пропуск). `deploy/database.mjs:99-105`: добавить `${source}.generation` в список переносимых в карантин файлов. `deploy/README.md` («Восстановление», шаг 2..3): упомянуть файл. Этап 2 отдельным решением после drill. Проверка: тест раздела 5, п. 9; drill (после `quarantine-and-install` и `mark-restored` сайдкар совпадает).

10. Ж12: одна фраза в `deploy/README.md` (раздел «Восстановление»). Без кода.

## 5. Тесты

| # | Файл | Сценарий | Ожидание |
|---|---|---|---|
| 1 | `tests/unit/manifest.test.ts` (новый) | прочитать `package.json` и `src/web/styles.css` | нет ключей `dependencies.date-fns`, `devDependencies.shadcn`, `overrides`; `styles.css` не содержит `@import 'shadcn/`; `src/web/vendor/shadcn-base.css` существует и начинается с комментария `Vendored from shadcn@` |
| 2 | сборка (вручную, в PR) | `npm run build` до и после шага 2 | размер `dist/web/assets/index-*.css` отличается не больше чем на длину заголовка; число правил одинаково |
| 3 | `npm run lint` (вручную) | до/после `typeCheck: false`; контрольный файл в scratchpad с `let x: any` | линтер ругается на `no-explicit-any`; время выполнения снизилось (цифры в PR) |
| 4 | `tests/api/migrations.test.ts` (существующий) | после правки baseline (если выбран вариант 1) | зелёный; `coll === 'BINARY'` у `order_key` в `tasks_order` |
| 5 | `tests/api/commands.test.ts` (новый кейс) | `task.create` с заметкой 1 000 символов, затем `SELECT json_extract(result, '$.events') AS e, LENGTH(result) AS n FROM operations WHERE id=?` | `e` равно `null`; `n` меньше 500; `GET /api/operations/{id}` отдаёт `result.events` длиной 1 с `changes.note.to` равным заметке; повтор того же конверта → тело `toEqual` первому ответу |
| 6 | `tests/api/recovery-and-history.test.ts:164-…` «validates all redundant backup data…» и `commands.test.ts:703` (существующие) | экспорт/импорт по кругу с событиями, собранными из журнала | зелёные; порча `events[0].lastSeq` по-прежнему отклоняется |
| 7 | `tests/api/commands.test.ts` (новый кейс) | `task.create` с `operationId: 'x'`; затем тот же конверт с `dryRun: true` | при выбранном варианте: 200 и тело равно сохранённому результату; при альтернативе: 409 `operation_mismatch` и тест закрепляет это |
| 8 | `tests/unit/shared.test.ts` (новый кейс) | `Object.keys(entities)` против `eventSchema.shape.entityKind.options`; `isSubjectField` для каждого вида против прежних наборов | совпадают; `tsc` падает при добавлении вида в `ENTITY_KINDS` без записи в реестре (`satisfies`) |
| 9 | `tests/api/generation-sidecar.test.ts` (новый) | файловая база в `mkdtemp`: `migrate` создаёт `<db>.generation` с текущим поколением; `markRestored` обновляет; запись в файл чужого значения → `checkGenerationSidecar` с логгером-сборщиком | запись `level:'warn'`, `event:'generation_sidecar_mismatch'`; для `:memory:` вызов ничего не делает и не бросает |
| 10 | `bash deploy/local-drill.sh` (вручную) | полный прогон после шагов 4 и 9 | зелёный; после `quarantine-and-install` каталог карантина содержит `taskindex.db.generation`; после `mark-restored` новый сайдкар совпадает с `/health.generation` |

## 6. Риски и откат

- Вынесенный CSS перестанет обновляться вместе с shadcn. Это осознанно: файл 16 КБ, обновление это замена целиком (`npx shadcn@<версия>` и копирование), заголовок хранит версию и хеш. Откат: вернуть зависимость и `@import 'shadcn/tailwind.css'`.
- Снятие `overrides.undici` возможно только вместе с удалением `shadcn`; если `shadcn` понадобится как зависимость снова, вернуть и override. Тест-страж напомнит.
- `typeCheck: false`: oxlint перестанет сообщать диагностику компилятора вместе с lint-ошибками; `tsc` в `check` остаётся. Никаких новых пропусков: правила `typescript/*` категории `correctness` работают через `typeAware`.
- `--omit=optional`: если у какого-то рантайм-пакета появится нужный optional-модуль, он теперь установится; риск обратный (лишние платформенные пакеты) ограничен drill и размером образа.
- Ж1 меняет форму сохранённых `result`: старые строки (если есть) содержат `events`, новый код их игнорирует и собирает из журнала; повтор операции остаётся детерминированным, потому что события операции неизменны. Откат: revert, старые и новые строки читаются одинаково.
- Ж4 меняет ответ на редкий сценарий; если у агентов уже есть логика на `operation_mismatch` для dry-run, она не сработает. До переключения агентов нет.
- Ж11: перенос `records`/`isSubjectField` в реестр может изменить порядок полей или наборов; property-тесты `tests/property/*` и `tests/unit/shared.test.ts` ловят расхождения.
- Ж13 этап 2 (отказ старта) способен остановить сервис после ручного восстановления без `mark-restored`; это и есть цель, но этап 2 включать только после drill, чтобы процедуры README были проверены с сайдкаром.
- Правка baseline `0000_taskindex.sql` допустима только до рабочего переключения; после него дрейф фиксируется как документированное исключение.

## 7. Вне объёма

- Индексированные чтения событий, `readEventsForOperation`, `readOperationsPage`, keyset-пагинация: `01-performance-history-and-pagination.md`.
- Таблица `agent_keys` и первая миграция с переносом данных: `05-auth-and-agent-keys.md` (здесь только правило оформления таких миграций).
- Версия схемы из набора миграций, `config.ts`, разрез `app.ts`: `06-server-structure-config-logging.md`.
- `@hono/zod-openapi` как единственный источник `z` в shared/web/CLI (S3), решение об OpenAPI и `zod/mini` для браузера (F3): `04-api-contract-and-schemas.md` и `07-web-client-fixes-and-structure.md`.
- Скин, тёмная тема и правки вынесенного CSS: `08-styling-skin-and-dark-theme.md`.
- `applyCommand` через `switch` с `assertNever`, генерация `commandSchema` из `commandPayloadSchemas`, `shared/canonical-json.ts`: `10-code-quality-and-tests.md` (R1, R2).
- Nginx, HSTS, сборка образа вне VPS (P1, P3): `11-deploy-and-ops.md`.
- Постоянный Node 24 на машине владельца (пункт BACKLOG): `12-ai-readiness-and-docs.md` (`CLAUDE.md`, `scripts/preflight.mjs`).

## Покрытые находки

| ID | Отчёт | Кратко | Где в плане |
|---|---|---|---|
| D2 | 1 (стек) | Drizzle как маппер, свой мигратор, `COLLATE BINARY` руками | §1.1, §3 D2 (решение владельца, рекомендация (а) + убрать `COLLATE`), шаг 5 |
| D3 | 1 | `node:sqlite` вместо better-sqlite3 | §1.2, §3 D3 (не сейчас, условия переоценки) |
| Ж1 | 2 (архитектура) | События дублируются в `operations.result` | §1.3, шаг 6, тесты 5..6 |
| Ж4 | 2 | `dryRun` в `command_hash` | §1.4, §3 Ж4 (решение владельца), шаг 7, тест 7 |
| Ж11 | 2 | Ветвление по `EntityKind` в ~8 местах | §1.5, §3 Ж11, шаг 8, тест 8 |
| Ж12 | 2 | Два формата времени | §1.6, §3 Ж12 (не делать, документировать), шаг 10 |
| Ж13 | 2 | Смена `generation` только ручная | §1.7, §3 Ж13 (сайдкар, два этапа), шаг 9, тест 9 |
| Z2 | 1 | `date-fns` не используется; `zod` только через `@hono/zod-openapi` | шаг 1 (`date-fns`); `zod`/S3 в `04-…md` |
| F2 | 1 | `shadcn` как зависимость сборки и причина `overrides.undici` | §1.8, шаги 1..2, тесты 1..2; зависимость плана 08 |
| T1 | 1 | oxlint `typeCheck` дублирует `tsc` | §1.8, шаг 3, тест 3 |
| P2 | 1 | `npm prune --omit=optional` в Dockerfile | §1.8, шаг 4, тест 10 |
| quality §10 «`date-fns` в dependencies», Z2 про `@types/better-sqlite3@9.6.0` | 4, 1 | лишняя зависимость; отставание типов по major при зелёном `tsc` | шаг 1; типы better-sqlite3 оставить, проверять при обновлении `better-sqlite3` |
| Astra S-03 | astra / TI-013 | мигратор хранит имена применённых файлов без контрольных сумм | шаг 11; интерфейс `assertSchema` в плане 06 |
| Astra A-03 | astra / TI-014 | миграция данных без событий ломает строгий импорт; нет фикстуры прежней версии | шаг 12; перезагрузка клиента в плане 04 |
| Astra S-07 | astra / TI-024 | `date-fns` не используется | шаг 1 (совпало с Z2) |
| Astra `docs/audits/2026-09-08-multiside-review/01-stack.md` «Компромиссы» п. 3 | astra / TI-073 | дублирование событий в `result` как осознанная цена | §3 Ж1; шаг 13 (замер до шага 6) |
| FA:V7 снят | сверка / TI-075 | «`/health` пишет в базу» не подтверждено | не в этом плане; план 06 §1.5 |

## Сверка с ревью Astra (2026-09-08)

Кратко: Astra добавила два пункта по слою данных, которых у нас не было. S-03 (`astra-13-migration-checksums.md`, реестр TI-013): `__taskindex_migrations(name TEXT PRIMARY KEY)` (`src/server/db.ts:69-71`), применённые миграции сверяются только по именам (`:72-88`), содержимое применённого файла не проверяется; `tests/api/migrations.test.ts` сверяет снапшот со `schema.ts` и имена с журналом, но не содержимое с базой. A-03 (`astra-14-domain-contract-evolution.md`, TI-014): `applyEvent` собирает запись только из `changes`, поэтому любое поле, появившееся в таблице без события (миграция данных, новая колонка с default), делает replay неравным таблицам, и `validateExport` отказывает («состояние записей не совпадает с журналом событий», `src/server/admin.ts:354-360`); импорт дополнительно требует точного `schema_version` (`:369-373`); probe воспроизведён при сверке. Наши V6/B4 (константа версии, план 06) и Ж11 рядом, но не закрывают. Совпало: S-07 равен Z2 (`date-fns`); Drizzle оставить и использовать точные запросы (это D2, вариант (а); `ASTRA-VS-FABLE.md` §4.3 согласна и считает `node:sqlite` возможной последующей альтернативой, не обязательной). По Ж1 позиции расходятся: Astra считает «события + проекция + сохранённый ответ» осознанной ценой (`docs/audits/2026-09-08-multiside-review/01-stack.md:152`), реестр TI-073 (РЕШЕНИЕ, P3) требует замера. V7 (TI-075) снят и в этом плане не фигурирует (план 06 §1.5). По Ж4 и Ж13 `ASTRA-VS-FABLE.md` §5: `dryRun` в хеше не считать багом автоматически (документировать или менять явно), это и есть решение владельца в §3; ручная подмена файла базы это обход runbook, не доказанный дефект, поэтому двухэтапный сайдкар соразмерен.

### Добавлено по итогам сверки
| Пункт | Источник Astra | Реестр | План Astra | Что делаем здесь / где делается |
|---|---|---|---|---|
| Контрольная сумма байтов каждой применённой миграции в журнале; отказ до записей при несовпадении; процедура baseline для баз без сумм | S-03 | TI-013 | `astra-13`, шаги 1-3, 5 | шаг 11 ниже; интерфейс `bundledMigrations`/`assertSchema` в плане 06 (дополнительный шаг 15) |
| Правило миграций данных (события или схемные значения по умолчанию в replay), фикстура экспорта прежней версии, тест upgrade → export → import → undo → повтор конверта | A-03 | TI-014 | `astra-14`, шаги 2, 3, 5 | шаг 12 ниже; перезагрузка клиента при смене версии в плане 04 (дополнительный шаг 15) |
| Не заводить версию для каждого DTO; минимальные границы совместимости | A-03 | TI-014 | `astra-14`, «Зависимости и границы» | согласие; шаг 12 это минимум |
| Ж1 как компромисс: сокращать только с сохранением старых ответов и политики A-03 | «Компромиссы» п. 3; `ASTRA-VS-FABLE.md` §5 | TI-073 | нет | шаг 13 ниже ставит шаг 6 за замером |
| `date-fns` удалить | S-07 | TI-024 | `astra-24` | уже шаг 1; без изменений |
| Drizzle оставить, читать точными запросами; `node:sqlite` позже | рекомендация S-01; `ASTRA-VS-FABLE.md` §4.3 | TI-064 | `astra-12` | §3 D2 (а) и D3 без изменений |
| Штатный мигратор Drizzle тоже нужно проверять на checksum | S-03 | TI-013 | `astra-13`, «Зависимости и границы» | §3 D2: собственный мигратор остаётся, хеши добавляются в него (шаг 11) |

### Расхождения и решение
- Ж1. Astra: не дефект, а осознанная цена точного повтора ответа; здесь шаг 6 убирает `events` из `result`. Реестр TI-073: сначала измерить, оставить допускается с обоснованием. Решение: шаг 6 выполняется только после замера (шаг 13) и с сохранением контракта: `result.events` собирается из журнала, старые строки с `events` читаются как есть. Это совпадает с оговоркой `ASTRA-VS-FABLE.md` §5.
- Baseline для S-03. Astra: не принимать произвольный текущий файл за историческую истину молча. До переключения существуют только dev-базы, которые пересоздаются `npm run setup:dev`, поэтому backfill сумм из файлов образа с одной записью `warn` допустим; после переключения backfill требует сверки с архивным SQL релиза, правило записывается в `drizzle/v2/README.md`.
- Объём A-03. `astra-14` шаг 1 разводит версию хранилища, версию формата экспорта, версию кодека событий и поколение. Здесь: `schema_version` (равна числу миграций, план 06), `formatVersion` экспорта (уже есть), версия кодека не вводится до первой реальной нужды; правило и фикстура достаточны, о чём предупреждает и сама Astra («избыточная версия каждого мелкого DTO усложнит проект»).
- Дрейф `COLLATE BINARY` и собственный мигратор: Astra дрейфа не нашла; решение D2 без изменений.

### Дополнительные шаги
11. S-03, контрольные суммы. `src/server/db.ts` `migrate` (`:69-88`): `CREATE TABLE IF NOT EXISTS __taskindex_migrations(name TEXT PRIMARY KEY NOT NULL, sha256 TEXT)`; для существующих таблиц без колонки `ALTER TABLE __taskindex_migrations ADD COLUMN sha256 TEXT` (проверка через `PRAGMA table_info`); строки с `sha256 IS NULL` заполняются хешем одноимённого файла образа с одной записью `logger.warn({ event: 'migration_checksum_backfilled', name })` (процедура baseline; после переключения backfill только по сверке с архивным SQL релиза, правило в `drizzle/v2/README.md`). Применение нового файла пишет `(name, sha256)`. До любого применения сравнивать каждую применённую строку с `bundledMigrations(dir)` из плана 06 (дополнительный шаг 15): неизвестное имя, отсутствующий файл или другой хеш → `fail('unavailable', 'Содержимое применённой миграции <name> изменено.')` до любой записи. Хеш: sha256 байтов файла с нормализацией `\r\n` в `\n`. `deploy/database.mjs inspect` печатает имена и хеши (желательно). Тесты `tests/api/migrations.test.ts`: (а) неизменённая цепочка идемпотентна (второй `migrate` ничего не делает); (б) временная копия `0000_taskindex.sql` с одним изменённым байтом → `migrate` отказывает до применения следующего файла, `assertSchema` отказывает при старте; (в) база, созданная прежним мигратором без колонки → backfill и одна запись `warn`; (г) имена по-прежнему совпадают с `_journal.json`.
12. A-03, правило и фикстура. `drizzle/v2/README.md` (шаг 5): «Миграция, меняющая предметные таблицы или их значения, либо (а) выражена событиями системной операции `migration:<name>` (записи в `events` и `operations` с `actorId: 'system'`), либо (б) сопровождается правкой `applyEvent`/`validateExport`, чтобы replay применял схемные значения по умолчанию для новых полей; в обоих случаях фикстура экспорта предыдущей версии `tests/fixtures/export-schema-<N>.json` проходит `migrate → export → validateExport → import → undo → повтор конверта`». Фикстуру создать сейчас из засеянной `:memory:` базы (create, edit, comment, checklist, sync с версией, undo, no-op, отказ, batch) через `exportWorkspace`. Тест `tests/api/migration-compat.test.ts`: импорт фикстуры в свежую базу на её версии схемы, применение оставшихся миграций, `exportWorkspace` → `validateExport` без ошибок → `importWorkspace` в другую свежую базу → `GET /api/operations/{id}` для каждой операции фикстуры равен её `result`, повтор одного конверта даёт то же тело. Первые потребители правила: `0001_agent_keys.sql` (план 05; auth-таблицы не экспортируются, проходит тривиально) и `operation_seq` (план 04, дополнительный шаг 11: формат экспорта получает поле, `formatVersion` поднимается, фикстура перегенерируется по правилу). Перезагрузка клиента при несовпадении `schemaVersion`: план 04, дополнительный шаг 15.
13. Ж1, гейт перед шагом 6. На бенчмарк-базе плана 01 (шаг 0, 2 000 задач и 4 000 операций) замерить `SELECT SUM(LENGTH(result)), SUM(LENGTH(json_extract(result, '$.events'))) FROM operations` и время `readOperations`; записать в `bench-baseline.json`. Шаг 6 выполнять только если доля `events` в `result` или стоимость чтения остаются существенными после плана 01 (шаг 5 уже перестаёт разбирать `result` для страницы); иначе дублирование сохраняется, обоснование записывается в карточку TI-073. В обоих случаях: старые строки с `events` читаются как есть, новые собираются из журнала.

## Решение владельца (2026-09-10, делегировано Fable)

- Drizzle остаётся источником схемы и слоя записи. Сначала точечные выборки по плану 01 и замер; решение об уходе на raw SQL или `node:sqlite` принимается только по цифрам после этого.
- Миграции: все три проверки в минимальной форме: контрольная сумма применённого SQL, версия схемы из цепочки миграций (план 06), правило «миграция данных либо через события, либо `validateExport` применяет default по схеме» с фикстурой экспорта прежней версии. Versioned codecs не вводятся.
- События в `result` операции (Ж1): сокращать только после замера (шаг 13).

2026-09-10 (A): доп. шаг 12 сделан — правило в `drizzle/v2/README.md`, фикстура `tests/fixtures/export-schema-2.json` (сгенерирована на коде версии 2 скриптом `export-schema-2.seed.mts`), тест `tests/api/migration-compat.test.ts` (старая база → `migrate` → `export` → `validateExport` → `import` → `GET /api/operations/{id}` → повтор конверта; импорт формата 1 напрямую). Отклонение: повтор конверта проверяется на мигрированной базе, не после импорта — импорт меняет `generation`, и старый конверт даёт 409 `generation_changed` по контракту. `formatVersion` экспорта поднят до 2 (`operationSeq`), формат 1 импортируется через `upgradeExport`. Миграция `0002_operation_seq.sql` собрана пересборкой таблицы (сгенерированный `ALTER TABLE … ADD … NOT NULL` SQLite не выполняет).

2026-09-10 (A): шаг 1 сделан частично, шаг 3 сделан. `date-fns` снят с `dependencies` (`npm ls` без invalid/extraneous/missing), страж `tests/unit/manifest.test.ts`. `shadcn` и `overrides.undici` оставлены: шаг 2 (вынос `dist/tailwind.css` в `src/web/vendor/shadcn-base.css`) — область владельца C, `src/web/vendor` в `v2-fixes` ещё нет; страж закрепляет их присутствие с комментарием, что делать после выноса. `.oxlintrc.json`: `"typeCheck": false` при `"typeAware": true`; `time npm run lint` до 0.98/0.91 c (user 3.96/3.97), после 0.80/0.76 c (user 3.10/3.14); контрольный файл с `any` и висящим промисом даёт те же два диагноза (`typescript/no-explicit-any`, `typescript/no-floating-promises`) в обеих настройках — type-aware правила не потеряны, отключён только повтор ошибок `tsc` (он остаётся в `npm run typecheck`).

2026-09-10 (A): гейт доп. 13 пройден, шаг 6 сделан. Замер `scripts/bench-journal.ts` на 4000 операций и 2000 задач до правки: `SUM(LENGTH(result))` = 18 431 147, из них `events` 9 458 468 (51,3 %); `readOperations(db)` 70,9 мс, `GET /api/operations/{id}` 64,6 мс, `GET /api/operations?limit=50` 69,1 мс. Доля половины таблицы не зависит от плана 01, поэтому дублирование сокращено. После правки: `SUM(LENGTH(result))` = 8 932 679 (−51,5 %), `json_extract(result, '$.events')` пуст; стоимость чтения та же (`readOperations` 65,3 мс) — её снимает шаг 5 плана 01. Отклонения от плана: (1) ожидание теста 5 `LENGTH(result) < 500` недостижимо — результат `task.create` несёт ещё `record` и `changes`, в которых заметка остаётся дважды; проверка заменена на `json_extract(result, '$.events') IS NULL` плюс сравнение с длиной полного тела; (2) импортированные строки сохраняют `result` из экспорта вместе с событиями: пересборка проставила бы им новое поколение восстановления, а `tests/api/migration-compat.test.ts` требует прежнюю форму; новые операции пишутся без событий. `db.ts` разделён на `sqlite.ts` (соединение, настройки, транзакции), `migrations.ts` (цепочка миграций) и `db.ts` (состояние, события, операции) с реэкспортом, чтобы уложиться в правило 400 строк плана 06.
