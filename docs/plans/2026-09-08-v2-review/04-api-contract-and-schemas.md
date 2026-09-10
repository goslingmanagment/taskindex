# Контракт API и схемы: issues в ошибках, OpenAPI как справочник, генерация union, исчерпывающесть, LIMITS, валидация на границах

Статус: предложение, 2026-09-08. Источник: сводное ревью v2 (см. `README.md` в этой папке).
Приоритет: P1 (волна 2; выполняется до `10-code-quality-and-tests.md`, потому что оба трогают `schemas.ts` и `commands.ts`). Оценка: M, 3 дня: день на `z` из `zod`, `LIMITS` и генерацию union, день на OpenAPI и `issues`, день на схемы ответов в shared, валидацию на границах и тесты. Зависимости: `03-cli-outbox-and-ergonomics.md` (использует `issues`, `meSchema`, `cliErrorCodeSchema`, `taskindex openapi`), `02-agent-permissions-and-sync-semantics.md` (поле `unchanged`, описание `focus`), `07-web-client-fixes-and-structure.md` (подключение `request(path, schema)` в компонентах), `10-code-quality-and-tests.md` (`switch` с `assertNever` в `applyCommand`), `12-ai-readiness-and-docs.md` (ссылка на чек-лист раздела 3.8 из `CLAUDE.md`).

## 1. Проблема

Все ссылки проверены по текущему дереву 2026-09-08.

### 1.1 A8: ошибки валидации без `issues`

- `src/server/app.ts:245-257`: `defaultHook` для `@hono/zod-openapi` возвращает `{ok:false, code:'invalid', message:'Проверьте параметры запроса.', retryable:false}` без деталей.
- `src/server/app.ts:262-271`: `onError` для `z.ZodError` возвращает «Проверьте поля запроса.» также без деталей.
- Транскрипт ревью готовности (B12): `curl -d '{…"payload":{"area":"agency","titel":"x"}}' /api/commands` → `{"ok":false,"code":"invalid","message":"Проверьте параметры запроса.","retryable":false}`. Агент по HTTP не узнаёт, что опечатка в `title`. CLI спасает только локальная валидация (`src/cli/run.ts:450-459`), и та печатает английские сообщения (план 03).
- Проверено на Zod 4.5.4 (`scratchpad/probe/jsonschema-probe.mts`): для такого запроса Zod даёт две `issues`: `{path:['payload','title'], code:'invalid_type'}` и `{path:['payload'], code:'unrecognized_keys', message:'Unrecognized key: "titel"'}`; после `z.config(z.locales.ru())` сообщения: «Неверный ввод: ожидалось string, получено undefined» и «Нераспознанный ключ: "titel"».

### 1.2 A9: OpenAPI непригоден как справочник

Замер живого `/api/openapi.json` (`scratchpad/openapi.json`, снят ревью готовности, перепроверен 2026-09-08 скриптом): 970 600 байт, 19 операций, `operationId` 0, `summary` 0, `tags` 0, `components.schemas` пустой объект, `components.parameters` пустой, `securitySchemes` нет, `security` нет.

Причины по коду:
- Ни одна схема не зарегистрирована как компонент, поэтому каждая вложенная `taskSchema` инлайнится; `readErrors` (`app.ts:84-91`) вкладывает `operationErrorSchema` шесть раз в каждый из 19 маршрутов.
- `createRoute` без `operationId`, `summary`, `tags`, `description` на всех маршрутах (`app.ts:390-1055`); `doc()` (`:1056-1065`) задаёт только `info` и `servers`.
- `pageQuery` (`app.ts:79-83`) и фильтры `/api/tasks` (`:544-553`) без `.describe()`.
- Документ отдаётся только с авторизацией: middleware `app.use('/api/*')` (`:296-311`) освобождает лишь `/api/auth/`.
- `contextSchema`, `digestSchema`, `focusGroupSchema` (`app.ts:99-174`) объявлены внутри серверного файла, поэтому CLI держит `context` как `Record<string, unknown>` (`run.ts:472-476`), а веб не может проверить ответ.

Проверено экспериментом (`scratchpad/probe/openapi-probe.mts`, `@asteasolutions/zod-to-openapi@9.1.0`, `@hono/zod-openapi@1.6.3`):
- `.meta({ id: 'Inner' })` на схеме, созданной обычным `import { z } from 'zod'`, даёт `components.schemas.Inner` и `$ref` во всех местах использования.
- `app.openAPIRegistry.register('Inner2', schema)` возвращает **клон** (`new this.constructor(this._def)` в `zod-extensions`), поэтому вложенные использования исходного экземпляра остаются инлайн. Регистрация через registry не решает задачу без переписывания всех вложенных схем; `.meta({id})` в shared решает.
- `z` из `zod` и `z` из `@hono/zod-openapi` это один и тот же объект (`index.mjs:6` `import { z } from "zod"`, `:265` `extendZodWithOpenApi(z)`).
- `z.toJSONSchema(schemaWithId)` возвращает `{$ref:'#/$defs/Task', $defs:{Task:…}}` вместо инлайн-объекта; `.extend()` сбрасывает `id`; `.describe()` сохраняется. Это влияет на `/api/context.fields` (`app.ts:893`) и учтено в шаге 5.

### 1.3 A14: `/api/context` без `agents` и `me`

`app.ts:867-937`: контекст содержит области, статусы, проекты, схемы, правила, счётчики и ссылки, но не список агентов и не текущего актора. `listAgents(db)` уже есть (`src/server/admin.ts:128`), актор лежит в `c.get('actor')`.

### 1.4 S3: shared зависит от серверного пакета

- `src/shared/schemas.ts:1-2`: `import { z } from '@hono/zod-openapi'; export { z };`. `src/shared/domain-schemas.ts:1-8` и `src/shared/model.ts:1` берут `z` оттуда же. Через `@shared/*` веб (`src/web`) и CLI (`src/cli`) зависят от серверного пакета; в `dist/cli/domain-schemas-*.js` есть `from "@hono/zod-openapi"` (ревью стека, S3). Реальный потребитель OpenAPI сегодня: только тесты `tests/api/commands.test.ts:750` и `tests/api/recovery-and-history.test.ts:130`; `/api/context` строит схемы нативным `z.toJSONSchema` (`app.ts:893-896`).
- Метод `.openapi()` в shared не используется ни разу (`grep -rn "\.openapi(" src/shared` пуст), то есть импорт из `@hono/zod-openapi` ничего не даёт, кроме зависимости.

### 1.5 S4, R2, B3: union набран руками, нет исчерпывающести

- `src/shared/schemas.ts:219-316` (`commandSchema`) и `:317-430` (`commandEnvelopeSchema`): 2 × 16 членов, отличающихся литералом команды и `...envelopeFields`.
- `src/shared/domain-schemas.ts:137`: `eventSchema.command: z.string()`; `:244`: `operationSummarySchema.command: z.string()`; `src/shared/commands.ts:23`: `ChangeEffect.command: string`; `src/web/app/activity.tsx:21`: `labels: Record<string, string>`.
- Забытый член `commandEnvelopeSchema`: CLI проверяет только `commandPayloadSchemas` (`run.ts:448-451`) и отправит команду, сервер её отклонит. Забытая подпись в `labels`: `tsc` молчит. Catch-all `else` для чеклиста в `applyCommand` (`commands.ts:600-603`): новая задачная команда без ветки уйдёт в чеклист (R1, план 10).

### 1.6 R7: лимиты продублированы литералами

Схемы входа `schemas.ts`: id 80 (`:5`), title 240 (`:77`), note 16000 (`:78`), waitingFor 240 (`:80`), текст шага 500 (`:37`), шагов 100 (`:43`), система источника 40 (`:53`), ref 200 (`:55`), url 2000 (`:58`), version 120 (`:62`), имя проекта 60 (`:96`), описание проекта 500 (`:101`, `:114`), позиция шага 100 (`:166`), itemIds 100 (`:191`), комментарий 4000 (`:198`), пакет 100 (`:437`). Схемы сущностей `domain-schemas.ts` повторяют их: 60 (`:25`), 500 (`:26`), 240 (`:41`), 16000 (`:43`), 240 (`:45`), 40 (`:61`), 200 (`:67`), 2000 (`:72`), 120 (`:78`), 4000 (`:98`), 500 (`:283`). JSX: `editor.tsx:311` (240), `:381` (240), `:436` (16000), `:503` (500), `:553` (500), `:560` (`>= 100`); `dialogs.tsx:139` (240), `:320` (60), `:332` (500); `board.tsx:226` (240); `activity.tsx:469` (4000). Серверные лимиты страниц: 500 (`app.ts:80`, `:519`), 50 в digest (`:968`, `:975`, `:983-985`). Смена лимита в одном месте разъезжается молча.

### 1.7 R8: клиент не проверяет данные на границах

- `src/web/app/api.ts:74`: `return value as T`.
- `src/web/app/sync.ts:25`: `store.ingest([JSON.parse(event.data)])`, `eventSchema` не используется.
- `src/web/app/store.ts:385-386`: `JSON.parse` из localStorage, проверка двух полей вручную, каст в `OperationEnvelope[]`.
- `src/web/app/drafts.ts:38-39`: `JSON.parse` возвращается как `Draft<T>` по проверке `formatVersion`.
- `src/cli/outbox.ts:63-70`: каст `as SavedOperation` и ручные проверки.
- `src/web/lib/use-workspace.ts:67`, `:94`: `results[0].record as Task`/`as Project`; `editor.tsx:239`, `dialogs.tsx:284`: `e.current as Task`/`as Project`, хотя `current: Entity` может быть другого вида.

### 1.8 Конверт ошибок

Сервер: `errorCodeSchema` (`domain-schemas.ts:199-209`) девять кодов, `DomainError.toJSON()` (`src/shared/errors.ts:27-35`). Литералы `{ok:false, code, message, retryable}` мимо `toJSON()`: `app.ts:248-256`, `:263-271`, `:276-284`, `:286-294`, `:344-353`, `:361-370`, `:378-386`, `src/server/index.ts:27-35`. CLI добавляет коды `invalid_arguments`, `client_error` (`run.ts:509`), `invalid_response` (`client.ts:113`), `network_error` (`client.ts:174`, `run.ts:347`), `admin_error` (`admin-run.ts:227`); `SKILL.md:58-60` перечисляет только коды выхода и `status: unknown`.

## 2. Цель и критерии приёмки

1. Любая ошибка валидации тела, query или params возвращает `400` с `code: 'invalid'`, русским `message` и `issues: [{path, message}]`, где `path` строка вида `payload.title`, `commands[2].payload.area`, `query.limit`. Тест: опечатка `titel` → среди `issues` есть `path === 'payload.title'` и элемент с «titel» в `message`.
2. `/api/openapi.json`: размер < 150 000 байт; у каждой операции `operationId`, `summary`, `tags`; `components.securitySchemes` содержит `bearer` (`http`/`bearer`) и `apiKey` (`x-api-key`), документ имеет глобальный `security`; `components.schemas` содержит как минимум `Actor`, `Me`, `Task`, `Project`, `Comment`, `Event`, `Snapshot`, `Context`, `Digest`, `FocusGroup`, `OperationError`, `OperationSuccess`, `StoredOperation`, `OperationSummary`, `EventsPage`, `Export`, `CommandEnvelope`, `BatchEnvelope`; каждый query-параметр имеет `description`; документ отдаётся без авторизации (`200` без заголовков). Тест в `tests/api/openapi.test.ts`.
3. `/api/context` содержит `me` (актор запроса) и `agents: [{id, label, disabledAt}]`; `fields` остаётся инлайн-объектом JSON Schema без `$ref` в корне (обратная совместимость).
4. `grep -rn "@hono/zod-openapi" src/shared src/web src/cli` пуст; `src/shared/schemas.ts:1` это `import { z } from 'zod'`.
5. `commandSchema` и `commandEnvelopeSchema` строятся из `Object.entries(commandPayloadSchemas)`; экспортированы `commandNames`, `commandNameSchema`; `eventSchema.command`, `operationSummarySchema.command`, `ChangeEffect.command` типизированы именами команд; `labels` в `activity.tsx` объявлены как `Record<CommandName | 'batch', string>`. Добавление ключа в `commandPayloadSchemas` без правки `labels` ломает `tsc`; удаление члена union невозможно, так как union больше не пишется руками.
6. `src/shared/limits.ts` экспортирует `LIMITS`; в `schemas.ts`, `domain-schemas.ts` и `src/web/app/*.tsx` нет числовых литералов этих лимитов; тест сканирует исходники.
7. `request(path, schema, init?)` в `src/web/app/api.ts` парсит ответ схемой; `sync.ts` парсит `eventSchema`; `store.recover` парсит `operationEnvelopeSchema`; `drafts.read` парсит `draftSchema`; схемы ответов `context`, `digest`, `focus`, `me` живут в `src/shared/domain-schemas.ts` и используются сервером (в `createRoute`), CLI (план 03) и вебом (план 07).
8. Инлайн-литералы ошибок заменены на `errorBody()`/`DomainError`; `cliErrorCodeSchema` (план 03) и его коды перечислены в справке CLI и SKILL.md (план 12); сервер не выдаёт кодов вне `errorCodeSchema` (тест на `onError`).
9. Чек-лист «как добавить команду end-to-end» (раздел 3.8) записан и на него ссылается `CLAUDE.md` (план 12).
10. `npm run check` и `npm run e2e` зелёные; существующие тесты `commands.test.ts:750` («OpenAPI contains concrete command and entity schemas») и `recovery-and-history.test.ts:130` обновлены под `$ref`.

## 3. Решение

### 3.1 S3: оставить `@hono/zod-openapi` и сделать контракт полезным (решение владельца, рекомендация)

Варианты:
- **A. Оставить `@hono/zod-openapi`, перевести shared на `import { z } from 'zod'`, регистрировать компоненты через `.meta({ id })`, наполнить маршруты метаданными, отдавать документ публично.** Рекомендуется: агенты получают машиночитаемый контракт всех чтений и ответов (сегодня `/api/context` описывает только payload команд), `taskindex openapi` (план 03) становится справочником, зависимость shared от сервера исчезает без потери типов (`z` тот же объект, `.meta()` нативный). Цена: метаданные на 19 маршрутах и `.meta({id})` на ~18 схемах.
- **B. Убрать `@hono/zod-openapi`, поставить `@hono/zod-validator`, удалить `/api/openapi.json`.** Минус зависимость и ~80 строк `readErrors`/`createRoute`; агенты остаются с `/api/context` и справкой CLI. Отвергнуто: A9 показывает, что агентам нужен контракт чтений, а после плана 03 (`hc` удалён) RPC-типизация уже не аргумент ни за, ни против.
- **C. Статус-кво.** Платить за B, пользоваться как за A. Отвергнуто.

`README.md` этой папки фиксирует рекомендацию «оставить и сделать полезным».

### 3.2 Компоненты через `.meta({ id })`

В `src/shared/domain-schemas.ts` каждая сущностная и ответная схема получает `.meta({ id: 'Task' })` и т. д. Правила:
- `.extend()` сбрасывает `id` (проверено), поэтому производные схемы (`storedOperationSchema = operationSummarySchema.extend(...)`) получают собственный `.meta({ id: 'StoredOperation' })` после `extend`.
- Обёртки `.nullable()`, `.optional()`, `z.array(...)` сохраняют `$ref` на вложенную схему.
- Фабрика `pageSchema(item)` не получает id (каждый вызов создаёт новую схему); при желании конкретные страницы именуются в месте вызова: `pageSchema(taskSchema).meta({ id: 'TaskPage' })`.
- Схемы payload команд (`commandPayloadSchemas`) id не получают: они используются один раз в union и в `/api/context.commands`, где нужен инлайн JSON Schema.
- `/api/context.fields` строится хелпером `inlineJsonSchema(taskSchema)`: вызывает `z.toJSONSchema`, и если корень это `{$ref: '#/$defs/X', $defs}`, возвращает `$defs[X]` с добавлением остальных `$defs`, если они есть. Так контракт `fields` не меняется.

### 3.3 Метаданные маршрутов и публичный документ

Каждый `createRoute` получает `operationId` (camelCase: `getHealth`, `getMe`, `getSnapshot`, `postCommand`, `postBatch`, `listEvents`, `listTasks`, `getTaskByOrigin`, `getTask`, `listProjects`, `listTaskComments`, `getTaskHistory`, `listOperations`, `getOperation`, `getExport`, `streamEvents`, `getContext`, `getDigest`, `getFocus`), `summary` по-русски, `tags` из `['health', 'commands', 'tasks', 'projects', 'comments', 'operations', 'events', 'context']`, `description` там, где есть неочевидная семантика (курсоры, `generation`, SSE). `pageQuery` и фильтры получают `.describe()` («Размер страницы 1-500», «Курсор из nextCursor предыдущей страницы», «Поколение базы; при несовпадении 409 generation_changed», «Только задачи на сегодня: срок или дата возврата не позже сегодняшнего дня», «true/false или 1/0»). `doc()` расширяется `components.securitySchemes` и `security`:

```ts
completeApi.openAPIRegistry.registerComponent('securitySchemes', 'bearer', { type: 'http', scheme: 'bearer', description: 'Ключ агента в Authorization: Bearer' });
completeApi.openAPIRegistry.registerComponent('securitySchemes', 'apiKey', { type: 'apiKey', in: 'header', name: 'x-api-key' });
completeApi.doc('/api/openapi.json', { openapi: '3.1.0', info: {…}, servers: [{ url: baseURL }], security: [{ bearer: [] }, { apiKey: [] }] });
```

Публичность: в middleware `app.ts:296-304` добавить `if (c.req.path === '/api/openapi.json') return await next();` рядом с исключением для `/api/auth/`. Документ не содержит данных пользователя; риск раскрытия формы API принят (решение можно отменить одной строкой).

### 3.4 Генерация union и имена команд

```ts
// src/shared/schemas.ts
export const commandPayloadSchemas = schemas;
export type CommandName = keyof typeof schemas;
export const commandNames = Object.keys(schemas) as [CommandName, ...CommandName[]];
export const commandNameSchema = z.enum(commandNames).describe('Имя команды');
type Member<K extends CommandName, E extends z.ZodRawShape> = z.ZodObject<E & { command: z.ZodLiteral<K>; payload: (typeof schemas)[K] }>;
const members = <E extends z.ZodRawShape>(extra: E) =>
  commandNames.map((name) => z.object({ ...extra, command: z.literal(name).describe('Имя команды'), payload: schemas[name].describe('Параметры команды') }).strict()) as unknown as [Member<CommandName, E>, ...Member<CommandName, E>[]];
export const commandSchema = z.discriminatedUnion('command', members({}));
export const commandEnvelopeSchema = z.discriminatedUnion('command', members(envelopeFields));
```

Единственный каст `as unknown as [...]` документируется комментарием; тип `Command` остаётся дискриминированным union (`{ [K in CommandName]: {command: K; payload: z.infer<(typeof schemas)[K]>} }[CommandName]` объявляется явно и проверяется `satisfies` против `z.infer<typeof commandSchema>` в тесте типов). `z.discriminatedUnion` в Zod 4 принимает массив (проверено пробой). `CommandName` в `model.ts:72` (`Command['command']`) заменяется реэкспортом из `schemas.ts`.

Потребители: `eventSchema.command: commandNameSchema`, `operationSummarySchema.command: z.enum([...commandNames, 'batch'])`, `ChangeEffect.command: CommandName`, `activity.tsx` `labels: Record<CommandName | 'batch', string>`. `emit(kind, before, after, cmd: CommandName = name)`.

### 3.5 `LIMITS`

```ts
// src/shared/limits.ts
export const LIMITS = {
  id: 80, taskTitle: 240, taskNote: 16000, waitingFor: 240,
  checklistText: 500, checklistItems: 100,
  originSystem: 40, originRef: 200, originUrl: 2000, originVersion: 120,
  projectName: 60, projectDescription: 500, commentText: 4000,
  batchCommands: 100, pageSize: 500, digestPage: 50,
} as const;
```
Используется в `schemas.ts`, `domain-schemas.ts`, `app.ts` (`pageQuery`, `/api/events`, digest) и в JSX (`maxLength={LIMITS.taskTitle}`, `draft.checklist.length >= LIMITS.checklistItems`). Тест `tests/unit/limits.test.ts`: (а) `taskSchema` принимает `title` длиной `LIMITS.taskTitle` и отклоняет `+1`; то же для note, комментария, имени проекта, шагов; (б) сканирование исходников: `src/web/app/*.tsx` не содержит `maxLength={<цифры>}` и `>= 100`; `src/shared/schemas.ts` и `domain-schemas.ts` не содержат `.max(<цифры>)` кроме `.max(Number.MAX_SAFE_INTEGER)` и `.max(100)` для `position` (заменяется на `LIMITS.checklistItems`).

### 3.6 Валидация на границах (API-форма)

- `src/web/app/api.ts`: `export async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T>`; тело успешного ответа проходит `schema.parse`, ошибка парсинга превращается в `ApiError({code:'invalid_response', …})`? Нет: код должен оставаться в `errorCodeSchema` веба; используется `code: 'unavailable', retryable: false` с сообщением «Сервер вернул неожиданный ответ», плюс `console.error` с `issues` в dev. Сохраняется перегрузка `request<T>(path, init?)` на переходный период с пометкой `@deprecated`, чтобы план 07 переводил компоненты постепенно; `store.ts` (`transport`) и `sync.ts` переводятся здесь.
- `sync.ts:25`: `const parsed = eventSchema.safeParse(JSON.parse(event.data)); if (!parsed.success) { void store.catchUp(); return; } store.ingest([parsed.data]);`
- `store.ts:385-386`: `operationEnvelopeSchema = z.union([commandEnvelopeSchema, batchEnvelopeSchema])` в `schemas.ts`; невалидная запись пропускается (как сегодня в `catch`).
- `drafts.ts:38-39`: `draftSchema = <T>(fields: z.ZodType<T>) => z.object({ formatVersion: z.literal(1), generation: idSchema, baseRevision: z.number().int().nonnegative(), fields, id: idSchema.optional(), operationId: idSchema.optional() })`; `read(id, fieldsSchema)`; вызовы с конкретной схемой полей в плане 07.
- Схемы ответов `contextSchema`, `digestSchema`, `focusGroupSchema`, `focusResponseSchema`, `meSchema`, `projectsResponseSchema` переезжают из `app.ts:99-174` в `src/shared/domain-schemas.ts` с `.meta({id})`; сервер импортирует их. `contextSchema` расширяется `me: actorSchema`, `agents: z.array(agentSchema)`.
- CLI: `savedOperationSchema` для `outbox.ts:63-70` в плане 03 (там же `formatVersion: 2`).

### 3.7 Конверт ошибок

- `src/shared/errors.ts`: `export function errorBody(code: ErrorCode, message: string, extra: Partial<OperationError> = {}): OperationError` → `{ ok: false, code, message, retryable: code === 'unavailable', ...extra }`; `DomainError.toJSON()` вызывает его. `operationErrorSchema` получает `issues: z.array(z.object({ path: z.string(), message: z.string() })).optional()`.
- `formatIssuePath(path: PropertyKey[]): string` в `shared/errors.ts` (`payload.title`, `commands[2].payload.area`); используется сервером и CLI (план 03).
- `app.ts`: `defaultHook` → `c.json(errorBody('invalid', 'Проверьте параметры запроса.', { issues: result.error.issues.map(...) }), 400)`; `onError` для `ZodError` аналогично; body-limit и `/api/auth` без `auth` тоже через `errorBody`; `index.ts:27-35` тоже.
- `z.config(z.locales.ru())` в `createApp` (идемпотентно), чтобы `issues` были на русском, как остальной контракт (B9).
- Коды CLI остаются вне `errorCodeSchema` (это коды клиента, сервер их не выдаёт): `cliErrorCodeSchema` в `src/cli/errors.ts` (план 03), документируются в справке и SKILL.md.

### 3.8 Как добавить команду end-to-end (артефакт приёмки, на него ссылается `CLAUDE.md`)

1. `src/shared/limits.ts`: новые лимиты, если есть.
2. `src/shared/schemas.ts`: payload в `schemas` с `.describe()` на каждом поле и `.strict()`. Union и `commandNames` обновляются сами.
3. `src/shared/commands.ts`: ветка в `applyCommand` (после плана 10: `case` в `switch`, `assertNever` в `default`); `requireScope`; правила `isSubjectField`, если поле новое; поведение `undo` (инверсия по `changes`) и `task.sync`, если затрагивается.
4. `src/server/db.ts` `writeState`: только если появилась новая сущность или колонка (тогда ещё миграция, см. `CLAUDE.md`).
5. `src/web/app/activity.tsx` `labels`: подпись; `tsc` не пройдёт без неё. Билдер команды в `src/web/lib/use-workspace.ts` или `web/app/commands.ts`, если команда нужна интерфейсу.
6. `src/cli/spec.ts` `WRITES`: `group`/`action`, позиционные аргументы, пример; справка строится из схемы. Тест `tests/cli/help.test.ts` требует запись для каждого `CommandName`.
7. `skills/taskindex/SKILL.md`: когда и как агент использует команду; тест «скилл против справки» (план 12).
8. Тесты: `tests/api/commands.test.ts` (успех, отказ, undo), `tests/api/permissions.test.ts` (строка матрицы прав, план 02), `tests/property/commands.test.ts` (генератор действия), `tests/cli/cli.test.ts` (флаги → payload).
9. `docs/plans/2026-09-08-taskindex-v2.md` §5: строка в таблице команд.
10. `npm run check`; `taskindex help <group> <action>` показывает команду; `/api/openapi.json` содержит её в `CommandEnvelope`.

## 4. Шаги

Работа в отдельном worktree; делать после мерджа плана 03 (или согласовать одновременно правки `client.ts`, `run.ts`).

1. **`z` из `zod` в shared.** `schemas.ts:1` → `import { z } from 'zod';` (реэкспорт `export { z }` оставить, чтобы не трогать 20 импортов сразу, но пометить `@deprecated`, план 10 уберёт); `domain-schemas.ts:1-8` и `model.ts:1` без изменений (берут из `schemas.ts`). Проверка: `npm run check`; `grep -rn "@hono/zod-openapi" src/shared src/web src/cli` пуст; `npm run build` и `grep -c "zod-openapi" dist/cli/*.js` → 0.

2. **`LIMITS`** (3.5): создать `src/shared/limits.ts`, заменить литералы в `schemas.ts`, `domain-schemas.ts`, `app.ts:80,519,968,975,983-985`, JSX (11 мест из 1.6). Тест `tests/unit/limits.test.ts`.

3. **Union из схем** (3.4): переписать `schemas.ts:213-446`; экспорт `commandNames`, `commandNameSchema`, `operationEnvelopeSchema`; `model.ts:69-73` реэкспортирует `CommandName` из `schemas.ts`; `domain-schemas.ts:137`, `:244`; `commands.ts:19-26`, `:237-242`; `activity.tsx:21`. Тест `tests/unit/shared.test.ts`: `commandSchema.options.length === commandNames.length`; `commandEnvelopeSchema` отклоняет неизвестное имя; `Object.keys(labels)` (экспортировать `labels` из `activity.tsx` или вынести в `web/app/labels.ts`) равны `[...commandNames, 'batch']`. Существующий тест `shared.test.ts:132` («rejects extra envelope fields…») остаётся.

4. **Схемы ответов в shared и `.meta({id})`** (3.2, 3.6): перенести `app.ts:99-174` в `domain-schemas.ts`; добавить `meSchema` (если план 03 ещё не добавил); `.meta({ id })` на схемах из критерия 2. `contextSchema` += `me`, `agents`.

5. **`/api/context`** (`app.ts:867-937`): `me: c.get('actor')`, `agents: listAgents(db)` (импорт из `admin.ts`), `fields: inlineJsonSchema(taskSchema)`. Тест: `fields.type === 'object'` и нет `$ref` в корне; `agents` содержит созданного в тесте агента; `me.id` совпадает с ролью.

6. **`issues` и конверт ошибок** (3.7): `errors.ts` (`errorBody`, `formatIssuePath`), `operationErrorSchema.issues`, `app.ts:245-295`, `:340-387`, `index.ts:26-36`, `z.config(z.locales.ru())` в `createApp`. Тест `tests/api/openapi.test.ts` или `commands.test.ts`: `titel` → `issues`; `GET /api/tasks?limit=abc` → `issues[0].path === 'query.limit'`? В `@hono/zod-openapi` `defaultHook` получает `result` с `target: 'query' | 'json' | 'param'`; префикс `path` строится из `target` (`query.limit`, `payload.title` для тела: тело конверта имеет поле `payload`, поэтому для `json` префикс не добавляется), см. `Hook` в `@hono/zod-openapi`.

7. **OpenAPI** (3.3): `operationId`/`summary`/`tags`/`description` на 19 маршрутах; `.describe()` на `pageQuery`, фильтрах `/api/tasks`, `/api/operations`, `/api/events`, `/api/focus`, `/api/digest`; `registerComponent('securitySchemes', …)`; `security` в `doc()`; исключение для `/api/openapi.json` в middleware. Тест `tests/api/openapi.test.ts`: размер `< 150_000`, множество `operationId` без дублей и длиной 19, у каждой операции `summary` и `tags`, `securitySchemes.bearer`, `components.schemas` содержит имена из критерия 2, все `parameters[in=query]` с `description`, запрос без заголовков → 200. Обновить `commands.test.ts:750` и `recovery-and-history.test.ts:130`: проверять наличие `components.schemas.Task.properties.title` и `$ref` в `paths['/api/tasks/{id}'].get.responses['200']`.

8. **Валидация на границах** (3.6): `api.ts` (`request(path, schema, init?)` + `@deprecated` перегрузка), `sync.ts:25`, `store.ts:385-386` (`operationEnvelopeSchema`), `store.transport` со схемами (`operationSuccessSchema`, `storedOperationSchema`, `snapshotSchema`, `eventsPageSchema`), `drafts.ts` (`draftSchema`, `read(id, fieldsSchema)`; вызовы с `taskFieldsSchema.partial()` и схемой проекта в компонентах остаются плану 07, до этого `read(id)` без схемы сохраняется как перегрузка). Тесты `tests/web/api.test.ts` (ответ не по схеме → `ApiError`), `tests/web/store.test.ts` (битая запись `taskindex/ops/*` пропускается, валидная проходит), новый `tests/web/sync.test.ts` минимально: `ingest` не вызывается для невалидного события (через мок `EventSource`).

9. **Документы**: `skills/taskindex/SKILL.md` (коды ошибок, `issues`, `taskindex openapi`, `me`, `agents` в `context`; текст в плане 12), `docs/plans/2026-09-08-taskindex-v2.md` §6 и §10 (компоненты OpenAPI, публичный документ, `issues`, `me`/`agents`), этот раздел 3.8 как ссылка из `CLAUDE.md` (план 12).

10. **Проверка**: `npm run check`, `npm run e2e`, `npm run build`, `curl -s http://127.0.0.1:3001/api/openapi.json | wc -c` на sandbox (план 12) и `taskindex openapi | jq '.paths | keys'`.

## 5. Тесты

| Критерий | Файл | Сценарий | Ожидание |
|---|---|---|---|
| 1 | `tests/api/commands.test.ts` | `POST /api/commands` с `payload.titel` | 400, `code: 'invalid'`, `issues` содержит `path: 'payload.title'` и элемент с «titel»; сообщения на русском |
| 1 | там же | `GET /api/tasks?limit=abc`, `GET /api/tasks/%20` | 400, `issues[0].path` начинается с `query.` / `param.` |
| 1 | там же | `POST /api/commands/batch` с ошибкой во второй команде на уровне схемы | `issues[0].path` начинается с `commands[1].payload` |
| 2 | `tests/api/openapi.test.ts` | `GET /api/openapi.json` без заголовков | 200, размер < 150 000, 19 `operationId` без повторов, `summary`/`tags` у всех, `securitySchemes.bearer` и `apiKey`, `security` задан, компоненты из критерия 2, у всех query-параметров `description` |
| 3 | `tests/api/commands.test.ts` | `GET /api/context` ролью `agent` после `createAgent` | `me.id === 'agent:test-agent'`, `agents[].id` содержит агента, `fields.type === 'object'`, в `fields` нет `$ref` |
| 4 | `tests/unit/shared.test.ts` (source-scan) | чтение `src/shared/*.ts`, `src/web/**/*.ts(x)`, `src/cli/*.ts` | нет строки `@hono/zod-openapi` |
| 5 | `tests/unit/shared.test.ts` | `commandSchema.options`, `commandEnvelopeSchema.safeParse({command:'task.nope'})`, `labels` | длина равна `commandNames.length`; отказ; ключи `labels` равны `[...commandNames,'batch']` |
| 5 | `tsc` | временно добавить ключ `'task.nope'` в `schemas` без подписи в `labels` (ручная проверка исполнителем, не коммитится) | `tsc` падает на `labels` |
| 6 | `tests/unit/limits.test.ts` | граничные длины; сканирование исходников | принимает `LIMITS.x`, отклоняет `+1`; литералов нет |
| 7 | `tests/web/api.test.ts` | ответ `{}` при схеме `taskSchema` | `ApiError` с русским сообщением, `retryable: false` |
| 7 | `tests/web/store.test.ts` | `taskindex/ops/x` = `{"operationId":"x"}` без `command` | запись пропущена, `pending` пуст |
| 7 | `tests/web/sync.test.ts` | сообщение SSE с невалидным JSON-событием | `ingest` не вызван, `catchUp` вызван |
| 8 | `tests/api/commands.test.ts` | искусственная не-`DomainError` ошибка в `authorize` | тело проходит `operationErrorSchema.strict()`, `code` из `errorCodeSchema` |
| 10 | `npm run check`, `npm run e2e` | | зелёные |

## 6. Риски и откат

- **`$ref` в OpenAPI ломает существующие тесты**, которые ищут инлайн-схемы (`commands.test.ts:750`, `recovery-and-history.test.ts:130`). Обновляются в шаге 7.
- **`/api/context.fields`** мог бы стать `$ref`; хелпер `inlineJsonSchema` и тест шага 5 это исключают.
- **`.meta({id})` и `.extend()`**: производные схемы теряют id; правило в 3.2 и тест на список компонентов в критерии 2 ловят пропуски.
- **Публичный `/api/openapi.json`** раскрывает форму API. Данных в нём нет; при желании закрыть достаточно убрать одну строку исключения в middleware; альтернативно закрыть в Nginx по allowlist (план 11).
- **`z.config(z.locales.ru())` на сервере** меняет тексты `issues` глобально в процессе; собственные `message` в `fail(...)` не затронуты. Тесты, сравнивающие английские тексты Zod, отсутствуют (`grep -rn "Invalid input" tests/` пуст).
- **Генерация union с одним кастом**: тип `Command` объявляется явно и сверяется `satisfies` в тесте типов; property-тесты `projection == state` покрывают поведение.
- **`request(path, schema)`**: строгие схемы (`.strict()`) отклонят ответы с новыми полями от более нового сервера; для веб-клиента, раздаваемого тем же сервером, версии совпадают; CLI (план 03) использует `safeParse` и печатает тело как есть при несовпадении.
- Откат: изменения затрагивают только схемы, маршруты и клиентские парсеры; данные в базе не меняются; `git revert` по шагам (каждый шаг отдельный коммит).

## 7. Вне объёма

- Разрез `app.ts` на `routes/*` и вынос `page()`: `06-server-structure-config-logging.md`; этот план добавляет метаданные к маршрутам там, где они лежат сегодня.
- `switch (command.command)` с сужением payload и `assertNever` в `applyCommand`, типизированный `get<K>()`: `10-code-quality-and-tests.md` (R1).
- Подключение `request(path, schema)` и `read(id, schema)` в компонентах `editor.tsx`, `dialogs.tsx`, `activity.tsx`, `use-workspace.ts:67,94`, `editor.tsx:239`, `dialogs.tsx:284`: `07-web-client-fixes-and-structure.md`.
- `savedOperationSchema` для CLI outbox, `cliErrorCodeSchema`, `hint` в ошибках CLI, `taskindex openapi`: `03-cli-outbox-and-ergonomics.md`.
- `digest.comments` (нужен для `taskindex inbox`, A7): добавляется здесь как расширение `digestSchema`: `comments: pageSchema(commentSchema.extend({ taskTitle: z.string() })).extend({ href })` с фильтром `actorId === 'owner' && createdAt после since` по `seq` событий комментариев; реализация в `app.ts:938-1011` рядом с `operations`. Указано здесь, чтобы план 03 имел на что опереться; трудоёмкость S, входит в оценку.
- `SCHEMA_VERSION` ↔ журнал миграций (B4, V6): `06-server-structure-config-logging.md`.
- Переименование `schemas.ts`/`domain-schemas.ts` в `command-schemas.ts`/`entity-schemas.ts`, удаление реэкспорта `z`: `10-code-quality-and-tests.md`.

## Покрытые находки

| ID | Отчёт | Кратко | Где в плане |
|---|---|---|---|
| A8 | AI-готовность | ошибки валидации без `issues` | 1.1, 3.7, шаг 6 |
| A9 | AI-готовность | OpenAPI 970 КБ, без `operationId`/`security`, только по ключу | 1.2, 3.2, 3.3, шаги 4, 7 |
| A14 | AI-готовность | `/api/context` без `agents` и `me` | 1.3, шаг 5 |
| A7 (API-часть) | AI-готовность | комментарии владельца недоступны первым классом | раздел 7 (`digest.comments`) |
| S3 | стек | `z` из `@hono/zod-openapi` в shared; контракт не потребляется | 1.4, 3.1, шаг 1 |
| S4 | стек | 16 членов union набраны руками | 1.5, 3.4, шаг 3 |
| R2 | качество §3, (d) | генерировать union, `z.enum(commandNames)` | 1.5, 3.4, шаг 3 |
| B3 | AI-готовность | новая команда требует 6+ правок без проверки исчерпывающести | 1.5, 3.4, 3.8, шаг 3 |
| R7 | качество §2, (d) | лимиты Zod переписаны литералами в JSX | 1.6, 3.5, шаг 2 |
| R8 | качество §4, (d) | клиент не проверяет ответы, `JSON.parse` без схем | 1.7, 3.6, шаг 8 |
| §1 качества (частично) | качество | `contextSchema`/`digestSchema` в `app.ts`, CLI держит `context` как `Record<string, unknown>` | 3.6, шаг 4 |
| §3, §5 качества | качество | 13 инлайн-литералов ошибок мимо `DomainError.toJSON()` | 1.8, 3.7, шаг 6 |
| §5 качества | качество | коды CLI неизвестны `errorCodeSchema` и SKILL | 1.8, 3.7 (документирование через план 03/12) |
| B9 | AI-готовность | смешение языков в ошибках | 3.7 (`z.locales.ru()` на сервере) |
| A2 (часть) | AI-готовность | тест «каждый GET-параметр в справке» опирается на OpenAPI | 3.3 (описания параметров), план 03 шаг 7 |
| Astra B-04 | astra / TI-008 | `since` и `digest` по `lastSeq` теряют no-op и отказы; `since=0` не равно «всё» | шаг 11 |
| Astra B-05 | astra / TI-009 | инвариант чеклиста через `checklistSchema.parse` даёт ZodError: 400 без записи операции, id переиспользуем | шаг 12 |
| Astra B-06, B-07 | astra / TI-010, TI-011 | id `none`/`all` пересекаются с фильтром; `by-origin` перекрыт статическим маршрутом | шаг 13 |
| Astra S-04 | astra / TI-005 | ответы web без runtime-проверки; корреляция `generation`/`operationId` | 3.6, шаг 8; шаг 14 |
| Astra A-03 (клиент) | astra / TI-014 | несовпадение версии схемы между сервером и открытым клиентом | шаг 15; правило миграций данных в плане 09 |
| Astra Q-04 | astra / TI-022 | сохранённые черновики и конверты без схемы; сырые данные не терять | 3.6, шаг 8; шаг 16 |

## Сверка с ревью Astra (2026-09-08)

Кратко: Astra добавила четыре подтверждённых дефекта контракта в зонах, которые наше ревью пометило проверенными («Снимок и курсоры», «Auth/скоупы»): B-04 (`operations?since` и `digest` фильтруют по `lastSeq`, `src/server/app.ts:717`, `:963`, поэтому no-op и сохранённые отказы не видны даже при `since=0`, а `until=1` их показывает), B-05 (`assertInvariants` вызывает `checklistSchema.parse`, `src/shared/commands.ts:217`; ZodError минует `DomainError`-ветку executor `src/server/operations.ts:124`, ответ 400 без записи операции, `operation get` 404, тот же `operationId` принимает другую команду; при сверке найден более реалистичный путь: `checklist.add` с id, уже занятым в этой задаче), B-06/B-07 (проект `none`/`all` создаётся и ломает фильтр `src/shared/queries.ts:118-122`; задача `by-origin` создаётся, но `GET /api/tasks/by-origin` уходит в статический маршрут `app.ts:593`, объявленный раньше `/api/tasks/{id}` `:609`; у нас это было только запахом кода). S-04 совпадает с R8 (§1.7), A-03 добавляет требование к клиенту при смене версии схемы. Astra утверждает, что OpenAPI потребляется внешними агентами (`docs/audits/2026-09-08-multiside-review/01-stack.md:30`); код показывает потребителей только в тестах (§1.4), решение 3.1 «оставить и сделать полезным» с обеими позициями совместимо. Треков A8, A9, A14, S3, R7 у Astra нет.

### Добавлено по итогам сверки
| Пункт | Источник Astra | Реестр | План Astra | Что делаем здесь / где делается |
|---|---|---|---|---|
| Монотонный курсор операций `operationSeq`, не зависящий от событий; `since=0` означает «всё» | B-04 | TI-008 | `astra-08-operation-feed-cursor.md`, шаги 1-6 | шаг 11 ниже по шагам `astra-08` с дельтами: без слоя совместимости старых клиентов до переключения; стык с планами 01 (шаг 15) и 03 (шаг 17) |
| Нарушение инварианта после принятия конверта это `DomainError`, отказ сохраняется, id сжигается | B-05 | TI-009 | `astra-09-persist-domain-rejections.md` | шаг 12 ниже |
| Служебные слова не могут быть идентификаторами; поиск по источнику на отдельном пути | B-06, B-07 | TI-010, TI-011 | `astra-10-project-id-filter-separation.md`, `astra-11-task-lookup-route-separation.md` | шаг 13 ниже; выбран резерв слов, а не смена семантики фильтра (см. расхождения) |
| Проверка связности `generation`/`operationId` в ответах, не только формы | S-04 | TI-005 | `astra-05-web-response-contracts.md`, проверка 2 | шаг 14 ниже |
| `schemaVersion` в снимке и понятный режим несовместимого клиента с сохранением черновиков | A-03 | TI-014 | `astra-14-domain-contract-evolution.md`, шаг 4 | шаг 15 ниже |
| Три теста формы сохранённых данных; сырое значение сохранять для ручного восстановления | Q-04 | TI-022 | `astra-22-persisted-drafts-and-outbox-schemas.md` | шаг 16 ниже; CLI-часть в плане 03 (шаг 18) |
| Клиентская валидация остаётся; вес снимается `zod/mini`, а не отказом от проверок | S-04 и FS:F3 | TI-005, TI-024 | `astra-05`, `astra-24` | решение записано в плане 07 (3.10, вариант C снят); здесь `request(path, schema)` без изменений |

### Расхождения и решение
- Потребители OpenAPI. Astra: «REST/OpenAPI нужен внешним агентам», «RPC используется в CLI» (`01-stack.md:30`, `:114`); код: потребители только тесты, `hc` для двух POST (§1.4). `ASTRA-VS-FABLE.md` §4.4 поддерживает направление «сделать полезным». Решение 3.1 (вариант A) не меняется; утверждение Astra записано как верное по направлению и неточное по текущему состоянию.
- Объём исправления B-04. `astra-08`: полный `operationSeq` с миграцией, export/import и стратегией старых клиентов, зависимость от `astra-13`/`astra-14`; сверка по багам: минимум «`since=0` возвращает всё и документировать». Решение: до переключения делать `operationSeq` (шаг 11), потому что колонка и backfill сейчас дёшевы, а совместимость старых клиентов не нужна; минимум из плана 01 (шаг 15) остаётся страховкой, если план 04 отстанет.
- Способ для B-06/B-07. `astra-10` предпочитает сменить контракт фильтра (отдельный режим `unassigned`, закодированные значения в выпадающих списках) и называет резерв слов «явно менее совместимой альтернативой»; `astra-11` предпочитает новый маршрут с совместимостью старого. Решение: до переключения нет пользовательских id, которые нужно защищать, поэтому резерв слов при создании и импорте (один `refine`) плюс перенос поиска на `/api/tasks/lookup/by-origin` без legacy-алиаса дешевле и закрывает оба дефекта; константы `ProjectFilter` (план 10, шаг 7) остаются защитой на уровне типов. Если владелец позже захочет буквальные id `none`/`all`, путь описан в `astra-10`.
- Тяжесть B-05. Astra P2; сверка: низкая (клиент получает окончательный `retryable:false`, конверт удаляется, база не тронута; страдает только идемпотентный контракт). Исправление тривиально, делается.
- Граница «отказ валидации до принятия конверта» и «сохранённый доменный отказ» (`astra-08` шаг 6, `astra-09` шаг 1): согласны. `defaultHook` 400 с `issues` (шаг 6) не сохраняется; только нарушения инвариантов после принятия конверта становятся сохранённым `DomainError` (шаг 12).
- `zod/mini` против валидации на клиенте. Вариант C из плана 07 (убрать Zod из браузера) противоречит S-04 и R8; снят там (3.10). Здесь `request(path, schema)` остаётся, вес решается замером (план 07, шаг 20).

### Дополнительные шаги
11. Курсор операций (Astra B-04; основа шаги 1-6 `astra-08`, здесь дельты). Схема: колонка `operations.operation_seq INTEGER NOT NULL` и уникальный индекс `operations_seq` новой миграцией `drizzle/v2/000N_operation_seq.sql` (DDL через kit, backfill руками детерминированным порядком `(created_at, id)`, например `ROW_NUMBER() OVER (ORDER BY created_at, id)` через временную таблицу; правило оформления в плане 09). Назначение в транзакции `executeOperation` (`src/server/operations.ts:51`): `COALESCE(MAX(operation_seq), 0) + 1`; поколение в курсоре уже есть, поэтому сброс при `mark-restored` не нужен. `operationSummarySchema` и `storedOperationSchema` получают `operationSeq: z.number().int().positive()`. `/api/operations`: keyset `after=<operationSeq>` (ключ из плана 01, шаг 7 и 15); `since`/`until` остаются окном по событиям с `.describe()` «окно по событиям; операции без событий в него не входят»; отсутствие `since` возвращает все операции. `/api/digest`: новый параметр `sinceOp`, окно `operations` по `operationSeq`, в ответе `operationSeq` последней операции рядом с `seq`. Export/import: поле входит в экспорт, `validateExport` проверяет уникальность и согласованность порядка с `(createdAt, id)`. SSE `event: operations` несёт `operationSeq`. OpenAPI описывает оба курсора (`astra-08` шаг 4: потребитель должен понимать, какой курсор передаёт). Тесты: последовательность успех / no-op / отказ / повтор / успех читается целиком `after` с `limit=1`; `operations` без `since` и с `since=0` содержат no-op и отказ; запись между страницами не даёт пропуска; export → import сохраняет `operationSeq`; повтор конверта не создаёт новый номер. Приёмка: probe Astra `digest-and-since-exclude-no-event-operations` показывает все три id. Зависимости: план 09 (правило миграций данных, дополнительный шаг 12), план 01 (шаги 5, 7, 15), план 03 (шаг 17).
12. B-05, `src/shared/commands.ts` `assertInvariants` (`:178-222`): заменить `checklistSchema.parse(t.checklist)` (`:217`) на явные проверки `if (t.checklist.length > LIMITS.checklistItems) fail('invalid', 'В задаче не больше 100 шагов.')` и `if (new Set(t.checklist.map((i) => i.id)).size !== t.checklist.length) fail('invalid', 'Идентификаторы шагов в задаче повторяются.')`; межзадачная проверка `:218-222` остаётся. После правки `grep -n '\.parse(' src/shared/commands.ts` не должен показывать Zod-`parse`, достижимый после принятия конверта (сегодня `:217`; `Date.parse` на `:81` не Zod). Executor (`src/server/operations.ts:124`) не меняется: `DomainError` сохраняется. Тесты `tests/api/commands.test.ts`: `checklist.add` 101-го шага → 400 `invalid`, `GET /api/operations/{id}` → 200 с сохранённым отказом, повтор того же конверта → то же тело, тот же id с другим payload → 409 `operation_mismatch`; `checklist.add` с id, уже существующим в этой задаче → тот же путь; пакет с нарушением во второй команде → `commandIndex: 1`, состояние не изменилось. Приёмка: probe Astra `invariant-rejection-is-not-idempotently-recorded` проходит.
13. B-06/B-07. `src/shared/schemas.ts`: `RESERVED_IDS = new Set(['all', 'none', 'by-origin', 'lookup'])`, `newIdSchema = idSchema.refine((id) => !RESERVED_IDS.has(id), 'Служебное слово нельзя использовать как идентификатор')` для `id` в `task.create`, `task.sync` (id новой задачи), `project.create`; в `importWorkspace` (`src/server/admin.ts:374-375`) та же проверка перед `assertInvariants`. Маршрут `GET /api/tasks/by-origin` (`src/server/app.ts:593`) переносится на `/api/tasks/lookup/by-origin`; `GET /api/tasks/{id}` (`:609`) не меняется; `find-origin` в `READS` CLI (план 03) берёт новый путь; legacy-алиас до переключения не нужен (решение; `astra-11` шаг 2 не применяется). Тест в `tests/api/openapi.test.ts`: каждый статический сегмент пути после `/api/tasks/` и `/api/projects/` входит в `RESERVED_IDS`. Семантика `queries.ts:118-122` и `shell.tsx:124-125` не меняется; константы `ALL_PROJECTS`/`NO_PROJECT` из плана 10 остаются защитой типов. Тесты: `project.create {id:'none'}` и `{id:'all'}` → 400 `invalid`, `issues[0].path === 'payload.id'`; `task.create {id:'by-origin'}` → 400; `GET /api/tasks/lookup/by-origin?system=x&ref=y` → 200; `GET /api/tasks/lookup` → 404 `not_found`; импорт с зарезервированным id отклоняется. Приёмка: probe Astra `03-id-probes` даёт 400 на создании.
14. Связность ответов (S-04, `astra-05` проверка 2). В `store.transport` (план 07, шаг 8) после `operationSuccessSchema.parse` проверять `body.operationId === envelope.operationId && body.generation === this.state.generation`; иначе `status(id, 'unknown', 'Ответ относится к другой операции')`, конверт остаётся, `finish` не вызывается. Несовпадение `generation` в снимке обрабатывается существующим путём `reset`/`refresh` (план 07, шаг 22). Тест `tests/web/store.test.ts`: транспорт отвечает успехом с чужим `operationId` → pending `unknown`, ключ в storage на месте.
15. A-03 на клиенте (`astra-14` шаг 4). `snapshotSchema` получает `schemaVersion: z.number().int()`; маршрут снимка отдаёт `schemaVersion()` из плана 06 (шаг 3); сегодня версия есть только в `/health` (`src/server/app.ts:400`, `:419`). Store запоминает `schemaVersion` первого снимка; снимок с другим значением (после `refresh` или `reset`) ставит `state.incompatible = true`: баннер «Сервер обновлён, перезагрузите страницу», `submit` отклоняется, черновики и pending не трогаются. Тест `tests/web/store.test.ts`: снимок с версией 1, затем с версией 2 → `incompatible`, `submit` отклонён, storage без изменений. Правило миграций данных и фикстура прежней версии: план 09, дополнительный шаг 12.
16. Q-04 (`astra-22`) для `drafts.read` и `store.recover` (шаг 8): три теста на каждый: битый JSON; верный `formatVersion` с `fields: null`; неизвестный `formatVersion`. Ожидание: запись пропускается без исключения, сырое значение переносится под ключ `taskindex/corrupt/<исходный ключ>` (не удаляется), один `console.warn` на ключ, `pending` пуст; валидная запись проходит. Аналог для CLI outbox в плане 03 (шаг 18).

2026-09-11 (B, TI-033): семантика записана. Ж4 (план 09, §3): `dryRun` остаётся частью `command_hash` — `executeOperation` хеширует конверт целиком (`src/server/operations.ts:51`), поэтому пробный прогон с уже использованным `operationId` отвечает `operation_mismatch`; это контракт, исход прежней операции выясняется через `GET /api/operations/{id}`, не через dry-run. Экспорт: `formatVersion: 3` = формат 2 плюс массив `appearance` из одной записи; `operationSeq` обязателен у каждой операции экспорта, `settings.schema_version` обязателен для импорта (`src/shared/domain-schemas.ts` `exportSchema`, `src/server/backup.ts:240`). Форматы 1 и 2 только читаются (`upgradeExport`). Обе строки продублированы в `skills/taskindex/SKILL.md`.

## Решение владельца (2026-09-10, делегировано Fable)

- OpenAPI остаётся и становится компактным контрактом для агентов (`$ref`, `operationId`, `securitySchemes`); доступ по ключу, публичный без ключа не делается. Вариант «убрать OpenAPI» из review-1 снят.
- Валидация на клиенте (snapshot, события SSE, ответы операций) сохраняется; вес снимается переходом `src/shared` на `zod/mini`. Вариант «валидация только на сервере» снят.
- Служебные слова `all`, `none`, `by-origin` резервируются в `idSchema`, маршрут поиска по источнику переносится. Курсор операций `operationSeq` принят.

2026-09-10 (A, реализация): шаги 1–7, 11–13, 15 и `digest.comments` сделаны (`src/shared/limits.ts`, `canonical-json.ts`, union из `commandPayloadSchemas`, `.meta({id})`, `issues`, OpenAPI 109 КБ / 19 `operationId` / 34 компонента, `operationSeq` с миграцией `0002_operation_seq.sql`, `RESERVED_IDS`, `/api/tasks/lookup/by-origin`, `schemaVersion` в снимке, `/api/me` с `generation`/`seq`). Отклонения от текста: `/api/openapi.json` по ключу (решение владельца), `/health` с `security: []`; `snapshotSchema.schemaVersion` и `operationSummarySchema.operationSeq` пока `.optional()` в схеме (сервер всегда шлёт; литералы в `tests/web` и моки в `tests/cli` без этих полей, владельцы C и B), `actorSchema` без `.strict()` (CLI парсит `/api/me` через `actorSchema`); скрытый алиас `GET /api/tasks/by-origin` (`hide: true`) до перевода CLI `find-origin`; `digest.comments` отдаёт до 50 комментариев владельца по возрастанию `seq` с `more` и без `nextCursor` (продолжение — `since = seq последнего`), `href` на `/api/events`; `/api/operations?after=` возвращает страницу по возрастанию, без `after` — новые сверху; `validateExport` проверяет плотность `1..N` позиций, а не порядок относительно `createdAt` (часы могут идти назад); backfill в SQL через пересборку таблицы (SQLite не добавляет `NOT NULL` без default). Шаги 8, 9, 14, 16 (web/CLI/docs) — владельцам C и B.
- 2026-09-10 (план 01, шаги 7 и 10, область A): курсор всех постраничных лент — base64url от `{ v: 2, generation, query, key }`, где `key` это позиция последнего показанного элемента (операции `{ operationSeq }`, история `{ seq }`, комментарии `{ createdAt, id }`, задачи `{ orderKey, id }`, группы Focus `{ due | followUp, orderKey, id }`); курсоры без `v: 2` отвечают 400 `invalid`. Журналы продолжаются с монотонной позиции без пропусков и дублей; для списка задач элемент, перемещённый между страницами, может повториться или выпасть, изменение видно по разным `seq` страниц (`list_changed_during_walk`), а единственный согласованный полный список даёт `/api/snapshot`. `GET /api/generation` не вводится: `GET /api/me` уже отдаёт `generation` и `seq`. SSE `event: reset` означает «возьмите снимок»: его шлёт и другое поколение, и отставание курсора больше `sseBacklogLimit` (5 000 событий).
