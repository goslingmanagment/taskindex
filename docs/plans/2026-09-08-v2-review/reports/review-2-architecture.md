# TaskIndex v2 — архитектурное ревью (реализация в рабочем дереве `main`, 2026-09-08)

Область: только архитектура — выбрана ли правильно, реализована ли так, как задумана, что можно сделать лучше. Все утверждения проверены по коду с указанием `файл:строка`; там, где вывод не подтверждён экспериментом, стоит пометка «предположение».

## (a) Вердикт

1. **Ядро архитектуры выбрано и реализовано правильно.** Одна чистая функция `applyCommand` (`src/shared/commands.ts:225`) исполняет команды и на сервере (`src/server/operations.ts:102`), и в клиенте для оптимистичного превью (`src/web/app/store.ts:89`); `applyEvent` (`commands.ts:658`) — единственный редьюсер событий и для store, и для проверки экспорта. Каждая операция — одна синхронная транзакция better-sqlite3 «данные + события + сохранённый ответ» (`operations.ts:51–198`), рассылка в SSE происходит строго после коммита (`src/server/app.ts:473–480`). Идемпотентность по `operationId` с проверкой актора и хеша конверта, `generation`+`seq`, буфер/догон на клиенте, outbox в CLI — всё это есть и покрыто тестами (75 Vitest + 8 Playwright, все зелёные на Node 24.20.0).
2. **Главный риск — стоимость исполнения команды растёт линейно с журналом событий.** Сервер на каждую команду читает *всё* состояние и *весь* журнал (`operations.ts:93–95`, `src/server/db.ts:118–164`), хотя план заявляет «events это журнал, а не источник для перестроения» и одновременно «события не сжимают и не удаляют». Замер: 14 мс/команда при 320 событиях → 32 мс при 2 020 → 65 мс при 5 020 (in-memory, заметки 1 КБ). Для системы, где агенты — основные операторы и генерируют события непрерывно, это потолок на горизонте месяцев, при этом индексы `events_entity_revision`/`events_operation` есть, но кодом не используются. Исправляется без смены модели.
3. **Второй риск — курсорная пагинация ломается любой записью в базу** (`app.ts:220`): курсор привязан к глобальному `latestSeq`, поэтому `taskindex tasks --all` одного агента получит 409, пока пишет другой. Для agent-first продукта это противоречит собственной цели.
4. `app.ts` (1072 строки) — god-module: роутинг, пагинация, SSE-хаб, сборка `context`/`digest`, auth-middleware и логирование в одном замыкании. Это не ломает работу, но делает SSE и пагинацию непроверяемыми без HTTP и мешает дальнейшему росту.
5. Остальное — важные, но локальные вещи: запись в БД на каждый запрос агента из-за Better Auth `verifyApiKey`, лог внутренних ошибок без stack, EventSource не пересоздаётся после фатального закрытия, `SCHEMA_VERSION` — ручная константа, не связанная с набором миграций.

## (b) Карта архитектуры, как она есть в коде

```
src/shared   model.ts (константы, типы через z.infer)  schemas.ts (Zod команд/конвертов)
             domain-schemas.ts (записи, события, ответы)  commands.ts (applyCommand/applyEvent/undo/sync/инварианты)
             queries.ts (Focus/поиск/фильтры)  errors.ts (DomainError→HTTP)
                 ▲ импортируется всеми; сам не импортирует ни node:, ни DOM (проверено grep)
src/server   db.ts (open/migrate/readState/writeState/readEvents/readOperations)
             operations.ts (executeOperation — единственная точка записи домена)
             app.ts (Hono/OpenAPI: middleware auth+Origin+held, все GET, POST commands, SSE, context, digest, focus)
             auth.ts (Better Auth + плагины api-key/passkey; authorizeRequest → Actor)
             admin.ts (owner/agents/keys/export/import/mark-restored/open-writes — только из CLI)
             index.ts (env, serve, статика, SIGTERM)
src/web      app/store.ts (WorkspaceStore: confirmed/pending/data, ingest/catchUp/submit/recover, outbox в localStorage)
             app/sync.ts (EventSource, таймер «сегодня», online)  app/drafts.ts (черновики, Web Locks, scope вкладки)
             app/api.ts (fetch→ApiError)  app/url.ts (History API)  lib/use-workspace.ts (useSyncExternalStore + команды редактора)
             app/{shell,sidebar,board,card,editor,dialogs,activity,overview}.tsx, ui/* (shadcn)
src/cli      run.ts (парсинг, маппинг на команды, пагинация --all/--follow)  client.ts (ApiClient: send/resume, hc только для 2 POST)
             outbox.ts (файл на операцию, link() как атомарная публикация, fsync)  admin-run.ts (импортирует server/db и server/admin напрямую)
```

Путь одной команды (`taskindex task update` или «Сохранить» в редакторе):

```
CLI: payload → Zod(commandPayloadSchemas) → outbox.put(конверт, fsync) → GET /api/context (за generation!) → POST /api/commands
UI:  applyCommand-превью → pending[] → localStorage taskindex/ops/<id> → POST /api/commands
        │
        ▼ app.ts:296 middleware: authorizeRequest (bearer→verifyApiKey→apikey.agent_id/scope | cookie→getSession),
        │   Origin для owner на не-GET, gate writes held/open (чтение settings.approved_deployment)
        ▼ app.ts:469 → executeOperation (operations.ts:51, transaction().immediate())
        │   0 generation == settings.generation           (54)
        │   1 SELECT operations WHERE id → повтор: actor? hash? → сохранённый ответ (60–82)
        │   2 readState(db) — ВСЕ tasks/items/comments/projects; readEvents(db) — ВСЕ события (93–95)
        │   3 applyCommand(state, cmd, {history:[...all, ...new]}) — structuredClone, assertMerge по history,
        │     order() по соседям колонки, emit → effects; assertInvariants(state) по всему состоянию
        │   4 writeState(diff по JSON.stringify) + INSERT events (+first/last_seq) + INSERT operations(result JSON)
        │   commit
        ▼ app.ts:477 subscribers(events) → SSE `id: gen:seq`; operationSubscribers → `event: operations`
        ▼ клиент: ingest() буферизует, применяет операцию целиком по [firstSeq..lastSeq], снимает pending; дыра → catchUp(/api/events)
        ▼ ответ HTTP → acknowledge → те же события в ingest (дедуп по seq)
```

## (c) Находки

### Критично

**K1. Каждая команда читает весь журнал событий и всё состояние; чтения `history`/`operations` тоже полные сканы.**
- Доказательства: `src/server/operations.ts:93` `const previous = readState(db)`, `:95` `const history = readEvents(db)` (без `since`/`limit`); `src/server/db.ts:148–164` `readEvents` → `SELECT * FROM events ... ORDER BY seq`; `db.ts:118–146` `readState` собирает чеклисты и `commentCount` вложенными `filter` (O(T×(I+C))); `app.ts:679` `/api/tasks/{id}/history` = `readEvents(db).filter(...)`; `app.ts:736` `/api/operations/{id}` = `readOperations(db).find(...)`, где `readOperations` (`db.ts:235–272`) парсит `result` JSON каждой операции и делает до 3 запросов заголовков на каждую. Индексы `events_entity_revision`, `events_operation` (`drizzle/v2/0000_taskindex.sql:93–94`) не используются ни одним запросом.
- Замер (scratchpad `bench-events.ts`, `:memory:`, 300 задач, заметки 1 КБ, обновления заметки): 320 событий/0,7 МБ `changes` → **14,0 мс** на команду; 2 020/4,1 МБ → **32,4 мс**; 5 020/10,2 МБ → **65,3 мс**. Рост линейный (~+10 мс на 1 000 событий такого размера). `readState` при 300 задачах/3 000 шагов/300 комментариев — 6,9 мс; `readEvents` при 620 событиях — 4,3 мс. На диске с `synchronous=FULL` к этому добавляется fsync.
- Почему важно: агенты — основной источник записей (sync источников, пакеты до 100 команд, комментарии-отчёты). Event loop один; пока исполняется 65-мс команда, не обслуживаются ни SSE, ни чтения. При 50 000 событий (год умеренной активности) это сотни миллисекунд на любую запись и на каждый `operation get` при восстановлении CLI. Компакции по плану нет («События в первой версии не сжимают и не удаляют», план §6).
- Рекомендация (в порядке цены): (1) заменить параметр `history: DomainEvent[]` в `CommandContext` на интерфейс доступа `{ forRecord(kind, id, afterRevision), forOperation(id), bySeq(seq) }` — `assertMerge` (`commands.ts:125–153`) и `undo` (`commands.ts:268–345`) используют ровно эти три выборки; сервер реализует их через существующие индексы, а батч дополняет свежими событиями операции. (2) `readState` — группировать items/comments по `taskId` через `Map` (устраняет квадрат, 10 строк). (3) Самое дешёвое и радикальное для одного процесса-писателя: держать проекцию состояния в памяти сервера и обновлять её `applyEvent` после каждого коммита (это и есть заявленный «единый редьюсер»); сбрасывать при смене `generation`/старте. Тогда `readState` уходит из горячего пути вовсе, а SQLite остаётся источником истины для рестарта. Компромисс: (3) требует дисциплины «все записи только через executeOperation» — она уже соблюдена (admin пишет только вне работы приложения). (4) `readOperations` — не парсить `result`, а хранить `task_count`/`titles` при записи операции либо считать их по `events_operation`.

### Важно

**V1. Пагинация инвалидируется любой записью в базу.**
- `app.ts:220–221`: `if (cursor.seq !== latestSeq(db) || cursor.fingerprint !== fingerprint) fail('conflict', ...)`. Курсор фиксирует глобальный `latestSeq`; запись комментария к другой задаче или `sync` другого агента → 409 на следующей странице. `fingerprint` — sha256 от `JSON.stringify(items)` всей выборки на каждый запрос (`app.ts:205–207`). Тест `tests/api/recovery-and-history.test.ts:79` закрепляет это как намеренное поведение.
- Следствие: `taskindex tasks --all` (`src/cli/run.ts:394–401`) и `activity --all` прерываются с exit 3 при параллельной активности; `SKILL.md` рекомендует именно `--all`. В UI «Активность» при каждом `seq` перечитывает страницы с нуля, «сохраняя глубину» (`src/web/app/activity.tsx:138–176`) — компенсация той же проблемы.
- Рекомендация: keyset-пагинация по стабильному ключу (`(orderKey,id)` для задач, `(createdAt,id)` для операций/комментариев, `seq` для истории) без привязки к `latestSeq`; `seq` отдавать информативно. «Замороженный» список оставить только там, где он нужен по смыслу (`digest`), и явно документировать. Компромисс: страницы могут содержать элемент дважды/пропустить при перемещении — для агента это безопаснее, чем 409 посреди обхода.

**V2. `app.ts` — god-module.** 1072 строки: middleware авторизации и Origin (`296–339`), лимиты тела (`340–371`), собственный движок курсоров `page()` (`196–244`), SSE-хаб с подписчиками и heartbeat (`183–185`, `752–866`), сборка `context` (`867–937`) и `digest` (`938–1011`), все маршруты. `subscribers`/`closers` — замыкания, тестируемые только через HTTP. Рекомендация: `sse.ts` (хаб с `publish(events)`/`notifyOperations()`/`closeAll()`), `paging.ts`, `context.ts`/`digest.ts`, `routes/*.ts`; `createApp` только собирает. Это упростит и K1 (кэш проекции живёт рядом с хабом).

**V3. Better Auth пишет в БД на каждую проверку ключа агента.**
- `src/server/auth.ts:51` `auth.api.verifyApiKey(...)` → в плагине `claimUsageInDatabase` всегда выполняет `adapter.update({... updatedAt: now})` (`node_modules/@better-auth/api-key/dist/index.mjs`, функция `claimUsageInDatabase`, блок `finalRow = await ctx.context.adapter.update(...)`). При `synchronous=FULL` это fsync на каждый GET агента, записи в WAL, которые Litestream реплицирует, и эти записи **обходят** gate `writes: held` (он проверяется после авторизации, `app.ts:305–320`). `taskindex events --follow` опрашивает раз в секунду (`run.ts:387–390`) → 1 запись/с в «закрытую» базу.
- Рекомендация: кэшировать результат `verifyApiKey` в памяти на 30–60 с по хешу токена (ключи отзываются через admin — инвалидация по TTL приемлема для одного владельца) или включить у плагина `secondary-storage` in-memory. Компромисс: отзыв ключа действует с задержкой TTL.

**V4. Внутренние ошибки логируются без сообщения и стека и объявляются retryable.**
- `app.ts:285` `console.error(JSON.stringify({ code: 'internal', error: error.name }))`; `:286–294` любой неизвестный `Error` → `503 unavailable retryable:true`. Детерминированный баг (например, исключение в `applyCommand` не-DomainError) заставит store сделать 4 попытки (`store.ts:346–363`), оставить конверт в localStorage/outbox навсегда и не даст диагностики в `docker logs`. Рекомендация: логировать `message`+`stack` (payload и так не пишется), для не-SQLITE ошибок отвечать `retryable:false` с новым кодом `internal`, чтобы клиенты завершали операцию.

**V5. Клиент не пересоздаёт EventSource после фатального закрытия.**
- `src/web/app/sync.ts:11` `if (next === identity && stream) return;` — `stream` остаётся не-null после того, как браузер перевёл его в `CLOSED` (ответ 401/5xx, неверный content-type, ошибка прокси — по спецификации EventSource в этих случаях не переподключается). `onerror` (`:22`) только ставит `connected=false`; дальше работает лишь `catchUp` раз в 60 с (`:43–47`). Тестов на реконнект нет (grep `EventSource|readyState` по `tests/` пуст). Рекомендация: в `onerror` проверять `stream.readyState === EventSource.CLOSED`, обнулять и переподключаться с backoff; `connect` вызывать по таймеру, а не только по `store.subscribe`.

**V6. `SCHEMA_VERSION` — ручная константа, не связанная с набором миграций.**
- `src/shared/model.ts:86` `SCHEMA_VERSION = 1`; мигратор (`db.ts:46–96`) применяет все `*.sql` из каталога и затем записывает `schema_version = SCHEMA_VERSION` (`:93`). Если добавить `0001_x.sql` и забыть поднять константу, старый образ пройдёт `assertSchema` (`db.ts:98–104`) на новой базе — ровно тот сценарий, который план §12 обещает исключать. Также рантайм-мигратор игнорирует `drizzle/v2/meta/_journal.json` и ведёт свою таблицу `__taskindex_migrations` — два описания одного набора (тест `tests/api/migrations.test.ts:11` сверяет метаданные Drizzle со схемой, но не с рантаймом). Рекомендация: версия схемы = имя последней миграции в бандле (или хеш отсортированного списка); `assertSchema` сравнивает с `__taskindex_migrations`. Константу удалить.

**V7. `/health` пишет в базу при каждом вызове.**
- `app.ts:410–412` `UPDATE settings SET value=value WHERE key='generation'` (и при старте `:178–180`); `dbWritable: true` захардкожен (`:418`). Docker healthcheck каждые 10 с (`deploy/compose.yml:34`) + опросы deploy → постоянные fsync и WAL-кадры для Litestream даже на простое. Рекомендация: пробная запись при старте и по `?probe=1`; в обычном health — `PRAGMA quick_check`-free чтение.

**V8. Три места хранения scope ключа и открытые HTTP-маршруты плагина api-key.**
- `src/server/admin.ts:160–173`: scope пишется в `metadata`, `permissions` и в свою колонку `scope`; проверка читает только `scope` (`auth.ts:59`). Маршруты `/api/auth/api-key/create|update|delete|list|get` смонтированы открыто (`app.ts:372–387`), сессия владельца может создавать ключи через HTTP; их спасает только проверка `!key?.agentId` (`auth.ts:59–60`). Заявление «admin только через локальный CLI» держится на одной защитной строке. Рекомендация: явно закрыть `/api/auth/api-key/*` в middleware (или `disabledPaths` плагина), оставить единственный источник — колонку `scope`.

**V9. Идентичность владельца в клиенте захардкожена.** `store.ts:100–105` (превью с `label: 'Дмитрий'`), `src/web/lib/workspace.ts:29`, `auth.tsx:118`; сервер берёт `s.user.name` (`auth.ts:77`, по умолчанию «Владелец», `admin.ts:47`). Превью и подтверждённое состояние расходятся в `createdByLabel`/метках. Рекомендация: брать актора из `/api/me` при старте и хранить в store.

### Желательно

- **Ж1. События хранятся дважды** — в `events` и внутри `operations.result` (`operations.ts:161–189`). Удобно для точного повтора ответа, но удваивает объём журнала; `validateExport` уже умеет сверять (`admin.ts:347–350`). Можно хранить в `result` только `firstSeq/lastSeq/results` и собирать `events` при чтении.
- **Ж2. CLI ходит за `generation` в тяжёлый `/api/context`** перед каждой записью (`run.ts:465–477`) — это полное состояние + JSON-схемы. `/health` отдаёт `generation` без авторизации. `hc<AppType>` используется только для двух POST (`client.ts:92–103`), остальное — ручной fetch; лучше либо везде `hc`, либо убрать зависимость CLI от типа `AppType` (сейчас `tsc` CLI тянет весь тип приложения).
- **Ж3. Комментарии на клиенте — два источника правды.** `confirmed.comments` наполняется из SSE (`store.ts:163`, `applyEvent`), но UI его не читает (grep `.comments` по `src/web/app/*.tsx` пуст); `TaskDiscussion` перечитывает `/comments` и `/history` при каждом изменении `seq` любой сущности (`activity.tsx:348–373`). Либо проекция комментариев в store (лениво по задаче), либо перечитывать только при событиях с `taskId === task.id` из `lastEvents`.
- **Ж4. `dryRun` входит в `command_hash`** (`operations.ts:50`): dry-run с `operationId` уже исполненной операции даёт `operation_mismatch`, а не сохранённый результат. Документировать или исключить `dryRun` из хеша.
- **Ж5. SSE-бэклог без ограничения** (`app.ts:851` `send(readEvents(db, since))`); защита только `desiredSize < -1000` (`:819`). Вкладка после недель простоя получит мегабайты одним куском; корректнее ограничить бэклог (например 500) и закрыть соединение, оставив догон `catchUp`.
- **Ж6. Конфигурация с мёртвыми переменными.** `TIMEZONE` передаётся в контейнер приложения (`compose.yml:14`), но сервер её не читает — только `migrate` (`db.ts:91–92`); `LOG_LEVEL` объявлен (`compose.yml:15`, план §12) и не используется нигде в `src/`.
- **Ж7. Гранулярность `ownerFields`.** `checklist` — одно поле (`commands.ts:39–53`): владелец отметил один пункт → `sync` больше никогда не обновит чеклист из источника; `orderKey` тоже попадает в `ownerFields` при перетаскивании (влияния на sync нет, но засоряет). Это решение плана, а не кода; стоит зафиксировать осознанно или ввести поэлементную защиту для чеклиста.
- **Ж8. Первая пустая «Сохранить» владельца пишет событие.** `emit()` ставит `ownerTouchedAt` до проверки пустоты изменений (`commands.ts:244–255`) → событие только с `ownerTouchedAt`, `revision++`. Соответствует букве плана, но в «Истории» выглядит как фантомная правка.
- **Ж9. `task.sync` требует `fields.area`** (`schemas.ts:85–86,124–126`): после переноса задачи владельцем каждый sync возвращает `skipped: area locked` — шум в ответах агенту.
- **Ж10. Безопасность заголовков.** Ни в Nginx (`deploy/nginx/taskindex.conf`), ни в Hono нет CSP/HSTS/`X-Content-Type-Options`; `hono/secure-headers` — одна строка. Риск для одного владельца низкий.
- **Ж11. Расширяемость по видам сущностей.** `EntityKind` ветвится вручную в ~8 местах: `commands.ts:55–61,112–118,669–691`, `db.ts:118–146,165–234`, `admin.ts:282–360,408–439`, `domain-schemas.ts:112–114`. Вложения/ссылки как новая сущность потребуют правок во всех. Реестр `{ task: {...}, project: {...}, comment: {...} }` с полями, инверсиями и записью в БД снизил бы цену.
- **Ж12. Два формата времени в одной базе**: домен — ISO-текст, таблицы Better Auth — integer ms (`schema.ts:9`). Приемлемо, но экспорт/аналитика должны это знать.
- **Ж13. Смена `generation` — только ручная.** `mark-restored`/`import` (`admin.ts:450–463`) — единственные места ротации; приложение не распознает подменённый файл само. По плану так и должно быть, deploy-скрипты это обеспечивают. Предположение: если оператор восстановит файл вручную без `mark-restored`, клиенты применят события расходящегося журнала под тем же поколением — подтвердить можно только ручным сценарием; страховкой был бы `generation` в имени/сайдкаре тома, сверяемый при старте.

## (d) Отклонения план ↔ реализация

| План | Реализация | Оценка |
|---|---|---|
| §5 шаг 1: `INSERT OR IGNORE` в `operations` до исполнения | `SELECT` в начале, `INSERT` в конце той же `immediate`-транзакции (`operations.ts:60–82,175–189`) | эквивалентно при одном писателе |
| §2/§3: миграции Drizzle Kit | Собственный мигратор по `*.sql` + таблица `__taskindex_migrations`; журнал Drizzle используется только `generate` и тестом (`db.ts:46–96`) | отклонение; см. V6 |
| §4: индекс `events (entity_kind, entity_id, seq)` для истории | Индекс создан, все чтения — полный `SELECT` + фильтр в JS (`app.ts:679`, `operations.ts:95`) | отклонение; см. K1 |
| §6: `/api/tasks` «пагинация курсором, ничего не обрезается молча» | Курсор + инвалидация при любом `seq` (`app.ts:220`) — план семантику при конкуренции не задавал | недосказанность плана; см. V1 |
| §6: список эндпоинтов | Добавлены `/api/focus`, `/api/me`, параметр `until` у `/api/operations`; `/api/openapi.json` требует авторизации (`app.ts:296`) | расширение; допустимо |
| §7: store `{confirmed, seq, generation, pending, drafts}` | Черновики вынесены в `drafts.ts` со своим scope/Web Locks; в store добавлены `data` (производное) и UI-флаги (`store.ts:22–36`) | оправданное отклонение |
| §7: повтор «до трёх раз» | 4 попытки в браузере (`store.ts:346–363`) и в CLI (`client.ts:132`) | косметика |
| §7: модули `list`, `focus`, `search` | Слиты в `shell`/`board`/`overview` | косметика |
| §9: rate-limit входа средствами Better Auth | `rateLimit: { enabled: true }` с дефолтами (`auth.ts:23`); bearer-API без ограничений | соответствует; отметить |
| §9: «admin только через `taskindex-admin`» | Функции admin не смонтированы, но HTTP-маршруты плагина api-key открыты; защищает проверка `agent_id` (`auth.ts:59`) | см. V8 |
| §10: `--json` по умолчанию «если stdout не терминал» | Вывод всегда JSON; флаг принимается и игнорируется (`run.ts:194`) | косметика |
| §12: JSON-логи с `operationId, actor, command, code, durationMs` | Только для `/api/commands*` (`app.ts:327–337`); внутренние ошибки — без стека; `LOG_LEVEL` не используется | отклонение; см. V4, Ж6 |
| §12: переменная `TIMEZONE` приложения | Приложение читает пояс только из `settings`; env учитывает лишь `migrate` | Ж6 |
| §5: «Сообщения на русском», коды ошибок, `retryable` | Соответствует (`errors.ts`, `domain-schemas.ts:199–230`) | ✓ |
| §6: SSE `id: gen:seq`, `Last-Event-ID`, `event: reset`, `event: operations`, heartbeat 25 с | Соответствует (`app.ts:773–851`) | ✓ |
| §5: `task.sync` правила (freshness_unknown / version_incomparable / stale / owner / locked) | Соответствует (`commands.ts:538–581`) | ✓ |
| §5: undo — чистый эффект, конфликт при поздней правке, права, create→archive/soft-delete, `originVersion` не откатывается | Соответствует (`commands.ts:268–386`) | ✓ |
| §11–12: held/open, `approved_deployment`, rollback-граница, sibling-prefix Litestream | Соответствует (`admin.ts:464–481`, `deploy/deploy.sh:92–98`, `deploy/rollback.sh:11–12,44`) | ✓ |

Архитектурно спорные места самого плана: (1) декларация «журнал не источник для перестроения» вместе с отказом от компакции и историческими проверками (`assertMerge`, `undo`) без указания способа доступа к истории — прямая причина K1; (2) требование «ничего не обрезать молча» в пагинации без семантики конкурентных записей — причина V1; (3) хранение полного ответа операции с копией событий (Ж1); (4) `ownerFields` на уровне целого `checklist` (Ж7).

## (e) Что запускал и проверял

- `npx tsc --noEmit -p tsconfig.json --incremental false` (Node 24.20.0) — 0 ошибок.
- `npx vitest run` — 14 файлов, 75 тестов, все прошли (1,35 с).
- Grep границ слоёв: `src/shared` не импортирует `node:`/DOM; `src/web` не импортирует `src/server`; `src/cli` → `src/server` только `admin-run.ts` (осознанно: локальный инструмент с прямым доступом к БД) и type-import `AppType` в `client.ts`.
- Бенчмарк `scratchpad/bench-events.ts` (in-memory SQLite, реальные `migrate`/`executeOperation`): 14,0 / 32,4 / 65,3 мс на команду при 320 / 2 020 / 5 020 событиях; `bench-readstate.ts`: `readState` 6,9 мс при 300 задачах, `readEvents` 4,3 мс при 620 событиях. Полный прогон до 10 000 событий не дождался за 300 с — сам факт иллюстрирует рост.
- Прочитаны целиком: план, ревью плана, README, BACKLOG, deploy/README, все файлы `src/shared`, `src/server`, `src/cli`, `src/web/app/{store,sync,api,drafts,url}.ts`, `src/web/lib/*`, ключевые фрагменты `editor/shell/activity/auth.tsx`, SQL-миграция, все `deploy/*`, `tests/api/helpers.ts`, `tests/e2e/server.ts`, property-тесты, перечень всех тестов, `SKILL.md`, `agent-cycle.md`; исходник плагина `@better-auth/api-key` в части `verifyApiKey`.
- Репозиторий не изменялся; временные файлы только в scratchpad.

## (f) Что проверено и признано корректным

- **Транзакционность**: один `transaction().immediate()` на операцию, включая пакет и комментарии; ошибка любой команды пакета откатывает всё; `unavailable` и `dryRun` не сохраняются как результат (`operations.ts:135,171`); тесты `commands.test.ts:180,234`.
- **Порядок коммит → рассылка**: рассылка после возврата из транзакции (`app.ts:477–480`); подписка SSE и чтение бэклога в одном синхронном тике (`app.ts:847–851`) — окна потери нет; дубликаты отбрасываются клиентом по `seq` (`store.ts:198`).
- **Идемпотентность**: глобальный `operationId`, проверка актора (`operations.ts:66`), хеш канонизированного конверта (`:50,71`), TTL нет (по плану); тест `commands.test.ts:72`.
- **Достаточность событий**: `validateExport` воспроизводит состояние из журнала через `applyEvent` и сравнивает с таблицами (`admin.ts:282–360`); property-тест `tests/property/commands.test.ts:61` требует `projection == state` на случайных последовательностях. Это фактически доказывает event-sourcing-полноту при том, что таблицы остаются источником истины.
- **Undo**: чистый эффект на запись, конфликт при поздней правке, повторная проверка прав через `requireScope` (`commands.ts:329`), `originVersion`/`ownerFields` не инвертируются; восстановление `orderKey` с проверкой занятости через `assertInvariants` и промежуточную «разблокировку» ключей в `writeState` (`db.ts:197–204`); property-тест `undo.test.ts`.
- **`task.sync`**: приоритет владельца реализован на сервере в чистой функции; `originVersion` продвигается даже при полном пропуске полей и не создаёт конфликта с редактором (не предметное поле); тесты `commands.test.ts:352,435`, `recovery-and-history.test.ts:382`.
- **Sync-протокол клиента**: буфер по `seq`, применение операции целиком по `[firstSeq..lastSeq]`, снятие pending только после полного диапазона, догон страницами с отдельным курсором «получено подряд» (`store.ts:192–265`), сброс по `generation` (`:193–196,268–270`); outbox в localStorage с восстановлением через `/api/operations/:id` (`:379–421`); тесты `store.test.ts` (11 сценариев).
- **Разделение состояния на клиенте**: `confirmed` / `pending` / производное `data` / черновики в отдельном модуле с изоляцией вкладок через Web Locks; редактор хранит `baseRevision` и `generation` в черновике и требует явного слияния при конфликте (`editor.tsx:180–240`).
- **Авторизация**: scope проверяется в общем коде и одинаково для прямых команд и инверсий undo; Origin — только для cookie-сессии на не-GET (`app.ts:313–318`); `disableSignUp`; ключи хешированы; актор `agent:<id>` стабилен при ротации ключа (`auth.ts:67–73`); тесты `auth.test.ts`.
- **Порядок карточек**: fractional-indexing с бинарным сравнением в JS (`queries.ts:2–5`) и `COLLATE BINARY` в SQL (`0000_taskindex.sql:166`), UNIQUE как страховка; `localeCompare` нет на ключах порядка.
- **CLI-outbox**: запись до отправки, `link()` как атомарная публикация без перезаписи, fsync файла и каталога (`outbox.ts:100–132`), повтор того же конверта, `resume` через `/api/operations/:id`; exit-коды по плану; тесты `cli.test.ts`, `agent-cycle.test.ts`.
- **Развёртывание**: gate записи хранится в БД и привязан к `deploymentId` (перезапуск того же контейнера остаётся open); граница «open-writes» фиксируется файлом до вызова; rollback отказывает после границы; резервная копия через backup API с integrity/foreign_key check; новая ветка репликации sibling-prefix без удаления старой; `local-drill.sh` репетирует неудачный релиз.
- **Graceful shutdown**: закрытие SSE, `server.close`, форс через 10 с (`index.ts:41–54`); `stop_grace_period: 20s`.
