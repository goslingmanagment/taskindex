# TaskIndex v2 — ревью качества кода

Дата: 2026-09-08. Область: незакоммиченное дерево `src/`, `tests/`, `scripts/`, `deploy/`, `skills/`, конфиги. Прочитано всё целиком (кроме `styles.css` — по структуре и метрикам). Баги вне объёма; упоминаются только там, где вытекают из проблемы качества.

## (a) Резюме

Код читается как работа **одного автора с устойчивым почерком**: плотные функции, мало комментариев, английские идентификаторы, русские строки для людей и агентов, единый форматер. Это не «сшитые куски» — за одним исключением: `src/web/styles.css` (2713 строк) явно склеен из трёх слоёв (палитра v1 → «Minimal workspace» → «v2 additions») с 93 повторно определёнными селекторами и 25 мёртвыми классами. Доменное ядро (`shared/commands.ts` + `server/operations.ts` + `web/app/store.ts`) спроектировано хорошо: один редьюсер для сервера и оптимистичного превью, общая проекция событий, идемпотентность по хешу конверта. Главный налог на сопровождение — пять god-функций (897/637/604/433/329 строк) и редьюсер, который сразу после Zod-валидации стирает discriminated union и дальше живёт на 48 `as`-кастах.

| Область      | Оценка | Одной строкой                                                                                                                                                                                  |
| ------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Структура    | 3/5    | Слои и направление зависимостей верные; 5 god-функций, `admin.ts`-свалка, `lib/` vs `app/` в web — случайный разрез                                                                            |
| Читаемость   | 3/5    | Единый стиль и языковая политика; однобуквенные имена, 47 вложенных тернариев, sentinel-строки `'all'/'none'`, лимиты Zod переписаны литералами в JSX                                          |
| Типы         | 3/5    | `any` = 0, `@ts-*` = 0, tsc чистый, типы из `z.infer`; но 94 небезопасных assertion, 7 `JSON.parse` без валидации, клиент не проверяет ответы, нет `never`-проверок                            |
| React        | 3/5    | Compiler-совместимый код, useSyncExternalStore, aria-разметка; prop drilling 11 пропсов, ручные fetch-эффекты ×3, две стилевые системы, CSS-долг                                               |
| Сервер       | 3.5/5  | Транзакционность, таксономия ошибок, OpenAPI из тех же схем; один файл на 19 роутов, конфиг без схемы, 7 инлайн-литералов ошибок, `readState` на каждый GET                                    |
| CLI          | 3.5/5  | Outbox, коды выхода, DI для тестов — продуманно; `runCli` 329 строк, четыре набора флагов в двух файлах, `--json` не делает ничего, нет `today`/`hasFollowUp`                                  |
| Тесты        | 4/5    | Реальные SQLite/Hono/Better Auth, property-тесты с настоящими инвариантами, 0 snapshot, role-селекторы; сценарные мега-тесты, дубли хелперов, e2e пишет в `docs/`, компоненты только через e2e |
| Документация | 4/5    | README/deploy/SKILL точны по всем проверенным пунктам; `--json` и `LOG_LEVEL` мёртвые, три разных пина Node, чеклист лежит в `tests/`                                                          |

## (b) Находки по областям

Обозначения: **важно** — объективно мешает сопровождению или скрывает ошибки; **желательно** — улучшит структуру, окупится при следующем изменении; **вкусовщина** — стиль, спорно.

### 1. Структура модулей

**важно — `createApp` 897 строк** (`src/server/app.ts:175-1071`). Внутри: схемы ответов (99-174), пагинация с курсорами (196-244), обработчик ошибок (259-295), middleware auth+origin+writes+logging в одном замыкании (296-339), 19 `createRoute`, SSE-стрим (752-866), контекст/дайджест/фокус. Предложение:

- `server/http/errors.ts` — `onError`, `defaultHook`, `bodyLimitError()`;
- `server/http/auth-middleware.ts` (296-322) и `server/http/request-log.ts` (323-338) — сейчас один `try/finally` делает четыре дела;
- `server/http/pagination.ts` — `page()`, `cursorSchema`, `checkGeneration`;
- `server/routes/{health,commands,reads,stream,context,digest,focus}.ts`, каждый экспортирует `(api, deps) => api.openapi(...)`;
- `contextSchema`/`digestSchema`/`focusGroupSchema` (99-174) → `shared/domain-schemas.ts`, чтобы CLI и web могли парсить ответы (сейчас CLI держит `context` как `Record<string, unknown>`, `run.ts:472-476`).

**важно — `WorkspaceBody` 637 строк** (`src/web/app/shell.tsx:91-727`). Смешаны: URL-состояние, горячие клавиши (167-199), вывод списков (113-149), построение команд (209-276), шапка (340-529), тело (530-662), три диалога (664-724). Предложение: `useWorkspaceCommands()` (execute/move/change/first/newTask + `notify`) → `web/app/use-commands.ts`; `useKeyboardShortcuts()`; чистый селектор `selectVisibleTasks(data, location, today)` в `web/app/selectors.ts` (тестируемый без React); `WorkspaceHeader`, `WorkspaceEmpty` компоненты.

**важно — `TaskEditor` 604 строки** (`src/web/app/editor.tsx:90-693`). Машина состояний сохранения (`saveIntent`, 132-244), персистенция черновика (145-165), 400 строк JSX, панель конфликта (606-640), дублирующая `dialogs.tsx:351-385`. Предложение: `useTaskDraft(task)`, `useSaveIntent()`, компоненты `ChecklistEditor` (467-566), `WaitingSection` (372-397), общий `ConflictPanel`, `DiscardDialog` (663-690).

**важно — `applyCommand` 433 строки** (`src/shared/commands.ts:225-657`) — см. раздел «Типы». Разбить на `applyUndo` (268-386), `applyProject` (387-421), `applyComment` (422-452), `applyTaskWrite`/`applySync`/`applyChecklist` (453-653) с `switch (command.command)` и `default: never`.

**важно — `runCli` 329 строк** (`src/cli/run.ts:186-514`): справка → клиент/outbox → resume (232-244) → switch путей чтения (248-324) → цикл пагинации+follow+export (337-402, три заботы в одном `do/while`) → сборка конверта (406-504). Разбить: `readPath(args)`, `runRead()`, `followEvents()`, `buildEnvelope(args)`, `runResume()`.

**желательно — `admin.ts` как свалка** (`src/server/admin.ts`): владелец/пароль (34-104), агенты/ключи (105-206), export/validate/import (207-449), restore/writes-gating (450-481) плюс реэкспорт `migrate`/`createAuth` как фасад для `admin-run.ts`. → `server/owner.ts`, `server/agents.ts`, `server/backup.ts`, `server/deployment.ts`.

**желательно — разрез `src/shared/*`** принципиален, но имена вводят в заблуждение: `schemas.ts` = схемы _входа_ (payload команд), `domain-schemas.ts` = схемы _сущностей и ответов_. Переименовать в `command-schemas.ts` / `entity-schemas.ts`. `model.ts` смешивает типы (`z.infer`) с презентационными константами `AREAS`/`STATUSES` (имена, цвета, подсказки; `model.ts:3-38`) — это данные UI, им место в `shared/catalog.ts` или в web. `export { z }` из `schemas.ts:2` заставляет весь код импортировать Zod из файла схем — случайная зависимость.

**желательно — `web/lib/workspace.ts` + `use-workspace.ts` vs `app/store.ts`.** `lib/workspace.ts` — реэкспорт-фасад над `@shared/model` + `makeTask` + тип `WorkspaceData` (дубликат `WorkspaceState` без `comments`, `lib/workspace.ts:5-8`). `use-workspace.ts` содержит `taskSaveCommand`, `editableFields`, хук и реэкспорт `ApiError` (`use-workspace.ts:4`), при этом `dialogs.tsx:30` импортирует `ApiError` из `./api`, а `editor.tsx:3` — из `../lib/use-workspace`. Построение команд размазано по трём файлам: `use-workspace.ts:44-95`, `shell.tsx:214-247`, `activity.tsx:82-91,381-401`. Предложение: `web/app/commands.ts` (чистые билдеры `Command`), `web/app/store.ts`, `web/app/use-workspace.ts`; `lib/workspace.ts` удалить (импортировать из `@shared`), `lib/` оставить для `utils.ts`/`hooks`.

**вкусовщина — 12 файлов > 300 строк**, 8 компонентов > 150 строк (см. метрики). Само по себе не порок, но совпадает с god-функциями.

### 2. Именование и читаемость

**важно — sentinel-строки `'all'` / `'none'` для фильтра проекта**: 14 сравнений в 7 файлах (`shell.tsx` ×4, `dialogs.tsx` ×3, `sidebar.tsx` ×2, `queries.ts:119-121`, `board.tsx:194`, `editor.tsx:356`). Типы `LocationState.project: string` (`url.ts:5`) и `TaskCardProps.projectId: string` (`card.tsx:35`) не отражают три состояния. → `type ProjectFilter = 'all' | 'none' | { id: string }` или хотя бы `const ALL_PROJECTS = 'all'` + `isProjectId()`.

**важно — лимиты Zod переписаны литералами в JSX** (10 мест: `editor.tsx:311,381,436,503,553`, `dialogs.tsx:139,320,332`, `board.tsx:226`, `activity.tsx:469`) и `editor.tsx:560` `draft.checklist.length >= 100` дублирует `checklistSchema.max(100)` (`schemas.ts:43`). При смене лимита в схеме UI разъедется молча. → `export const LIMITS = { title: 240, note: 16000, ... }` в `shared/`, использовать в схемах и JSX.

**желательно — вводящие в заблуждение имена**:

- `first(task)` (`shell.tsx:248`) — «переместить в начало очереди» → `moveToQueueTop`.
- `focusCount` (`shell.tsx:304-311`) считает только «новое от агентов», а не размер Focus → `newFromAgentsCount`.
- `change(task, patch, message)` (`shell.tsx:229-247`) выбирает команду, инспектируя ключи `patch` (`'archived' in patch` → archive/restore, `patch.status` → move, иначе save) — неявная диспетчеризация; лучше три явных функции.
- `json()` в `app.ts:75` строит спецификацию ответа OpenAPI → `jsonResponse`.
- `more` (`editor.tsx:125`) = какие секции раскрыты → `sections`; `foreign` → `fromOtherGeneration`; `saved` → `base`.
- CLI-команда `activity` (`run.ts:268`) ходит в `/api/operations`; UI «Активность»; API `operations` — три имени одной сущности.
- `Task.createdBy/createdByLabel` vs `Comment.actorId/actorLabel` vs `Event.actorId/actorLabel` (`domain-schemas.ts:81-82, 96-97, 131-132`) — две схемы именования актора.
- Вид актора закодирован префиксом id `'agent:'` и проверяется строкой в трёх местах (`queries.ts:75`, `card.tsx:173`, `shell.tsx:307`) → хелпер `isAgentActor(id)` или поле `createdByKind`.

**желательно — вложенные тернарии** (47 по линту): `queries.ts:73-81` (4 уровня, вычисление группы Focus), `shell.tsx:355-367` (5 уровней, заголовок страницы), `shell.tsx:226` (карта статус→имя, дублирует `STATUSES[].name`), `commands.ts:311-321`, `tests/api/helpers.ts:38-47`. Заменить на `switch`/lookup-объекты.

**желательно — магические числа**: две разные политики ретраев для одного понятия — `store.ts:362-363` (`attempt >= 3`, `500 * 2 ** attempt`) и `client.ts:132-137` (`attempt <= 3`, `250 * 2 ** (attempt - 1)`); `app.ts:845` heartbeat 25000; `app.ts:819,834` `desiredSize < -1000`; `sync.ts:47` 60000; `api.ts:26` и `client.ts:82` 15000; `shell.tsx:70` 6500; `store.ts:231` `.slice(-500)`; размер страницы 50 четыре раза в дайджесте (`app.ts:968-985`). → именованные константы.

**желательно — комментарии.** Всего 44 строки комментариев на ~12k строк. Те, что есть, — хорошие «почему» (`operations.ts`, `outbox.ts:112-113`, `app.ts:827-828`, `drafts.ts:86-88`, `db.ts:197`). Не хватает «почему» ровно там, где код неочевиден: `app.ts:178-180` и `410-412` `UPDATE settings SET value=value WHERE key='generation'` (проба записи для `dbWritable`); `card.tsx:105` `onKeyDown={undefined}` после `{...listeners}`; `shell.tsx:648,666,697,708` `key={state.generation}` (remount как сброс); `db.ts:180` `'_'.repeat(61) + p.id` (временный `nameKey` для обхода уникальности); `vite.config.ts:20` `usePolling: true` на macOS.

**вкусовщина — стиль объявлений через запятую** `const a = x, b = y;` и `const [x, setX] = useState(), [y, setY] = useState()` (`shell.tsx:92-110`, `editor.tsx:122-124`, `activity.tsx:134-137`) — только в web, ухудшает диффы. `'use client'` в 14 файлах (Next.js-директива в Vite SPA; `editor.tsx:1` — единственный не сгенерированный). Однобуквенные `p/t/c/f/q/s/o/e/g/x/v` (481 срабатывания `id-length`) — в лямбдах допустимо, в `applyCommand` `p` живёт 400 строк.

**Языковая политика** де-факто последовательна: идентификаторы/комментарии/названия тестов — английские (0 кириллических комментариев, 0 кириллических `it()`), UI/ошибки/`describe()` Zod — русские, документация русская. Нигде не записана — одна строка в README сняла бы вопрос.

### 3. Дублирование

**важно — `commandSchema` и `commandEnvelopeSchema`** (`schemas.ts:219-430`): 32 члена union, набранные руками (2 × 16 по 6-8 строк), отличаются только именем литерала и `...envelopeFields`. Добавление команды = правка в трёх местах (`schemas`, оба union). → строить из `Object.entries(commandPayloadSchemas)` типизированным хелпером; `discriminatedUnion` принимает массив.

**важно — идентичные обработчики** `/api/commands` и `/api/commands/batch` (`app.ts:469-482` vs `496-509`) → `runOperation(c, input, commandName)`.

**важно — инлайн-литералы ошибок `{ ok:false, code, message, retryable }`** в 13 местах при наличии `DomainError.toJSON()`: `app.ts:248-256, 263-271, 276-284, 286-294, 344-353, 361-370, 378-386`, `index.ts:27-35`, `api.ts:30-35, 41-49`, `client.ts:110-117, 194-205`, `run.ts:345-352`.

**важно — три `canonical()`**: `operations.ts:27-34` и `admin.ts:231-238` (идентичны), `outbox.ts:23-32` (другой алгоритм). Сервер хеширует конверт одной канонизацией, CLI сравнивает конверты другой — сегодня совпадают по результату, но это два источника истины для одного контракта. → `shared/canonical-json.ts`.

**желательно**:

- Парсинг булевых query `q.x === 'true' || q.x === '1'` ×4 (`app.ts:565-574`) → `booleanQuery = z.enum([...]).transform(...)`.
- `sleep` по умолчанию ×3 (`store.ts:66`, `client.ts:136`, `run.ts:389`).
- Продолжение пагинации `new URL(path, baseUrl); set(...); path = ...` ×2 (`run.ts:381-383`, `397-401`).
- `resultCompleted()` (`run.ts:177-184`) повторяет логику `ApiClient.resume` (`client.ts:209-222`).
- Запись черновика `writeDraft(key, { formatVersion: 1, generation, baseRevision, fields, id, operationId })` ×7 (`editor.tsx:153,216`, `dialogs.tsx:73,240`, `board.tsx:182,233`, `activity.tsx:338`) → хук `useDraft(key, fields)`.
- Панель конфликта «Актуальная версия / Совместить и проверить» ×2 (`editor.tsx:606-640`, `dialogs.tsx:351-385`).
- Ручной жизненный цикл запроса с флагом `flight.active`/`active` ×3 (`activity.tsx:142-179, 236-251, 347-375`) → `useRequest(path, deps)`.
- Блок `alias` в `vite.config.ts:8-12` и `vitest.config.ts:6-10`.
- Health-проба `node -e 'fetch("http://127.0.0.1:3000/health")...'` ×4 (`deploy/common.sh:34`, `local-drill.sh:37,91`, `compose.yml:32`) → `deploy/health.mjs`.
- `'Без направления'` ×6 в 4 файлах.
- Тесты: `MemoryStorage` ×2 (`store.test.ts:12`, `drafts.test.ts:4`); `setup()/cleanup` ×3 (`commands.test.ts:19-27`, `recovery-and-history.test.ts:15-21`, `auth.test.ts:19-20`); `command()/snapshot()` в обоих e2e-спеках с разными сигнатурами (`workspace.spec.ts:65-83` vs `regressions.spec.ts:8-19`).

**Хорошо:** применение событий сервер↔клиент **не** дублировано — `applyEvent` из `shared/commands.ts` используется и в `store.ts:217`, и в `admin.ts:318`; оптимистичное превью переиспользует `applyCommand` (`store.ts:88`).

### 4. Типобезопасность

Счёт: `any` — 0; `@ts-expect-error/ignore` — 0; `as unknown as` — 1 (`admin.ts:308`); `as`-касты — 84 (48 в `commands.ts`); non-null `!` — 24 (drafts 7, commands 8); `Record<string, unknown>` — 19; `JSON.parse` — 7; `typescript/no-unsafe-type-assertion` — 94 в `src`.

**важно — `applyCommand` стирает union** (`commands.ts:230-231`): `const command = parseCommand(raw); const p = command.payload as Record<string, unknown>;` — сразу после валидации дискриминированного union он приводится к мешку, и дальше 48 кастов (`p.id as string`, `payload.area as Task['area']`, `p.position as {...}`, `(record as Task)`, …, `commands.ts:390-398, 406, 425-434, 443, 486-519, 533, 580, 592-599, 606-612`). Диспетчеризация — по `name.startsWith('project.')` / `'comment.'` / `else` (387, 422, 453) и цепочка `if/else if` с **catch-all `else`** для чеклиста (`commands.ts:600-603`): новая команда `task.*`, не перечисленная выше, молча уйдёт в ветку чеклиста. → `switch (command.command)` с сужением payload и `default: assertNever(command)`. Также `get()` возвращает `Entity` и вызывающие кастуют (`as Task/Project/Comment` ×9) → перегрузка `get(state, 'task', id): Task`.

**важно — `JSON.parse` без валидации при наличии схем**: `store.ts:385-386` (`any` → `saved: OperationEnvelope[]` по проверке двух полей), `drafts.ts:38-39` (`any` возвращается как `Draft<T>`), `sync.ts:25` (`store.ingest([JSON.parse(event.data)])` — `eventSchema` существует и не используется), `outbox.ts:63-70` (каст + частичные ручные проверки). Единственный правильный пример — `app.ts:211-212` с `cursorSchema`.

**важно — клиент не валидирует ответы**: `api.ts:74` `return value as T`; `use-workspace.ts:67,94` `results[0].record as Task/Project`; `editor.tsx:239` `e.current as Task`, `dialogs.tsx:284` `e.current as Project` (`current: Entity`, вид не проверен). Все схемы уже общие — `request(path, schema)` заставит контракт работать на обеих сторонах.

**желательно — нет проверок исчерпывающости**: `activity.tsx:21` `labels: Record<string, string>` → `Record<CommandName | 'batch', string>` (компилятор сам укажет пропущенную команду); `ChangeEffect.command: string` (`commands.ts:23`), `eventSchema.command: z.string()` (`domain-schemas.ts:137`), `operationSummarySchema.command` → `z.enum(commandNames)`; `records()`/`isSubjectField()` — тернарии без `never`.

**желательно — 8 избыточных `!`** (`commands.ts:175,176,296,306,628`, `queries.ts:82`, `arguments.ts:24`, `run.ts:460`): написаны под `noUncheckedIndexedAccess`, которого в `tsconfig.json` нет (только `strict`). Решить: либо включить опцию (тогда появятся новые ошибки и `!` станут осмысленными), либо убрать. `drafts.ts:105-165` `storage!.key(i)!` в циклах → локальная `const s = storage; if (!s) return`.

**желательно — прочее**: `auth.ts:59,72` `['read','tasks','write'].includes(key.scope ?? '')` затем `as Actor['scope']` → `actorSchema.shape.scope.safeParse`; `app.ts:481,508` `result.status as 200` (обход типизации hono); `db.ts:123,136,162` строки Drizzle → домен через `as Project/Task/DomainEvent` без маппера (единственный тип-риск — рассинхрон колонок и схемы, но его ловит `migrations.test.ts`); `ApiReply.body: Record<string, unknown>` — CLI строково-типизирован против собственного API (`client.ts:13`, `exitCode`).

**Хорошо:** все доменные типы — `z.infer` (`model.ts:41-60`), рукописных дублей нет; JSON-колонки Drizzle типизированы `$type<Changes>()`/`$type<OperationResponse>()` (`schema.ts:51-53, 109-111, 130`); `Env.Variables` для hono типизирован (`app.ts:72-74`).

### 5. Обработка ошибок

**Таксономия одна** — `DomainError`/`fail()` (`shared/errors.ts`) с централизованной картой статусов; используется в shared/server последовательно. `ApiError` в web зеркалит `OperationError` (`api.ts:2-12`). CLI вводит вторую таксономию кодов (`invalid_arguments | client_error | network_error | invalid_response | admin_error`, `run.ts:455,509`, `client.ts:113,174`, `admin-run.ts:227`) — для CLI допустимо, но `errorCodeSchema` (`domain-schemas.ts:199-209`) о ней не знает и SKILL.md перечисляет только `status: unknown`.

**важно** — 13 инлайн-литералов ошибок в обход `DomainError.toJSON()` (см. п. 3).

**желательно** — проглоченные промисы: `.catch(() => {})` ×10 (`store.ts:194,234,260,358,418`, `shell.tsx:520,565`, `sync.ts:34,42`); намерение понятно (ошибка `refresh` уже попадает в `state.error`), но объяснено только в 3 из 10. → `ignoreRejection(promise, 'reason')` или комментарий. `store.ts:372` `throw new Error('Версия базы изменилась.')` внутри `catch` теряет причину (`preserve-caught-error`). Имя переменной в `catch`: `e` в web/CLI, `error` на сервере (20 срабатываний `catch-error-name`).

**желательно — логирование**: `console.error(JSON.stringify({ code: 'internal', error: error.name }))` (`app.ts:285`) пишет только имя класса без сообщения и стека — в проде такое не отладить; `x-request-id` генерируется (`app.ts:330`), но не возвращается клиенту заголовком; `LOG_LEVEL` объявлен в `compose.yml:15`/`.env.example:7` и не читается нигде.

**Хорошо:** поверхности ошибок в UI согласованы — тосты для действий (`shell/card/board/activity/auth`), инлайн `form-error` с `role=alert` для форм (`editor/dialogs/activity`), баннер `pending-notice` для неизвестного исхода (`shell.tsx:531-555`), `Empty` для ошибки загрузки (`shell.tsx:561-569`). CLI: все ошибки — JSON в stdout, диагностика — stderr, коды выхода документированы и покрыты тестами.

### 6. React

**важно — prop drilling**: `TaskCardProps` — 11 пропсов (`card.tsx:32-53`), собираются в `shell.tsx:277-295` и прокидываются через `DragBoard`/`Board`/`WorkspaceOverview` как `renderTask`; `WorkspaceSidebar` — 10 пропсов (`sidebar.tsx:31-53`), 5 из них навигационные колбэки. → контекст/хук `useNavigation()` поверх `useLocationState`, `useWorkspaceCommands()`; `Board` получает три булевых `archive/filtered/disabled` (`board.tsx:283-285`).

**важно — CSS**: `styles.css` 2713 строк, две палитры `:root` (строки 55 и 1608) и две `.dark` (87, 1634) — вторая перекрывает первую; маркеры слоёв `/* Minimal workspace ... */` (1607) и `/* v2 additions ... */` (2467); 93 селектора определены более одного раза (`.editor-body`, `.side-footer`, `.nav-section-heading` ×3; `.task-card`, `.toolbar`, `.task-sheet` ×2); 25 классов не встречаются в `src/web` (`demo-dot`, `demo-notice`, `topbar`, `topbar-right`, `avatar`, `tiny-avatar`, `breadcrumbs`, `rename-project`, `save-failed`, `sample-mark`, …). `workspace-overview.css` (55 строк) импортируется из `overview.tsx:6`, но определяет `.focus-hint/.focus-mark/.focus-count/.task-context`, используемые в `shell/card/sidebar/activity` — файл назван и размещён неверно. Две стилевые системы: `ui/*` — Tailwind+cva, `app/*` — ноль Tailwind (3 утилиты Skeleton в `shell.tsx:574-576`) и рукописные классы. Это осознанный выбор «не редизайн, эталон один в один», но долг реальный; e2e-скриншоты дают страховку для чистки.

**желательно — эффекты**: `shell.tsx:200-208` синхронизация состояния в эффекте (`update({ project: 'all' })` при невалидном проекте) — можно в `read()`/селекторе; `editor.tsx:145-165` эффект зависит и от `dirty`, и от его входов; `dialogs.tsx:71-81, 239-258` пишут черновик при монтировании с пустыми полями (создают мусорные записи `title: ''`); `board.tsx:150-163` `useEffect(() => subscribeDraft(...))` — это `useSyncExternalStore`; три ручных fetch-эффекта (`activity.tsx`) — см. п. 3. `useMemo/useCallback` в app-коде отсутствуют (только `url.ts:59`) — соответствует включённому `react/react-compiler`; сгенерированный `ui/sidebar.tsx` их использует — норма.

**желательно — a11y**: `editor.tsx:319` `<label htmlFor="Состояние задачи">` + `SelectTrigger id={label}` (`editor.tsx:77`) — человеческая строка как DOM-id, дублирует `aria-label`; `card.tsx:103-110` пустой `<button>`-оверлей с `{...listeners}` и `onKeyDown={undefined}` внутри `<article>` рядом со второй кнопкой-ручкой и меню — вложенные интерактивные зоны, причина хака не записана; 7 `<button>` без `type` (`card.tsx:103,112,273`, `shell.tsx:347,375,399`); `<output>` как контейнер статуса (`shell.tsx:423,534`, `activity.tsx:211`) — семантически «результат вычисления». В остальном aria-разметка хорошая: подписи у всех иконок-кнопок, `role=alert`, `aria-live` у статуса синхронизации, sr-only заголовки Sheet, русские инструкции для клавиатурного DnD (`board.tsx:88-93`).

**желательно — захардкоженное**: `'Дмитрий'` ×3 (`auth.tsx:118` fallback, `store.ts:102` актор превью, `lib/workspace.ts:29`) — брать из `session.user.name`; `'Europe/Moscow'` ×4 (`store.ts:47`, `app.ts:187`, `db.ts:92`, `queries.ts:108`).

**вкусовщина — мёртвые `ui/*`**: `separator.tsx`, `tooltip.tsx` нужны только `ui/sidebar.tsx`; ~60 сгенерированных экспортов не используются (`SidebarRail`, `SidebarGroup*`, `DropdownMenuSub*`, `Toast*`-части, `Progress*`, `Select*`-части, `Dialog*/AlertDialog*`-части). Норма для shadcn; либо подрезать, либо принять.

### 7. Сервер

**важно — конфиг без схемы**: env читается ad hoc в `index.ts:6-25` (8 переменных, `BUILD ?? BUILD_ID` — два имени одного), `admin-run.ts:85,94-96,136-137,204` (6), `scripts/dev.mjs:10-13` (3). Zod под рукой → `server/config.ts` с `z.object({...}).parse(process.env)` и одним источником имён/значений по умолчанию.

**желательно — `readState` на каждый GET** (`db.ts:118-147`): загружает всё и соединяет в JS (`items.filter` и `comments.filter` на каждую задачу); `/api/tasks/{id}` (`app.ts:614`), `/api/tasks/{id}/comments` (`641`), `/api/tasks/by-origin` (`599`) читают весь workspace ради одной записи; `readOperations` делает до 3 запросов заголовков на операцию (`db.ts:253-262`) и вызывается целиком ради одной операции в `/api/operations/{id}` (`app.ts:736`); `page()` хеширует `JSON.stringify(items)` всего списка на каждую страницу (`app.ts:205-207`). Для личного масштаба терпимо; как структура — доступ к данным не отделён от HTTP.

**желательно — транзакции**: `db.sqlite.transaction(() => ...).immediate()` ×6 + 3 read-транзакции без хелпера → `withWrite(db, fn)` / `withRead(db, fn)`, чтобы `.immediate()` не забывался. `writeState` (`db.ts:165-233`) — diff по `JSON.stringify` + `.find` O(n²), трюки с временными ключами `~${id}` / `'_'.repeat(61)+id` объяснены одним комментарием на два приёма.

**вкусовщина — SQL**: Drizzle для CRUD, raw для `settings`-пробы (×2), `sqlite_sequence` (`admin.ts:440-445`), `COALESCE(MAX(seq))` — прагматично; `Object.assign(completeApi, { closeStreams })` (`app.ts:1066-1070`) — расширение экземпляра hono вместо возврата `{ app, close }`.

### 8. CLI

**важно — четыре набора флагов в двух файлах**: `switches` (`arguments.ts:8-18`) vs `controls` / `jsonFlags` / `booleanFlags` (`run.ts:90-111`) обязаны совпадать вручную; `HELP.flags` (`run.ts:62-73`) — третья копия. `--json` присутствует в `switches`, `controls`, `HELP` и **никогда не читается** — no-op (вывод всегда JSON). → декларативная спецификация флагов (или `node:util.parseArgs`), из которой генерируются и парсер, и `HELP`.

**важно — help vs реальность / паритет с API**: `tasks` принимает `--q --area --project --status --archived --focus --limit --cursor --generation` (`run.ts:256-266`), в справке ни один фильтр не упомянут (`run.ts:37`); API дополнительно поддерживает `today` и `hasFollowUp` (`app.ts:551-552`), CLI их не пропускает — агент не может воспроизвести фильтр «На сегодня» из UI, что нарушает принцип паритета из плана.

**желательно — `ApiClient.request`** (`client.ts:92-103`) — два транспорта: hono `hc<AppType>` для двух POST и raw `fetch` для остального; конверты уже проверены Zod, RPC не добавляет ничего, кроме зависимости CLI от типа всего сервера. Выбрать один.

**SKILL.md — сверено с кодом**, расхождений нет: `tasks -q` (`arguments.ts:34` нормализует `-q`), `find-origin --system --ref`, форма payload `sync`, `applied/skipped`, `undo SEQ | --operation ID`, `batch --file` (массив или `{commands}`), путь outbox `$XDG_STATE_HOME/taskindex/ops`, коды выхода 0/1/2/3/4. Пропуски: `task focus`, `export --out`, обязательность `--base-revision` для `checklist.*`/`project update`, что `context.fields/commands` — JSON Schema.

**Хорошо:** `outbox.ts` — атомарная публикация `link()` без перезаписи + `fsync` + 0600 с объяснением (`100-132`); `CliOptions` с инъекцией `fetch/sleep/stdout/stderr/readInput` (`run.ts:23-32`) делает CLI полностью тестируемым без сети.

### 9. Тесты

**Хорошо (существенно):** api-тесты идут через реальные `:memory:` SQLite + `migrate` + `createApp` + `app.request` (`tests/api/helpers.ts:28-48`); auth/agent-cycle/e2e — с настоящим Better Auth; `agent-cycle.test.ts:80-92` теряет ответ _после_ коммита реальной транзакции — честная проверка идемпотентности. Утверждения конкретные: 470 `expect` на 93 теста, 0 `toBeTruthy`, 0 snapshot. Property-тесты проверяют настоящие инварианты: `projection == state` после каждой команды + `assertInvariants` + монотонность revision (`property/commands.test.ts:60-66`); undo восстанавливает предметные поля без отката revision (`property/undo.test.ts:101-105`). `migrations.test.ts` триангулирует Drizzle-снимок ↔ `schema.ts` ↔ живые `PRAGMA`. e2e-селекторы — почти только `getByRole/getByLabel/getByText`.

**желательно — сценарные мега-тесты**: заголовки на 3-4 поведения (`commands.test.ts:29` «preserves Focus through retries, stale edits, snapshot and archive restoration», `:132`, `:180`, `recovery-and-history.test.ts:22`; 5 заголовков > 100 символов) — при падении локализация хуже, поведения не независимы. `describe` есть в `commands`/`unit`, отсутствует в `recovery`/`auth`/`durability` — непоследовательно.

**желательно — property-тесты узкие**: только актор `owner` (пути `ownerFields`/`sync`/скоупы агентов генераторами не покрыты), фиксированные 3 задачи, нет проектов/удаления комментариев/`checklist.reorder`, `numRuns: 75`.

**желательно — источники хрупкости e2e**: одна БД на все спеки, `workspace.spec.ts:416-427` переносит задачи других тестов в `personal`, чтобы очистить доску (связь через общее состояние); `regressions.spec.ts:38-44` вычисляет фиктивный IP из регэкспа заголовка `B(\d+)` для обхода rate limit входа — остроумно, но два теста `B01` делят корзину; `waitForTimeout(260/60)` (`workspace.spec.ts:590,596`); модульная переменная `ownerCookies` мутируется тестами (`:12,46,703`).

**желательно — артефакты в дереве исходников**: `workspace.spec.ts:10-30` по умолчанию пишет PNG и `screenshots-sha256.json` в `docs/reference/v2-validation`; путь не в `.gitignore` (`git check-ignore` → not ignored). По умолчанию должен быть `test-results/`, а публикация в `docs/` — явным флагом.

**желательно — дубли хелперов** (см. п. 3) → `tests/helpers/{fixture,storage,http}.ts`.

**Покрытие по модулям** (прямой импорт из тестов): покрыты `shared/{commands,queries,schemas,domain-schemas,model}`, `server/{app,db,operations,admin,auth,schema}`, `cli/{run,outbox,admin-run}`, `web/app/{store,drafts,api}`, `web/lib/{use-workspace,workspace}`. Без прямых тестов: `cli/arguments.ts` (только через `runCli`; нет юнитов на `--k=v`, `--`, `-q`, switch со значением), `cli/client.ts`, `web/app/url.ts` (0 тестов на round-trip URL↔state и localStorage-fallback), `web/app/sync.ts` (0 тестов: reconnect/reset/`operations`-события EventSource — только косвенно e2e), все React-компоненты (только e2e), `server/index.ts` (bootstrap/shutdown), `deploy/database.mjs` (только drill).

**`tests/e2e/agent-cycle.md`** — да, ручной чеклист приёмки в папке тестов; `tests/cli/agent-cycle.test.ts` автоматизирует шаги 1, 2, 5, 6 частично, шаги 3, 4, 7 (браузер+агент одновременно, undo пакета из UI, перезагрузка с неподтверждённой операцией и `mark-restored`) остаются ручными. → `docs/acceptance/agent-cycle.md` с пометкой, какие шаги автоматизированы; `deploy/README.md:74` ссылается на него как на приёмку.

### 10. Скрипты, конфиги, документация

**желательно — `package.json`**: `lint`/`format:check` перечисляют 8-13 путей (`package.json:14,16`), хотя `.oxlintrc.json` уже имеет `ignorePatterns`; в результате `deploy/database.mjs` ни линтится, ни форматируется, ни типизируется (`allowJs: false`), `drizzle.config.ts` не линтится, `deploy/*.yml`, `*.md`, `.oxlintrc.json`, `components.json` не форматируются. → `oxlint .` / `oxfmt --check .` + ignore. `date-fns` в `dependencies` (`package.json:37`) не используется ни в одном файле `src`.

**желательно — `tsconfig.paths`**: `@/*` и `@web/*` оба → `src/web` (`tsconfig.json:16-17`, продублировано в `vite.config.ts`, `vitest.config.ts`); ответ на «зачем два»: `@/` требуется генератору shadcn (`components.json` aliases `@/app`, `@/ui`, `@/lib`), `@web` — человеческий; **ни один не используется** в `src` (0 импортов), используется только `@shared` (13). Убрать `@web`. Стиль импортов расщеплён: server/cli/shared — `./x.js` (71), web — без расширения (111); оба работают под `moduleResolution: bundler`, но это два соглашения в одном репозитории.

**желательно — `.oxlintrc.json`**: категория только `correctness` + 19 правил. Что дали бы выключенные (по `src+tests+scripts`): `suspicious` — всего 11 (`no-shadow` 10, `preserve-caught-error` 1) — включать без раздумий; `perf` — 31, все `no-await-in-loop` (в основном осознанная последовательная пагинация и тесты); `pedantic` — `max-lines-per-function` 70, `require-unicode-regexp` 25, `require-await` 19, `max-depth` 12; `style` — шум (`sort-keys` 764, `no-magic-numbers` 700, `id-length` 481, `curly` 416), но `no-nested-ternary` 47, `max-statements` 81, `max-params` 9 — сигнал; плагин `typescript` вне `correctness`: `no-unsafe-type-assertion` 139, `no-non-null-assertion` 95, `no-unnecessary-type-assertion` 54, `prefer-nullish-coalescing` 22; `react/button-has-type` 7; `unicorn/catch-error-name` 20, `switch-case-braces` 21. Рекомендуемый минимум: `suspicious`, `typescript/no-non-null-assertion` (warn), `typescript/no-unnecessary-type-assertion`, `typescript/prefer-nullish-coalescing`, `eslint/no-nested-ternary`, `eslint/max-lines-per-function` (warn, 120), `react/button-has-type`, `unicorn/catch-error-name`.

**Документация — проверено, совпадает с кодом**: README (порты 5173/3001, поведение `setup:dev`, `admin` флаги `--email/--agent/--scope/--out`, `npm run cli -- --help` — печатает JSON-справку, `SCHEMA_VERSION` в `shared/model.ts`, `data/dev.db`, e2e во временной папке), `deploy/README.md` (3100 → 127.0.0.1, `stop_grace_period 20s`, litestream 0.5.12, поля `/health`, семантика `--replace`, `TASKINDEX_FAIL_AT`), SKILL.md (см. п. 8). Расхождения/мелочи: три пина Node — README «24.20.0», `engines` `>=24.11.0 <25`, `.nvmrc` `24` (`.node-version` и Dockerfile — 24.20.0); README не упоминает `--password-op op://` (`admin-run.ts:41,67`); `LOG_LEVEL` мёртв; `TIMEZONE` потребляет только `taskindex-admin migrate` (`admin-run.ts:94`), README подаёт как конфиг сервера; `deploy/README.md:74` шлёт к ручному чеклисту.

**deploy/\*.sh — высокое качество ops-скриптинга**: `set -Eeuo pipefail`, `umask 077`, ERR-ловушки с фазами, `flock`, файл границы «запись открыта» до вызова команды, отказ от отката после границы. Мелочи: 27 строк длиннее 140 символов (`deploy.sh:34,70-72`, `local-drill.sh:37,50,66,119`); `for command in docker git curl jq flock` (`deploy.sh:17`) затеняет builtin `command` (работает, но путает); `common.sh` зависит от `$repo` вызывающего (задокументировано в строке 2); четыре копии health-пробы; `local-drill.sh` содержит 4 heredoc-программы Node (`46-52, 70-78, 81-86, 112-118`) → `deploy/drill/*.mjs`. `scripts/dev.mjs:7-8` грузит `.env` через `loadEnvFile`, а дочерний процесс — ещё раз через `--env-file-if-exists=.env` (строка 19).

**TODO/FIXME**: 0. Заголовки файлов: нет (последовательно). Неиспользуемые экспорты (кроме `ui/*`): `initializeDatabase` (`db.ts:97`), `serverId` (`outbox.ts:144`), `requireScope`, `compareStrings`, `Agent`, `revisionSchema/checklistItemSchema/originSchema/positionSchema/taskFieldsSchema` (экспорт без потребителя), `PendingOperation.attempts` (никогда не инкрементируется) и `.message` (никогда не читается — `shell.tsx:536-538` показывает фиксированные строки) (`store.ts:17,20`), `pendingCount` (`use-workspace.ts:43`), `editableFields`, `HELP`, `authClient`.

### 11. Вердикт о ремесле — образцы

**Лучшее:**

`src/server/operations.ts:51-82` — одна транзакция: поколение, повтор по хешу, чужой operationId, mismatch — читается как спецификация:

```ts
if (old) {
  if (old.actorId !== actor.id)
    fail('forbidden', 'Идентификатор операции принадлежит другому актору.');
  if (old.commandHash !== hash)
    fail(
      'operation_mismatch',
      'Этот operationId уже использован для другого запроса.',
    );
  return {
    status: old.status,
    body: old.result,
    freshEvents: [],
    freshOperation: false,
  };
}
```

`src/cli/outbox.ts:111-114` — редкий здесь комментарий «почему», ровно там, где нужен:

```ts
// link() is an atomic, no-overwrite publication: concurrent invocations
// cannot replace another request that has the same operationId.
await link(temporary, destination);
```

`src/web/app/store.ts:199-214` — буферизация до полной границы операции (`firstSeq..lastSeq`) перед применением: клиент никогда не показывает половину пакета.

`tests/api/migrations.test.ts:24-25` — `generateSQLiteMigration(snapshot, current)` должен быть пустым: схема, снимок и БД не могут разъехаться незаметно.

**Худшее:**

`src/shared/commands.ts:230-231` — union валидируется и немедленно выбрасывается, дальше 48 кастов:

```ts
const command = parseCommand(raw);
const p = command.payload as Record<string, unknown>;
```

`src/shared/schemas.ts:219-430` — 32 union-члена, отличающиеся одним литералом (фрагмент):

```ts
z.object({ ...envelopeFields, command: z.literal('task.create').describe('Имя команды'), payload: schemas['task.create'].describe('Параметры команды') }).strict(),
z.object({ ...envelopeFields, command: z.literal('task.sync').describe('Имя команды'),   payload: schemas['task.sync'].describe('Параметры команды') }).strict(),
```

`src/web/app/shell.tsx:355-367` — заголовок страницы пятиуровневым тернарием:

```tsx
{
  searching
    ? 'Поиск'
    : activity
      ? 'Активность'
      : focusView
        ? 'Фокус'
        : archive
          ? 'Архив'
          : project?.name ||
            (projectId === 'none' ? 'Без направления' : current.name);
}
```

`src/web/styles.css:55` и `:1608` — две палитры `:root`, вторая перекрывает первую; между ними 1500 строк, часть из которых уже мертва.

Итог: **одна связная кодовая база с последовательным голосом**, а не набор сгенерированных фрагментов; человек разберётся в доменном ядре за полдня. Ремесленный долг сосредоточен в предсказуемых местах — длина функций, касты в редьюсере, склеенный CSS — и снимается механическими рефакторингами под уже существующим тестовым покрытием.

## (c) Метрики

| Метрика                                      | Значение                                                                                                                                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsc --noEmit`                               | 0 ошибок                                                                                                                                                                                                               |
| `npm run lint` (проектный конфиг)            | 0 предупреждений/ошибок                                                                                                                                                                                                |
| `npm run format:check`                       | 88 файлов, чисто                                                                                                                                                                                                       |
| `vitest run`                                 | 14 файлов, 75 тестов, все зелёные, 1.4 с                                                                                                                                                                               |
| `any` / `@ts-expect-error` / `as unknown as` | 0 / 0 / 1                                                                                                                                                                                                              |
| `as`-касты (кроме `as const`, import/export) | 84 (`commands.ts` 48, далее ≤3 на файл)                                                                                                                                                                                |
| `typescript/no-unsafe-type-assertion` (src)  | 94                                                                                                                                                                                                                     |
| Non-null `!` (src)                           | 24 (`drafts.ts` 7, `commands.ts` 8); из них избыточных (`no-unnecessary-type-assertion`) — 8                                                                                                                           |
| `Record<string, unknown>`                    | 19 (`commands.ts` 6, `run.ts` 5, `client.ts` 3)                                                                                                                                                                        |
| `JSON.parse` в src                           | 7 (валидировано схемой — 1)                                                                                                                                                                                            |
| `.catch(() => {})` / `void promise`          | 10 / 34                                                                                                                                                                                                                |
| `console.*` в src                            | 2 (`app.ts:285,328`)                                                                                                                                                                                                   |
| Файлы > 300 строк                            | 12 (`app.ts` 1072, `shell.tsx` 727, `ui/sidebar.tsx` 719, `commands.ts` 696, `editor.tsx` 693, `run.ts` 514, `activity.tsx` 504, `admin.ts` 481, `schemas.ts` 446, `store.ts` 423, `dialogs.tsx` 407, `board.tsx` 349) |
| Функции > 60 строк (src)                     | 33; топ: `createApp` 897, `WorkspaceBody` 637, `TaskEditor` 604, `applyCommand` 433, `runCli` 329, `ProjectDialog` 222, `runAdmin` 216, `TaskCardContent` 216, `TaskDiscussion` 195, `executeOperation` 165            |
| Компоненты > 150 строк                       | 8                                                                                                                                                                                                                      |
| Комментарии в src                            | 44 строки (0 кириллических); TODO/FIXME — 0                                                                                                                                                                            |
| `styles.css`                                 | 2713 строк, 138 классов, 2 `:root` + 2 `.dark`, 93 селектора определены >1 раза, 25 классов не используются, `@apply` — 3, media-запросов — 11                                                                         |
| Tailwind-утилиты в `app/*.tsx`               | 3 (только Skeleton)                                                                                                                                                                                                    |
| Неиспользуемые зависимости                   | `date-fns`                                                                                                                                                                                                             |
| Неиспользуемые экспорты                      | ~20 в app-коде (см. п. 10), ~60 в сгенерированных `ui/*`                                                                                                                                                               |
| Sentinel `'all'/'none'`                      | 14 сравнений в 7 файлах                                                                                                                                                                                                |
| `maxLength` литералы в JSX, дублирующие Zod  | 10                                                                                                                                                                                                                     |
| oxlint по категориям (src+tests+scripts)     | suspicious 11; perf 31; pedantic ≈180 (`max-lines-per-function` 70); style ≈3300 (шум) + `no-nested-ternary` 47, `max-statements` 81; restriction ≈170 (`no-void` 44, `no-undefined` 59)                               |
| Тесты                                        | 93 `it/test`, 470 `expect`, 0 `toBeTruthy`, 0 snapshot, 8 `toBeDefined`, 2 `waitForTimeout`, заголовков >100 симв. — 5                                                                                                 |
| e2e-локаторы по CSS                          | 14 (остальное — role/label/text)                                                                                                                                                                                       |

## (d) Приоритетный список рефакторингов

| #   | Что                                                                                                                                                                                                                                  | Где                                                                                     | Усилие |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------ |
| 1   | `applyCommand` → `switch (command.command)` с сужением payload, `assertNever`, типизированный `get<K>()`; убрать 48 кастов и catch-all `else`                                                                                        | `shared/commands.ts:225-657`                                                            | M      |
| 2   | Генерировать `commandSchema`/`commandEnvelopeSchema` из `commandPayloadSchemas`; `command` в событиях/эффектах → `z.enum(commandNames)`                                                                                              | `shared/schemas.ts:219-430`, `domain-schemas.ts:137`, `commands.ts:23`                  | S      |
| 3   | Разрезать `createApp`: `http/{errors,auth-middleware,request-log,pagination}.ts`, `routes/*.ts`; схемы `context/digest` → shared; `runOperation()` вместо двух копий                                                                 | `server/app.ts`                                                                         | M      |
| 4   | Декомпозиция `WorkspaceBody`: `useWorkspaceCommands`, `useKeyboardShortcuts`, `selectVisibleTasks`, `WorkspaceHeader`, `WorkspaceEmpty`; убрать prop drilling через `useNavigation()`                                                | `web/app/shell.tsx`, `card.tsx`, `sidebar.tsx`                                          | M      |
| 5   | `TaskEditor`: `useDraft(key)` (заменит 7 копий `writeDraft`), `useSaveIntent`, `ChecklistEditor`, общий `ConflictPanel` с `ProjectDialog`                                                                                            | `web/app/editor.tsx`, `dialogs.tsx`, `board.tsx`, `activity.tsx`                        | M      |
| 6   | CSS: слить три слоя в одну палитру, убрать 93 дубля и 25 мёртвых классов, влить `workspace-overview.css`; проверить по e2e-скриншотам                                                                                                | `web/styles.css`, `web/app/workspace-overview.css`                                      | M      |
| 7   | `server/config.ts` на Zod; убрать `BUILD_ID`, `LOG_LEVEL` (или начать читать); `shared/LIMITS` для лимитов, использовать в схемах и JSX                                                                                              | `server/index.ts`, `cli/admin-run.ts`, `deploy/compose.yml`, `web/app/*`                | S      |
| 8   | Валидация на границах: `request(path, schema)` в web, `eventSchema` в `sync.ts`, схема конверта в `store.recover`, `Draft` в `drafts.ts`, `SavedOperation` в `outbox.ts`                                                             | `web/app/api.ts`, `sync.ts`, `store.ts:385`, `drafts.ts:38`, `cli/outbox.ts:63`         | S–M    |
| 9   | Линт: включить `suspicious` + 7 правил из п. 10; починить 24 `!`, 7 `type`, `catch` → `error`; решить судьбу `noUncheckedIndexedAccess`; `oxlint .`/`oxfmt --check .` вместо списков; удалить `date-fns`, `@web`                     | `.oxlintrc.json`, `package.json`, `tsconfig.json`                                       | S      |
| 10  | CLI: разрезать `runCli`; единый реестр флагов, генерирующий `HELP`; убрать `--json`; добавить `today`/`hasFollowUp`; `canonical()` → `shared/`; тесты: `tests/helpers/`, `agent-cycle.md` → `docs/`, артефакты e2e → `test-results/` | `cli/run.ts`, `cli/arguments.ts`, `server/operations.ts`, `server/admin.ts`, `tests/**` | M      |

## (e) Что запускалось и проверялось

- Node 24.20.0 (`/private/tmp/taskindex-v2-tools/...`): `npx tsc --noEmit` → exit 0; `npm run lint` → 0; `npm run format:check` → 88 файлов чисто; `npx vitest run` → 14/14 файлов, 75/75 тестов, 1.39 с. E2E, build, docker, миграции — не запускались (read-only).
- `oxlint -c .oxlintrc.json --deny {suspicious,perf,style,pedantic,restriction,nursery}` и `-A all -D <rule>` для 10 правил — подсчёт срабатываний и точные `file:line`.
- Скрипт на TypeScript Compiler API (в scratchpad): длина функций/методов/стрелок > 60 строк; экспортируемые символы без ссылок из других файлов.
- grep-метрики: `any`, `as`, `!`, `Record<string, unknown>`, `JSON.parse`, `.catch(() => {})`, `void`, `console.*`, TODO, `'use client'`, магические числа, `maxLength`, sentinel-строки, `'Дмитрий'`, `'Europe/Moscow'`, дубли `canonical`/`sleep`/health-пробы, стиль импортов, использование алиасов, зависимостей из `package.json`.
- CSS: число `:root`/`.dark`, дубли селекторов, классы из `app/*.tsx` без определения, классы из CSS без использования в `src/web`.
- Сверка README / `deploy/README.md` / `SKILL.md` / `HELP` с кодом: флаги `admin-run.ts`, allowed-списки `run.ts`, query-схемы `app.ts`, `compose.yml`, `Dockerfile`, `setup-dev.mjs`, коды выхода `client.ts`.
- `git check-ignore` для артефактов e2e; карта импортов `tests → src`.

## (f) Что проверено и признано хорошим

- Zod-first контракт: все доменные типы — `z.infer`, OpenAPI генерируется из тех же схем (`app.ts:1056-1065`), рукописных дублей типов нет; JSON-колонки Drizzle типизированы.
- Один редьюсер `applyCommand` на сервере и в оптимистичном превью клиента; одна проекция `applyEvent` на клиенте и в проверке экспорта — логика применения не дублируется.
- Транзакционная модель `executeOperation`: идемпотентность по хешу канонизированного конверта, проверка поколения, `dryRun` без записи, `.immediate()`.
- Таксономия ошибок `DomainError`/`fail()` с одной картой статусов; `retryable` как явный контракт для агентов.
- DI-точки для тестов: `AppOptions.authorize/now/ids`, `CliOptions.fetch/sleep/stdout/stderr/readInput`, `WorkspaceStore(transport, storage, delay)` — тесты не мокают модули.
- Тесты: реальные SQLite/Hono/Better Auth, property-инварианты «проекция == состояние» и «undo восстанавливает», триангуляция миграций, e2e по ролям/подписям, потеря ответа _после_ коммита, виртуальный WebAuthn.
- `outbox.ts`: атомарная публикация, fsync, 0600, проверка `baseUrl` и origin перед следованием по ссылкам пагинации (`client.ts:68-71`).
- Deploy: фазовые ERR-ловушки, flock, граница «запись открыта» до вызова, отказ отката после границы, drill с инжекцией несовместимой схемы.
- `tsc`, oxlint (проектный), oxfmt, vitest — все зелёные; `any` и `@ts-*` отсутствуют; TODO отсутствуют; языковая политика (код/тесты — английский, UI/агентские сообщения — русский) выдержана без исключений.
- README, `deploy/README.md`, SKILL.md — все проверенные утверждения (команды, флаги, порты, переменные, пути, коды выхода) совпадают с кодом.
