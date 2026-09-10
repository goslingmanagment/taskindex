# Стоимость команды и чтений не должна расти с журналом

Статус: предложение, 2026-09-08. Источник: сводное ревью v2 (см. `README.md` в этой папке).
Приоритет: P0 для шагов 1..7 (формат курсора и точечные чтения проще менять, пока живых агентов и данных нет), P1 для шагов 8..11. Оценка: L, 3..4 дня чистой работы (шаги 1..7 около 2 дней, 8..11 около 1.5 дня). Зависимости: `06-server-structure-config-logging.md` (разрез `app.ts`; без него правки этого плана и плана 06 конфликтуют в одном файле, рекомендуемый порядок 06 → 01), `04-api-contract-and-schemas.md` (описание нового формата курсора и `GET /api/generation`), `03-cli-outbox-and-ergonomics.md` (повтор при 409 на курсоре, источник `generation`), `07-web-client-fixes-and-structure.md` (перестройка «Активности» целиком).

## 1. Проблема

Все ссылки проверены по текущему дереву 2026-09-08. Номера строк отчётов совпали, расхождений не найдено.

### 1.1. Каждая команда читает всё состояние и весь журнал (K1, D1, B-03)

- `src/server/operations.ts:93` `const previous = readState(db)` и `:95` `const history = readEvents(db)` выполняются на каждую операцию, без `since` и `limit`. Внутри пакета `:106` `history: [...history, ...events]` копирует весь массив журнала на каждую из до 100 команд.
- `src/server/db.ts:118-147` `readState`: чеклисты и `commentCount` собираются вложенными `filter` по всем `items` и `comments` для каждой задачи (`:138-143`), то есть O(T × (I + C)).
- `src/server/db.ts:148-164` `readEvents`: `SELECT * FROM events WHERE seq > ? ORDER BY seq`, при `since = 0` и без лимита это весь журнал с `JSON.parse` каждого `changes`.
- `src/server/db.ts:165-234` `writeState`: изменённые записи находятся сравнением `JSON.stringify` каждой записи нового состояния с `find` по предыдущему (`:170-175`, `:191-196`, `:223-228`), O(T²) по числу задач и O(размера состояния) сериализации на каждую команду.
- `src/server/db.ts:235-273` `readOperations`: читает все `operations`, парсит `result` каждой и делает до трёх отдельных `SELECT title` на операцию (`:253-262`). Вызывается целиком из `GET /api/operations` (`src/server/app.ts:713`), из `GET /api/operations/{id}` ради одной записи (`app.ts:736`), из `GET /api/digest` (`app.ts:962`) и из экспорта (`src/server/admin.ts:227`).
- `src/server/app.ts:679` `GET /api/tasks/{id}/history` читает весь журнал и фильтрует в JS. Индексы `events_entity_revision` и `events_operation` (`src/server/schema.ts:135-138`, `drizzle/v2/0000_taskindex.sql:93-94`) не используются ни одним запросом.
- `readState` вызывается в каждом чтении: `app.ts:444` (snapshot), `:559` (tasks), `:599` (by-origin, поиск одной задачи по всему списку), `:614` (`/api/tasks/{id}`, вся база ради одной записи), `:630` (projects), `:641` (comments), `:874` (context), `:957` (digest), `:1039` (focus).
- Что реально нужно ядру: `assertMerge` (`src/shared/commands.ts:125-153`) фильтрует историю по `entityKind`, `entityId`, `recordRevision > base`; `undo` (`commands.ts:268-386`) выбирает цель по `seq` или `operationId` (`:269-271`) и «поздние» события той же записи по `recordRevision` (`:339-345`). Это ровно три выборки, которые закрыты существующими индексами.

Замеры из отчётов (in-memory SQLite, реальные `migrate` и `executeOperation`, Apple M-серии):

| Сценарий | Источник | Результат |
|---|---|---|
| `task.update` при 320 / 2 020 / 5 020 событиях, заметки 1 КБ | ревью 2, `scratchpad/bench-events.ts` | 14,0 / 32,4 / 65,3 мс на команду, рост линейный |
| `readState` при 300 задачах, 3 000 шагов, 300 комментариев | ревью 2, `bench-readstate.ts` | 6,9 мс |
| `readEvents` при 620 событиях | там же | 4,3 мс |
| `task.create` при ~0 / 4 000 событий | ревью 3, `scratchpad/repro/perf.mts` | 3,3 / 35,7 мс на операцию |
| `GET /api/operations?limit=50` при 4 010 операциях | там же | 95,2 мс |
| `GET /api/operations/{id}` | там же | 88,0 мс |
| `GET /api/tasks/{id}/history` | там же | 14,5 мс |
| `GET /api/digest` | там же | 108,1 мс |

Сервер синхронный (better-sqlite3, один event loop): пока исполняется 65-мс команда, не обслуживаются ни SSE, ни другие чтения. План (`docs/plans/2026-09-08-taskindex-v2.md:421`) фиксирует «Событий в первой версии не сжимают и не удаляют», поэтому потолок наступает сам собой через месяцы работы агентов.

### 1.2. Курсор пагинации инвалидируется любой записью (V1, B-09)

- `src/server/app.ts:196-244` `page()`: курсор несёт `seq = latestSeq(db)` и `fingerprint = sha256(JSON.stringify(items))` всей выборки (`:205-207`); при следующей странице `:220-221` любое несовпадение даёт `409 conflict` «Данные изменились. Начните чтение страниц заново». Заодно каждая страница хеширует JSON всего списка, а не только страницы.
- Следствия: `taskindex tasks --all` и `activity --all` (`src/cli/run.ts:394-401`) идут по `nextCursor` и при 409 завершаются кодом 3 (`src/cli/client.ts:40`) без повтора, хотя `skills/taskindex/SKILL.md:14` рекомендует именно `--all`. В UI «Активность» эффект `src/web/app/activity.tsx:142-179` при каждом изменении `seq`/`operationsVersion` перечитывает все открытые страницы с нуля, а `more()` (`:180-199`) на 409 показывает ошибку.
- Тест `tests/api/recovery-and-history.test.ts:79-129` закрепляет 409 как намеренное поведение; `tests/api/recovery-and-history.test.ts:130-163` проверяет продолжение «замороженных» списков `digest` по `href` + `nextCursor`.

### 1.3. SSE-бэклог без ограничения (Ж5, B-11)

`src/server/app.ts:851` `send(readEvents(db, since))`: при переподключении с давним курсором весь хвост читается, сериализуется и ставится в очередь стрима одним синхронным проходом; `desiredSize < -1000` (`:819`) проверяется только после `enqueue` всего массива. Для сравнения `GET /api/events` ограничен 500 (`app.ts:519`).

### 1.4. Комментарии на клиенте: два источника (Ж3)

`src/web/app/store.ts:160-164` кладёт в `confirmed.comments` пустой массив, а `applyEvent` (`store.ts:217`) наполняет его из SSE; ни один компонент `src/web/app/*.tsx` поле `.comments` не читает (grep пуст). `TaskDiscussion` (`activity.tsx:310-375`) перечитывает `/comments` и `/history` при каждом изменении `seq` любой сущности (зависимость `[task.id, seq, commentsOpen, historyOpen]`, `:375`).

### 1.5. CLI ходит за `generation` в тяжёлый `/api/context` (Ж2)

`src/cli/run.ts:466` перед каждой записью без `--generation` и `:327-334` для `events` запрашивают `/api/context`, который строит полное состояние, счётчики и JSON-схемы 16 команд (`app.ts:873-936`, в живом прогоне ревью 5 это 25 406 байт). `/health` (`app.ts:389-426`) отдаёт `generation` без авторизации, но план 11 закрывает `/health` в nginx для внешних адресов, поэтому CLI на него опираться нельзя.

## 2. Цель и критерии приёмки

1. Стоимость `executeOperation` не зависит от длины журнала: в бенчмарке (шаг 0) отношение мс/команда при 5 020 событиях к мс/команда при 320 событиях не больше 1,3 (сейчас 4,7). Абсолютно после шагов 1..5 не больше 12 мс на команду при 300 задачах с заметками 1 КБ на машине разработчика; после шага 10 не больше 4 мс.
2. `GET /api/operations?limit=50` не больше 10 мс, `GET /api/operations/{id}` не больше 2 мс, `GET /api/tasks/{id}/history` не больше 3 мс, `GET /api/tasks/{id}` не больше 2 мс, `GET /api/digest` не больше 25 мс при 4 000 операций и 2 000 задач (сейчас 95 / 88 / 14,5 / не измерялось / 108).
3. `EXPLAIN QUERY PLAN` для истории записи и событий операции показывает `USING INDEX events_entity_revision` и `USING INDEX events_operation` (тест).
4. Вторая страница любого списка после чужой записи возвращает 200, объединение страниц не содержит дублей и пропусков относительно полного списка на момент последней страницы (тест на `/api/operations`, `/api/tasks`, `/api/tasks/{id}/history`, `/api/tasks/{id}/comments`, `/api/focus?group=`). `generation_changed` на курсоре чужого поколения остаётся 409.
5. `tasks --all` при параллельной записи завершается кодом 0 и печатает все страницы (тест CLI с fetch-заглушкой, которая «пишет» между страницами).
6. SSE с курсором, отстающим на 1 200 событий, отдаёт бэклог тремя порциями по 500/500/200 в порядке `seq`; с отставанием больше `sseBacklogLimit` отдаёт `event: reset` и закрывается (тесты).
7. `TaskDiscussion` перечитывает комментарии и историю только при событиях своей задачи (тест store-селектора без DOM; ручная проверка в UI).
8. CLI не вызывает `/api/context` ради `generation` (тест CLI: при `task create` без `--generation` первый запрос идёт на `GET /api/generation`).
9. `npm run check` зелёный: `tsc`, oxlint, oxfmt, vitest (сейчас 14 файлов, 75 тестов), плюс новые тесты из раздела 5. `npm run e2e` зелёный (18 сценариев).

## 3. Решение

Выбрано: (а) заменить массив истории интерфейсом доступа, реализованным на сервере индексированными запросами; (б) точечные SQL-чтения для одиночных записей, истории, комментариев и операций; (в) keyset-пагинация по стабильному ключу вместо `fingerprint` + `latestSeq`; (г) запись только затронутых сущностей вместо JSON-диффа; (д) порционный SSE-бэклог с верхним пределом; (е) отдельно, как последний шаг, кэш проекции состояния в памяти с проверкой `PRAGMA data_version`.

Два рассмотренных подхода к горячему пути и почему порядок именно такой:

| Вариант | Плюсы | Минусы | Решение |
|---|---|---|---|
| Индексированные SQL-чтения (история по записи/операции, точечные `SELECT`, keyset в SQL для операций) | Не меняет модель «таблицы это источник истины»; Drizzle и индексы начинают работать по назначению; каждый шаг проверяется существующими тестами; нет состояния в процессе | `readState` для команды остаётся O(T): при 300 задачах это ~7 мс, при 3 000 задачах десятки мс; `structuredClone` в `applyCommand` (`commands.ts:233`) тоже O(T) | Делать первым (шаги 1..7) |
| Проекция состояния в памяти процесса, обновляемая после каждого коммита | `readState` уходит из горячего пути целиком (O(1)); естественно для одного писателя; заявленный «единый редьюсер» используется по назначению | Требует дисциплины «все записи через `executeOperation`»; admin-команды (`import`, `mark-restored`, `open-writes`) пишут в ту же базу из другого процесса; кэш нужно сбрасывать при внешней записи; скрытое состояние усложняет отладку | Делать после (шаг 10) с защитой `PRAGMA data_version`: у соединения better-sqlite3 это значение меняется только при коммите другого соединения, поэтому кэш сверяется одной дешёвой прагмой на запрос, а собственные записи обновляют кэш из уже вычисленного `state` |

Отвергнуто:

- Компакция или срез журнала. Противоречит плану (§6, строка 421) и ломает `undo` и `validateExport` (`admin.ts:239-361`), которые требуют полной истории.
- Хранить `history` только по затронутым сущностям, но всё ещё массивом, собираемым до `applyCommand`. Требует заранее знать затронутые id для `undo`, то есть частично повторяет логику команды в `operations.ts`. Интерфейс доступа проще и без дублирования.
- Курсор с повтором на клиенте (только B-09-фикс без смены сервера). Оставляет O(n) хеширование на каждую страницу и 409 при высокой активности; агенту всё равно придётся перечитывать с начала.
- WebSocket или отдельный воркер для SSE. Не решает синхронный `readEvents`; проблема в объёме одной порции, а не в транспорте.

Где «замороженный» список остаётся законным: окно `digest.operations` задаётся диапазоном `(since, until = seq]` по `lastSeq` (`app.ts:962-970`, `:1004`), это снимок по определению и не требует `fingerprint`; `GET /api/events?since=` уже keyset по `seq`. Всё остальное переводится на keyset.

## 4. Шаги

Порядок обязателен внутри фаз; фазы можно разносить по коммитам. Каждый шаг заканчивается `npm run check`.

### Фаза 0. Бенчмарк

0. Добавить `scripts/bench-journal.ts` (запуск `node --import tsx scripts/bench-journal.ts`, не входит в vitest). Основа: `scratchpad/bench-events.ts` и `scratchpad/repro/perf.mts` из ревью. Содержание: `:memory:`, `migrate`, 300 задач с заметкой 1 КБ и 10 шагами через `executeOperation`; замер `task.update` (20 итераций) при 320, 2 020, 5 020, 10 020 событиях (журнал наращивается правками заметки); затем через `fixture()` из `tests/api/helpers.ts` 2 000 задач и 4 000 операций и замер `GET /api/operations?limit=50`, `/api/operations/{id}`, `/api/tasks/{id}/history`, `/api/tasks/{id}`, `/api/digest`, `/api/snapshot`. Вывод: JSON-строки `{label, events, msPerOp}`. Зафиксировать текущие числа в `docs/plans/2026-09-08-v2-review/bench-baseline.json` (создать файл при первом прогоне), после каждой фазы дописывать строку. Целевые значения из раздела 2 записать в заголовок скрипта комментарием. Добавить в `package.json` скрипт `bench`. Проверка: скрипт печатает числа порядка 14 → 65 мс, как в ревью.

### Фаза 1. История и точечные чтения (без смены контрактов)

1. `src/shared/commands.ts`: ввести интерфейс
   ```ts
   export type HistoryAccess = {
     forRecord(kind: EntityKind, id: string, afterRevision: number): DomainEvent[];
     forOperation(operationId: string): DomainEvent[];
     bySeq(seq: number): DomainEvent | undefined;
   };
   export function arrayHistory(events: DomainEvent[]): HistoryAccess;
   ```
   `CommandContext.history?: DomainEvent[] | HistoryAccess` (массив нормализуется через `arrayHistory` в начале `applyCommand`, чтобы `tests/property/undo.test.ts:31` и клиентский store не менялись). `assertMerge` (`:125-153`) принимает `HistoryAccess` и берёт `history.forRecord(kind, record.id, base)`. В `undo` (`:269-271`) цель: `p.seq !== undefined ? [history.bySeq(seq)].filter(Boolean) : history.forOperation(operationId)`; «поздние» события (`:339-345`): `history.forRecord(kind, record.id, last.recordRevision).filter(e => !targetSeqs.has(e.seq))`. Поведение и сообщения не меняются. Проверка: `npx vitest run tests/property tests/api/commands.test.ts`.

2. `src/server/db.ts`: добавить
   ```ts
   export function readEventsForRecord(db, kind: EntityKind, id: string, afterRevision: number): DomainEvent[]; // WHERE entity_kind=? AND entity_id=? AND record_revision>? ORDER BY seq
   export function readEventsForOperation(db, operationId: string): DomainEvent[];                            // WHERE operation_id=? ORDER BY seq
   export function readEventBySeq(db, seq: number): DomainEvent | undefined;
   export function serverHistory(db, overlay: DomainEvent[]): HistoryAccess; // индексы + свежие события текущего пакета
   ```
   Выделить общий маппер строки в `DomainEvent` (сейчас дублируется в `readEvents:160-163`). `serverHistory` объединяет результат запроса с `overlay` (события, уже накопленные в `events` текущей операции, `operations.ts:96`), фильтруя overlay теми же условиями. В `src/server/operations.ts:95` убрать `readEvents(db)`, в `:106` передавать `history: serverHistory(db, events)`. Проверка: все тесты `tests/api`, бенчмарк должен показать исчезновение линейного роста (ожидание около 7..10 мс на команду независимо от журнала).

3. `src/server/db.ts:118-147` `readState`: сгруппировать `items` и `comments` по `taskId` в `Map<string, ...>` одним проходом, задачи собирать из карт. Порядок шагов сохраняется сортировкой `ORDER BY position` (уже есть, `:128`). Проверка: `tests/api/durability.test.ts`, property-тесты; `readState` в бенчмарке не хуже 3 мс при 300 задачах.

4. `src/server/db.ts`: точечные чтения
   - `readTask(db, id): Task | undefined` (задача + её шаги + `commentCount` через `SELECT COUNT(*) FROM comments WHERE task_id=? AND deleted_at IS NULL`);
   - `readTaskByOrigin(db, system, ref)` (индекс `tasks_origin`);
   - `readProjects(db)`;
   - `readComments(db, taskId, after?: {createdAt, id}, limit)` (индекс `comments_task_created`, порядок `created_at, id`);
   - `taskExists(db, id)`.
   Заменить в `src/server/app.ts`: `:599` (by-origin), `:614` (`/api/tasks/{id}`), `:630` (`/api/projects`), `:641-657` (comments: проверка существования и выборка), `:679` (history → `readEventsForRecord(db, 'task', id, 0)`). Ответы и статусы не меняются. Проверка: `tests/api/commands.test.ts`, `tests/api/recovery-and-history.test.ts`.

5. `src/server/db.ts:235-273` `readOperations` → два запроса:
   - `readOperation(db, id): StoredOperation | undefined` с заголовками задач одним `SELECT id, title FROM tasks WHERE id IN (...)` (до 3 id);
   - `readOperationsPage(db, { actor?, since?, until?, after?: {createdAt, id}, limit }): { rows, more }`: `SELECT ... FROM operations WHERE (актор) AND COALESCE(last_seq,0) > ? AND COALESCE(last_seq,0) <= ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?+1` (индекс `operations_created`), `result` парсится только для строк страницы, заголовки одним `IN`-запросом по всем id страницы.
   Семантику фильтров `since/until` сохранить точно как в `app.ts:716-718` (рассмотрите `(o.lastSeq ?? 0)`). Экспорт (`admin.ts:227`) продолжает читать все операции: оставить `readOperations(db)` как обёртку над постраничным чтением без лимита, но без N+1 (заголовки одним запросом на всё). Заменить `app.ts:713` и `:736`, `:962` (digest). Проверка: `recovery-and-history.test.ts:79-129` (пока с прежней семантикой курсора), бенчмарк `/api/operations` и `/api/operations/{id}`.

6. `src/server/db.ts:165-234` `writeState(db, state, previous, touched?)`: третьим аргументом принимать множество изменённых сущностей `{ projects: Set<string>, tasks: Set<string>, comments: Set<string> }`, собранное в `operations.ts` из `applied.effects` (каждый эффект несёт `entityKind`/`entityId`). Ветка с JSON-диффом остаётся только для `previous === undefined` (импорт, `admin.ts:427`). Трюки с временными `nameKey`/`orderKey` (`:180`, `:202`) сохраняются для затронутых записей. Обоснование безопасности: `commentCount` не персистится (`:211`), а любое изменение предметного поля проходит через `emit` и порождает эффект (`commands.ts:255-265`). Проверка: новый property-тест (раздел 5, п. 4) сравнивает базу после «записи по эффектам» с базой после полного диффа.

   2026-09-10: фаза 1 выполнена (TI-012). Расхождения с текстом: правило «модуль сервера не больше 400 строк» (план 06) не вмещает всё в `db.ts`, поэтому журнал событий (`toEvent`, `readEvents*`, `readEventBySeq`, `serverHistory`, `withEvents`) живёт в `src/server/events.ts`, журнал операций (`readOperation`, `readOperationsPage`, `readOperations`) в `src/server/journal.ts`; `db.ts` остаётся единым путём импорта (`export *`). `readOperationsPage` сразу принимает ключ `{ operationSeq }` (шаг 15), а не `{ createdAt, id }`. Заголовки задач для страницы берутся одним `IN`-запросом по событиям страницы (индекс `events_operation`), для экспорта одним сканом журнала. Множество затронутых записей собирает `touchedByEvents(events)` в `db.ts`. Сценарий бенчмарка «`readOperations().find()`» заменён на путь `readOperation(db, id)` (то, что делает `GET /api/operations/{id}`), числа в `bench-baseline.json`, строка `v2-fixes A4, фаза 1`.

### Фаза 2. Keyset-пагинация (смена формата курсора)

7. `src/server/http/pagination.ts` (модуль появляется в плане 06; если план 06 ещё не выполнен, временно внутри `app.ts`):
   - курсор `{ v: 2, generation, query, key: Record<string, string | number> }` в base64url; курсоры без `v: 2` отклоняются `invalid` «Неверный курсор» (миграции старых курсоров нет: до переключения агентов нет);
   - `keysetPage<T>(items: T[], query, identity, keyOf: (item) => Key, compare: (a: Key, b: Key) => number)` для списков, вычисляемых в памяти (`/api/tasks`, `/api/focus?group=`): пропускает элементы с ключом не больше ключа курсора, возвращает `limit` элементов и `nextCursor` с ключом последнего; без `fingerprint`, без `JSON.stringify(items)`;
   - для SQL-списков (`/api/operations`, `/api/tasks/{id}/comments`, `/api/tasks/{id}/history`) курсор передаётся в `after` запросов из шагов 4 и 5;
   - `checkGeneration(cursor.generation)` и проверка `cursor.query === identity` сохраняются; `Page.seq` остаётся информативным `latestSeq(db)` на момент ответа.
   Ключи: tasks `(orderKey, id)` (порядок `queryTasks` → `sort(byOrder)`, `src/shared/queries.ts:62`, `byOrder` сравнивает `orderKey`, затем `id`, `queries.ts:4-5`); focus `due`: `(due, orderKey, id)`, `follow-ups`: `(followUp, orderKey, id)`, остальные группы `(orderKey, id)` (`queries.ts:84-91`); comments `(createdAt, id)` (`app.ts:648-652`); history `seq`; operations `(createdAt, id)` по убыванию. Компромисс, который надо записать в `04-…md`: между страницами элемент может появиться дважды (перемещён вперёд) или пропасть (перемещён назад); для агента это безопаснее 409 посреди обхода, а полный согласованный список даёт `/api/snapshot`.
   `digest` (`app.ts:938-1011`): `focus[].nextCursor` и `waiting.nextCursor` строятся тем же `keysetPage`; `operations` в digest берёт `readOperationsPage` с окном `since/until` и keyset-курсором внутри окна. Обновить тесты `recovery-and-history.test.ts:79-129` и `:130-163` (раздел 5).

   2026-09-10: фаза 2 выполнена (TI-037). Курсор `{ v: 2, generation, query, key }` в `src/server/http/pagination.ts`; `keysetPage` без параметра `compare`: порядок сравнения задаёт порядок полей в `keyOf(item)` (`compareKeys`), ключи `taskKey` и `focusKey(group)` экспортируются оттуда же; SQL-ленты берут ключ через `cursorKey` и отдают `slicePage`/`pageOf`. `/api/operations` при `after` не учитывает `since`/`until` (два независимых курсора, как в описании маршрута). В `digest` при `sinceOp` окно `since` к операциям не применяется, а список операций идёт в порядке журнала (по возрастанию), потому что это первая страница списка за `href` (`after=`) и `href + nextCursor` его продолжает; без `sinceOp` окно `(since, seq]` новые сверху с тем же identity, что у `/api/operations?since=&until=`. Комментарии владельца в `digest` выбираются в SQL (`readOwnerCommentEvents`), а не разбором всего хвоста журнала. Бенчмарк, строка `v2-fixes A4, фаза 2`: `GET /api/operations?limit=50` 67,6 → 1,5 мс, `GET /api/digest` 197,6 → 23,0 мс.

### Фаза 3. Клиенты и SSE

8. CLI (`src/cli/run.ts`): (а) новый маршрут `GET /api/generation` → `{ generation, seq }` в `app.ts` (одна `getSetting` и один `MAX(seq)`, под авторизацией как весь `/api/*`); `run.ts:466` и `:328` вместо `/api/context` запрашивают его; (б) в цикле `--all` (`:394-401`) при `409` с `code: 'conflict'` перезапускать обход с первой страницы, не больше 3 раз, затем прежний выход с кодом 3; после keyset такой 409 возможен только у `generation_changed`, повтор нужен как страховка и для старых серверов. Решение владельца: вместо нового маршрута можно расширить `/api/me` полями `generation`/`seq`, но это меняет строгую `actorSchema` (`src/shared/domain-schemas.ts:12-20`); рекомендуется отдельный маршрут. Проверка: `tests/cli/cli.test.ts`.

9. Web (`src/web/app/activity.tsx`): (а) `more()` (`:180-199`) при `ApiError` с `code === 'conflict'` перечитывает с первой страницы до `loadedCount` (переиспользовать `load` из эффекта, вынести в функцию); (б) эффект `:142-179` при смене `version` перечитывает только первую страницу и сливает с уже загруженными операциями по `id` (операции неизменяемы после записи), вместо перечитывания всех страниц; (в) `TaskDiscussion` (`:310-375`): вместо `seq` в зависимостях использовать `relevantSeq`, вычисленный из `lastEvents` store как максимальный `seq` события с `entityKind === 'task' && entityId === task.id` или `taskId === task.id`; при смене `generation` перечитывать всегда. Ограничение: `lastEvents` хранит последние 500 событий (`store.ts:231`); при догоне более 500 событий за раз перечитывание может не сработать, поэтому дополнительно перечитывать при `connected: false → true`. Полная перестройка «Активности» остаётся в `07-web-client-fixes-and-structure.md`. Проверка: e2e `tests/e2e/workspace.spec.ts` (комментарии и история), ручная проверка сетевой панели: правка чужой задачи не вызывает запросов `/comments`.

10. SSE (`src/server/sse.ts` после плана 06, иначе `app.ts:752-866`): `AppOptions.sseBacklogLimit` (по умолчанию 5 000). При подключении: если `latestSeq(db) - since > sseBacklogLimit`, отправить `event: reset` с текущим `generation` и закрыть (клиент `sync.ts:30-35` уже делает `refresh()` на `reset`; в `04-…md` записать, что `reset` означает «возьмите снимок», а не только смену поколения). Иначе читать бэклог порциями `readEvents(db, cursor, 501)` по 500, между порциями уступать event loop (`await new Promise(r => setImmediate(r))`), прекращать при закрытии или `desiredSize < 0`. Подписка добавляется до первой порции (как сейчас, `:847-851`); живые события, пришедшие между порциями, клиент буферизует по `seq` (`store.ts:197-214`), дубликаты по одному `seq` безвредны. Проверка: тесты раздела 5, п. 6.

    2026-09-10: серверная часть фазы 3 выполнена (TI-012). Шаг 8(а): маршрут `GET /api/generation` не вводится — `GET /api/me` (план 04, TI-047) уже отдаёт `generation` и `seq` под авторизацией, CLI (B) на него и опирается. Шаг 10: `AppOptions.sseBacklogLimit` (по умолчанию `SSE_BACKLOG_LIMIT` = 5 000), порции `SSE_BACKLOG_CHUNK` = `LIMITS.pageSize` (500) через `replayBacklog` в `src/server/sse.ts`; между порциями `setImmediate`, при `desiredSize < 0` порция ждёт потребителя, а не прекращает отдачу (иначе клиент получил бы разрыв без сигнала), при закрытии потока отдача останавливается. Тесты: `tests/api/sse-hub.test.ts` (1 200 событий → порции 500/500/200 через `publishTo`, порядок seq; `sseBacklogLimit: 100` → `event: reset`). Шаг 9 (веб: `more()` при 409, подпись «Список изменился», `relevantSeq`) — у владельца `src/web`.

### Фаза 4. Кэш проекции

11. `src/server/projection.ts`: `createProjection(db)` → `{ read(): WorkspaceState; replace(state): void }`. `read()`: `const v = db.sqlite.pragma('data_version', { simple: true })`; если `cache && cache.version === v` вернуть `cache.state`, иначе `readState(db)` и запомнить. `replace(state)` вызывается из `executeOperation` после `writeState` тем же значением `state`, что записано; `version` берётся после записи. Внешняя запись (admin-команда из другого процесса, `sqlite3` в контейнере) меняет `data_version`, кэш перечитывается. `readState(db)` во всех чтениях `app.ts` заменить на `projection.read()`; `executeOperation` получает проекцию через параметр `options.projection` (тесты без него работают как раньше). Важно: возвращаемое состояние нельзя мутировать; `applyCommand` делает `structuredClone` (`commands.ts:233`), `queryTasks`/`focusGroups` не мутируют (проверено `tests/unit/shared.test.ts:164`). Проверка: property-тест равенства кэша и `readState` (раздел 5, п. 8), бенчмарк: команда не больше 4 мс, `/api/snapshot` и `/api/context` не зависят от `readState`.

    2026-09-10: фаза 4 выполнена (TI-012). Бенчмарк, строка `v2-fixes A4, фаза 4`: `task.update` при 300 задачах 3,1/2,7/2,6/2,6 мс при 320/2 020/5 020/10 020 событиях (критерий 1: отношение 0,84, абсолют ≤ 4 мс); `GET /api/digest` 4,6 мс, `/api/snapshot` 15,0 мс. Критерий доп. шага 13 «отношение 5 000/1 000 задач ≤ 2 после фазы 4» не достигнут: 45,5/9,1 = 5,0 (было 859/52 = 16,5, после фазы 1 — 5,4). Квадрат в `writeState` устранён; остаток линеен по числу задач и целиком приходится на `structuredClone` в `applyCommand` и `assertInvariants` по всему состоянию, которые раздел 7 сознательно оставляет; линейная стоимость даёт отношение ≈ 5 при любом кэше. Целевое «≤ 2» предполагало, что после квадрата останется константа, чего в модели с клоном всего состояния нет; порог для регрессий по этому сценарию — абсолют ≤ 60 мс при 5 000 задач с заметкой 1 КБ и 10 шагами. Версия кэша — пара `PRAGMA data_version` (коммиты других соединений) и `total_changes()` (записи этого соединения мимо executor: импорт, тесты), поэтому `admin import` в том же процессе тоже сбрасывает кэш. `replace(state, version)` получает версию, снятую внутри транзакции после записи, и вызывается после коммита; `AppOptions.projectionCache: false` возвращает чтение из базы на каждый запрос. Бенчмарк `scripts/bench-journal.ts` вызывает executor с проекцией, как сервер. Тест: `tests/property/projection.test.ts` (файловая база, второе соединение `better-sqlite3`).

## 5. Тесты

| # | Файл | Сценарий | Ожидание |
|---|---|---|---|
| 1 | `tests/api/history-access.test.ts` (новый) | `db.sqlite.prepare('EXPLAIN QUERY PLAN ' + sql).all()` для запросов `readEventsForRecord`, `readEventsForOperation` | строка плана содержит `events_entity_revision` и `events_operation` соответственно; для `readTaskByOrigin` содержит `tasks_origin`, для `readComments` содержит `comments_task_created` |
| 2 | `tests/api/history-access.test.ts` | `serverHistory(db, overlay)`: событие из overlay с `recordRevision > base` учитывается в `forRecord`, событие базы с меньшей ревизией не возвращается; `bySeq` находит и базу, и overlay | точные массивы |
| 3 | `tests/api/commands.test.ts` (существующие) | все сценарии слияния, undo, батчей после шагов 1..2 | без изменений, зелёные |
| 4 | `tests/property/write-state.test.ts` (новый) | случайные последовательности команд (генератор из `tests/property/commands.test.ts`) на двух `:memory:` базах: одна пишет через `writeState(db, state, previous)` (диффом), другая через `writeState(db, state, previous, touched)` по эффектам | `readState` обеих баз равны после каждой команды (`toEqual`) |
| 5 | `tests/api/recovery-and-history.test.ts:79-129` (переписать) | страница 1 `limit=1`, затем `task.update` без событий и `comment.add` с событием, затем страница 2 | статус 200; объединение страниц равно полному списку на момент страницы 2 без дублей; заголовки `titles: ['Task']` по-прежнему один раз |
| 6 | `tests/api/pagination.test.ts` (новый) | для `/api/tasks?limit=7` (20 задач), `/api/tasks/{id}/history?limit=3`, `/api/tasks/{id}/comments?limit=2`, `/api/focus?group=due&limit=3`: между страницами выполняется запись в другую сущность | все страницы 200, объединение без дублей и пропусков; курсор чужого `generation` → 409 `generation_changed`; курсор другого `query` → 400 `invalid`; курсор старого формата (без `v`) → 400 `invalid` |
| 7 | `tests/api/recovery-and-history.test.ts:130-163` (обновить) | digest `href` + `nextCursor` для `focus[0]` и `waiting` | по-прежнему 5 элементов на второй странице |
| 8 | `tests/property/projection.test.ts` (новый) | после каждой случайной команды `projection.read()` deep-равен `readState(db)`; затем внешняя запись вторым соединением (`new SQLite(path)` на файловой базе, `UPDATE tasks SET title=...`) | после внешней записи `projection.read()` возвращает новое значение (кэш сброшен по `data_version`) |
| 9 | `tests/api/commands.test.ts` «SSE replays backlog…» (`:729-749`) + новый тест | 1 200 событий, `since=0`, читать стрим | события приходят в порядке `seq` 1..1200, три порции (проверять по границам `id:`); при `createApp({ sseBacklogLimit: 100 })` и 1 200 событий → тело содержит `event: reset` и стрим закрыт |
| 10 | `tests/cli/cli.test.ts` (новый кейс) | заглушка fetch: первый запрос второй страницы отвечает 409 `{code:'conflict'}`, повтор с первой страницы отвечает 200 | `tasks --all` возвращает 0, вывод содержит все страницы; после 3 подряд 409 код 3 |
| 11 | `tests/cli/cli.test.ts` (новый кейс) | `task create` без `--generation` | первый запрос `GET /api/generation`, `/api/context` не вызывается |
| 12 | `tests/web/store.test.ts` (новый кейс) | селектор `relevantSeq(task.id)` над `lastEvents` | меняется только от событий этой задачи или её комментариев |
| 13 | `scripts/bench-journal.ts` (вручную, результат в `bench-baseline.json`) | после фазы 1: рост ≤ 1,3×, ≤ 12 мс; после фазы 4: ≤ 4 мс; GET-цели из раздела 2 | числа записаны в файл с датой и коммитом |

## 6. Риски и откат

- Ошибка в `serverHistory` (например, пропуск overlay) молча ослабит проверки `assertMerge`/`undo`. Защита: тест 2 и существующие сценарии `commands.test.ts:89`, `:569`, property-тесты `undo.test.ts`. Откат: вернуть `readEvents(db)` и `arrayHistory` одной строкой в `operations.ts`, интерфейс остаётся.
- Запись по эффектам (шаг 6) пропустит изменение, если появится побочный эффект без `emit`. Защита: тест 4 в property-наборе; при сомнении оставить диф как проверку в тестовой сборке (сравнение множеств и предупреждение в лог), не в проде.
- Смена формата курсора ломает агентов, сохранивших старые курсоры. До рабочего переключения таких нет; после него понадобился бы период поддержки обоих форматов (`v` отсутствует → старая ветка). Это причина делать фазу 2 до переключения.
- Keyset может показать элемент дважды при перемещении между страницами. Задокументировать в `04-…md` и `SKILL.md` (план 12): для полного согласованного списка использовать `/api/snapshot`.
- `event: reset` при большом бэклоге сбросит оптимистичный слой вкладки: `refresh()` → `recover()` восстанавливает pending по `/api/operations/:id` (`store.ts:379-421`), черновики не трогаются. Проверить в e2e сценарием с длительной паузой (искусственно: `sseBacklogLimit: 1`).
- Кэш проекции при ошибке даст расхождение чтений с базой. Защита: `data_version`, property-тест 8, отсутствие мутаций. Откат: `projection.read()` → `readState(db)` через флаг `AppOptions.projectionCache: false`.
- Бенчмарк не входит в CI намеренно: тайминги на CI нестабильны. Регрессии ловят структурные тесты (`EXPLAIN QUERY PLAN`) и ручной прогон перед релизом.

## 7. Вне объёма

- Разрез `app.ts` на модули, `sse.ts`, `http/pagination.ts` как файлы: `06-server-structure-config-logging.md`. Здесь описано содержание, размещение задаёт план 06.
- Документация нового курсора, `GET /api/generation`, семантики `reset`, `issues` в ошибках: `04-api-contract-and-schemas.md`.
- Перестройка «Активности» (фильтр по актору, `useRequest`, prop drilling): `07-web-client-fixes-and-structure.md`; здесь только минимальные правки `more()`/`TaskDiscussion`.
- Переподключение EventSource после фатального закрытия (V5): `07-web-client-fixes-and-structure.md`.
- Дублирование событий в `operations.result` (Ж1) и индекс по `operations.last_seq`: `09-data-layer-and-dependencies.md`.
- Сохранённый курсор агента и `digest --since last` (A6): `03-cli-outbox-and-ergonomics.md`, `12-ai-readiness-and-docs.md`.
- `O(T)` `structuredClone` в `applyCommand` и `assertInvariants` по всему состоянию: осознанный пол производительности, не трогаем.

## Покрытые находки

| ID | Отчёт | Кратко | Где в плане |
|---|---|---|---|
| K1 | 2 (архитектура) | Каждая команда читает весь журнал и состояние | §1.1, шаги 1..3, 6, 11 |
| D1 | 1 (стек) | Полная загрузка на команду и почти каждое чтение; Drizzle и индексы декоративны | §1.1, шаги 2, 4, 5 |
| B-03 | 3 (баги) | O(N) на команду и страницу ленты, ×11 при 4k событий | §1.1, шаги 1..5, бенчмарк шаг 0 |
| V1 | 2 | Курсор инвалидируется любой записью; `fingerprint` всего списка | §1.2, шаг 7 |
| B-09 | 3 | 409 на курсоре; `--all` и «Ещё» не повторяют | §1.2, шаги 7..9 |
| Ж5 | 2 | SSE-бэклог без ограничения | §1.3, шаг 10 |
| B-11 | 3 | Хвост журнала одним синхронным пакетом | §1.3, шаг 10 |
| Ж3 | 2 | Комментарии: store vs перечитывание по любому `seq` | §1.4, шаг 9(в) |
| Ж2 | 2 | CLI ходит за `generation` в `/api/context` | §1.5, шаг 8 |
| Ж11 (частично) | 2 | `readState`/`writeState` ветвятся по видам сущностей | шаг 6 вводит `touched` по видам; реестр в `09-…md` |
| Astra S-01 / A-02 | astra / TI-012 | тот же корень: полные `readState`/`readEvents`, O(T²) в `writeState`, N+1 в `readOperations`, SSE-бэклог; второй бенчмарк (задачи без истории, 50 000 событий) | §1.1, шаги 3, 5, 6, 10; шаги 12-14 |
| Astra B-04 (стык) | astra / TI-008 | курсор операций для no-op и отказов; keyset `/api/operations` должен перейти на `operationSeq` | шаг 15; реализация в плане 04 |
| Сверка §4.6 (`ASTRA-VS-FABLE.md`) | astra / TI-037 | keyset-обход изменяемого списка не снимок; изменение между страницами надо обозначать | шаг 16 |

## Сверка с ревью Astra (2026-09-08)

Кратко: Astra (S-01/A-02, план `astra-12-indexed-reads-and-write-cost.md`, реестр TI-012) подтвердила тот же корень, что и §1.1, и дала второй бенчмарк: 1,3 / 8,5 / 63 мс на `task.update` при 100 / 1 000 / 5 000 задач без истории (квадрат по задачам в `src/server/db.ts:191-196`), 4,8 / 45 / 250 мс при 1 000 / 10 000 / 50 000 событий и 21 / 229 / 1 039 мс на `readOperations(db).find(...)` (путь `GET /api/operations/{id}`); повтор при сверке дал 1,7 / 8,8 / 65,8, 5,4 / 48 / 253,7 и 24 / 238 / 1 106 мс, расхождение до 7 %. Astra не нашла инвалидацию курсора любой записью (V1/B-09, TI-037), тяжёлый `/api/context` ради `generation` (Ж2) и двойной источник комментариев (Ж3); эти пункты остаются только здесь. По решению разногласий нет: обе стороны сохраняют SQLite и единый executor и начинают с дешёвых индексных чтений; расходятся приоритет (Astra P2, здесь P0 для шагов 1-7) и форма курсора для операций без событий (Astra B-04, владелец шага план 04).

### Добавлено по итогам сверки
| Пункт | Источник Astra | Реестр | План Astra | Что делаем здесь / где делается |
|---|---|---|---|---|
| Второй бенчмарк как baseline: масштаб по числу задач без истории и по 50 000 событий одной задачи, lookup операции | S-01 / A-02 | TI-012 | `astra-12-indexed-reads-and-write-cost.md`, шаг 1 | шаг 12 ниже: сценарии Astra добавляются в `scripts/bench-journal.ts` и `bench-baseline.json` |
| Критерий приёмки по числу задач (O(T²) в `writeState`) и оговорка «пороги регрессии, не SLA» | S-01 / A-02 | TI-012 | `astra-12`, проверка 3 | шаг 13 ниже дополняет раздел 2 |
| Правило: журнал не усекается и не компактируется ради скорости; `undo`, `assertMerge`, `validateExport` требуют полной истории | S-01 (рекомендация `01-stack.md:72`), `astra-12` «Зависимости и границы» | TI-012 | `astra-12` | уже в §3 «Отвергнуто: компакция»; шаг 14 закрепляет как правило раздела 6 и требование к `serverHistory` |
| `Map` по id в `writeState`, группировка `items`/`comments` одним проходом в `readState` | S-01 (рекомендация `01-stack.md:72`) | TI-012 | `astra-12`, шаг 3 | уже шаги 3 и 6; без изменений |
| Ограниченный SSE-бэклог с backpressure | S-01 (пункт про `app.ts:851`) | TI-012 | `astra-12`, шаг 6 | уже шаг 10; без изменений |
| Отдельный монотонный курсор операций (no-op и отказы без `lastSeq`) | B-04 | TI-008 | `astra-08-operation-feed-cursor.md` | в плане 04; здесь шаг 15 делает keyset `/api/operations` совместимым с будущим `operationSeq` |
| Обход изменяемого списка не равен снимку: обозначать изменение между страницами | `ASTRA-VS-FABLE.md` §4.6 | TI-037 | нет | шаг 16 ниже |

### Расхождения и решение
- Приоритет. Astra: P2, «измеренная проблема масштабирования, не SLA». Здесь: P0 для шагов 1-7. Решение: оставить P0 не из-за задержек сегодня, а потому что формат курсора и форма точечных чтений меняются дёшево до появления живых агентов и сохранённых курсоров; обе стороны сходятся на порядке «дешёвые шаги до переключения, полное устранение сканов во второй волне» (сверка по стеку, раздел «Сравнение рекомендаций»).
- Пропуски и дубли при keyset. `ASTRA-VS-FABLE.md` §4.6: заменять 409 молчаливыми пропусками нельзя; для append-only журнала нужна монотонная позиция, для изменяемого списка распознаваемое изменение с контролируемым повтором. Здесь шаг 7 уже даёт монотонные ключи для операций, истории и комментариев и документирует компромисс для `/api/tasks` и `/api/focus`. Решение: компромисс остаётся, но изменение между страницами становится видимым (шаг 16), а SKILL.md (план 12) называет `/api/snapshot` единственным согласованным полным списком.
- Курсор для операций без событий. Astra B-04 требует отдельный `operationSeq`; здесь шаг 5 сохраняет семантику `since/until` по `lastSeq`, а шаг 7 берёт ключ `(createdAt, id)`. Решение: владелец шага план 04; здесь `readOperationsPage` проектируется так, чтобы смена ключа на `operationSeq` была локальной (шаг 15). Фиктивные события для no-op и отказов не вводятся: обе стороны согласны, что они исказили бы историю.
- Целевые миллисекунды раздела 2. Astra: не выдавать микробенчмарк за SLA. Решение: цифры остаются порогами регрессии на машине разработчика для `scripts/bench-journal.ts`, формулировка уточняется (шаг 13).
- Посев Astra (все 50 000 событий одной задачи) максимально нагружает фильтр `assertMerge` (`src/shared/commands.ts:134-141`); в реальном пространстве события распределены по задачам. Вывод не меняется: доминирует `readEvents` с разбором `changes`.

### Дополнительные шаги
12. `scripts/bench-journal.ts` (шаг 0): добавить два сценария Astra из `docs/audits/2026-09-08-multiside-review/01-stack-bench.ts`: (а) N задач через `writeState` без истории и одна `task.update`, N из {100, 1 000, 5 000}; (б) одна задача, история засеяна копиями seed-события и seed-операции через `INSERT`, N из {1 000, 10 000, 50 000}, плюс `readOperations(db).find(...)` как замер пути `GET /api/operations/{id}` (`src/server/app.ts:713`, `readOperations` `src/server/db.ts:235-273`). В `bench-baseline.json` записать обе точки: Astra 1,3 / 8,5 / 63 мс, 4,8 / 45 / 250 мс, 21 / 229 / 1 039 мс и повтор сверки 1,7 / 8,8 / 65,8, 5,4 / 48 / 253,7, 24 / 238 / 1 106 мс с полем `source`. Проверка: до правок скрипт воспроизводит порядок величин.
13. Раздел 2, критерий 2: дополнить строкой «`task.update` при 5 000 задач без истории: отношение к времени при 1 000 задач не больше 5,5 после фазы 1 (сейчас 63 / 8,5 = 7,4 за счёт квадрата в `db.ts:191-196`) и не больше 2 после фазы 4; `GET /api/operations/{id}` при 50 000 операций не больше 5 мс после шага 5 (сейчас 1 039 мс)». Перед списком критериев добавить фразу «Значения это пороги регрессии бенчмарка на машине разработчика, не SLA продукта». Проверка: тест 13 (ручной прогон) фиксирует новые строки в `bench-baseline.json`.
14. Раздел 6: добавить правило «События не усекаются, не компактируются и не удаляются ради производительности: `undo` (`src/shared/commands.ts:300-308`, `:336-340`), `assertMerge` (`:134-141`) и `validateExport` (`src/server/admin.ts:354-360`) опираются на полный журнал; `serverHistory(db, overlay)` обязан возвращать все события, удовлетворяющие условию выборки, включая overlay текущего пакета (тест 2)». Ту же фразу передать в план 04 (описание контракта истории) и в SKILL.md (план 12).
15. Стык с планом 04 (Astra B-04): `readOperationsPage` (шаг 5) принимает `after` как непрозрачный объект ключа `{ createdAt, id }`; после введения `operationSeq` (план 04, дополнительный шаг 11) ключ заменяется на `{ operationSeq }`, фильтры `COALESCE(last_seq, 0)` в `since/until` заменяются окном по `operationSeq`, `digest.operations` (`src/server/app.ts:962-968`) переводится на то же окно; тесты 5 и 6 по смыслу не меняются. До плана 04 отсутствие `since` и `since=0` в `/api/operations` должны возвращать и операции с `lastSeq = null` (правка фильтра `app.ts:717`: `q.since === undefined || q.since === 0 || (o.lastSeq ?? 0) > q.since`), чтобы «всё» означало всё. Проверка: `tests/api/recovery-and-history.test.ts`, кейс «`since=0` содержит no-op и отказ».
16. Обозначение изменения при обходе (`ASTRA-VS-FABLE.md` §4.6). `Page.seq` уже отдаётся на каждой странице. CLI (шаг 8, `--all`): если `seq` первой и последней страницы различаются, печатать в stderr одну строку `{"warning":"list_changed_during_walk","fromSeq":N,"toSeq":M}`, код выхода 0. UI (шаг 9, `more()`): при смене `seq` между страницами показывать подпись «Список изменился во время загрузки». SKILL.md (план 12): полный согласованный список даёт только `/api/snapshot`. Тест `tests/cli/cli.test.ts`: заглушка отдаёт страницы с разным `seq` → предупреждение в stderr, все страницы в stdout.
    2026-09-10: CLI-часть выполнена (TI-037, `src/cli/run.ts` `walkPages`, тест `tests/cli/reads.test.ts`, а не `cli.test.ts`): предупреждение печатается после полного прохода, вместе с перезапуском при `409 conflict` из плана 03, шаг 11. Серверная keyset-пагинация (шаги 7, 15) и подпись в UI (шаг 9) — у владельцев `src/server` и `src/web`.

## Решение владельца (2026-09-10, делегировано Fable)

- Пагинация: контракт по видам лент принят. Журналам (события, операции, комментарии) монотонная позиция; списку задач ограниченный повтор с меткой `list_changed_during_walk` и подписью в UI; единственный согласованный полный список это `/api/snapshot`. Отдельный курсор операций делается по плану 04 (`operationSeq`). Правило «журнал не усекается» принято.
- Приоритет по шкале реестра: TI-012 P2, TI-037 P2; дешёвые шаги 1–7 выполняются до рабочего переключения, потому что формат курсора проще менять до появления живых агентов.
