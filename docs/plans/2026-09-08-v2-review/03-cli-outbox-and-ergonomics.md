# CLI: изоляция outbox по серверу и агенту, устойчивость, справка и эргономика

Статус: предложение, 2026-09-08. Источник: сводное ревью v2 (см. `README.md` в этой папке).
Приоритет: P0 для шагов 1-6 (общий outbox двух агентов на одной машине и битый файл, ломающий все команды: сценарий Claude Code и Codex под одним пользователем macOS), P1 для остального. Оценка: M, 3-4 дня: 1 день на состояние CLI и устойчивость, 1-1.5 дня на спецификацию команд, справку и ошибки, 1 день на курсор, `inbox`, `--all` с повтором и декомпозицию. Зависимости: `02-agent-permissions-and-sync-semantics.md` (удаление `task focus`), `04-api-contract-and-schemas.md` (`digest.comments` для `inbox`, `issues` в ответах, регистрация нового поля `/api/me` в OpenAPI), `01-performance-history-and-pagination.md` (серверная сторона 409 на курсоре), `12-ai-readiness-and-docs.md` (SKILL.md, тест «скилл против справки»).

## 1. Проблема

Все ссылки проверены по текущему дереву 2026-09-08.

### 1.1 A1: общий outbox, `operation resume` отправляет чужой конверт под своим ключом

- `src/cli/outbox.ts:47-53`: каталог `join(XDG_STATE_HOME ?? ~/.local/state, 'taskindex', 'ops')` не зависит ни от сервера, ни от ключа, ни от агента.
- `src/cli/outbox.ts:83-98`: `list(baseUrl)` фильтрует только по `baseUrl`.
- `src/cli/run.ts:212-221`: `outbox.list` вызывается безусловно до любой команды и печатает `pendingOperations` в stderr; `:232-244`: `operation resume` без аргумента пересылает все конверты каталога, `client.resume` (`src/cli/client.ts:183-226`) выполняет их под текущим `TASKINDEX_TOKEN`.
- Конверт (`outbox.ts:7-21`, `SavedOperation`) не содержит идентификатора актора, поэтому CLI не может отличить свой конверт от чужого даже при желании.
- Воспроизведено в живом цикле (`reports/review-5-ai-ready.md`, раздел (d), B4-B7): агент A (`claude-review`, scope `write`) оставил неотправленный `comment.add`; агент B (`codex-review`, scope `tasks`) при `taskindex context` увидел `{"pendingOperations":["leak-op-1"]}`, выполнил `taskindex operation resume` и получил `ok`; `/api/operations/leak-op-1` показывает `"actorId":"agent:codex-review"`. Владелец в «Активности» видит неверного автора, агент B исполнил действие, которого ему не поручали.
- `serverId(baseUrl)` в `outbox.ts:143-146` существует с комментарием «полезен в диагностике», но не вызывается ни в одном файле.

### 1.2 B-05: посторонний или битый файл в outbox ломает все команды, включая чтение

- `outbox.ts:83-98`: `list` для каждого `*.json` вызывает `get(file.slice(0,-5))`; `path()` (`:55-59`) бросает `ArgumentError` при имени вне `/^[A-Za-z0-9_-]{1,80}$/`; `JSON.parse` (`:63`) бросает `SyntaxError`; ни одно не перехвачено.
- `run.ts:212` вызывает `list` до разбора команды: `taskindex context`, `tasks`, любая запись завершаются `{"ok":false,"code":"invalid_arguments"|"client_error"}` с кодом 2 или 1, диагностика не называет файл.
- Репро `scratchpad/repro/outbox-stray.mts` и `outbox-stray2.mts`: `list threw: ArgumentError operationId: недопустимый идентификатор` для `bad name.json`; `list threw (corrupt json): SyntaxError Expected property name or '}' in JSON at position 1` для `goodname.json` с содержимым `{not json`.

### 1.3 A2, §8 качества: справка не является источником, флаги в четырёх копиях, `--json` мёртв

- `run.ts:34-88`: `HELP` статичен: у команд чтения нет флагов (`tasks` без `--q/--area/--project/--status/--archived/--focus`, `activity` без `--actor/--since/--until`, `focus` без `--group`, `find-origin` есть, `digest` без `--since/--generation`), `events --since N [--follow]` без обязательного `--generation`, примеров нет; `taskindex task create --help` печатает тот же общий JSON (`run.ts:198-201`).
- `run.ts:223-230`: `--since N` при `N > 0` требует `--generation`, иначе exit 2 с текстом «Для --since после первого события нужен --generation исходного курсора»; API `/api/digest?since=` работает без `generation` (`src/server/app.ts:943-954`).
- Четыре набора флагов вручную: `switches` в `src/cli/arguments.ts:8-18`; `controls`, `jsonFlags`, `booleanFlags` в `run.ts:90-111`; `HELP.flags` в `run.ts:62-73`. `--json` присутствует в `switches`, `controls`, `HELP` и нигде не читается: вывод всегда JSON (`run.ts:194`). План §10 обещает «`--json` по умолчанию, если stdout не терминал»; реализовано «всегда JSON», текст устарел.
- `runCli` (`run.ts:186-514`, 329 строк): справка, клиент и outbox, `resume` (232-244), `switch` путей чтения (248-324), цикл пагинации, `--follow` и `--out` в одном `do/while` (337-402), сборка конверта (406-504).
- `ApiClient.request` (`src/cli/client.ts:92-103`): два транспорта, `hc<AppType>` для двух POST и `fetch` для остального; из-за `import type { AppType } from '../server/app.js'` (`client.ts:3`) `tsc` CLI тянет тип всего сервера (Ж2, вторая часть).

### 1.4 A3, A4, A5, A10, A11: ошибки и пробелы

- A3 `run.ts:450-459`: `issues` печатаются как есть: `Invalid input: expected number, received undefined` для `baseRevision`, `Invalid option: expected one of…` для `area` (транскрипт 14, 17). Сервер отвечает по-русски, CLI по-английски; подсказки («возьмите `revision` из `task get`») нет. Локаль `ru` в Zod 4 есть: `node_modules/zod/v4/locales/ru.js`.
- A4 `run.ts:430`: `command = \`${group}.${action}\``; `:448-449`: `taskindex task`→ «Неизвестная команда: task.undefined»,`taskindex me`→ «me.undefined».`GET /api/me` (`app.ts:427-434`) в CLI недоступен.
- A5 `run.ts:256-266`: allow-list `tasks` без `today` и `hasFollowUp`; API принимает оба (`app.ts:551-552`, обработка `:570-574`). Владелец в UI пользуется «На сегодня» (`src/web/app/shell.tsx:134-136`), агент этот список воспроизвести не может.
- A10 `run.ts:190-191`: `process.stdout.write` без обработчика `error`; `taskindex tasks --all --limit 1 | head -c 50` даёт трассу `Unhandled 'error' event … EPIPE` (`scratchpad/epipe.txt`: путь через `run.ts:191`, `:194`, `:375`).
- A11 `run.ts:377-393`: `--follow` печатает страницу каждую секунду, включая пустые `{"events":[]}`.
- A6: курсор `since`/`generation` CLI не сохраняет; SKILL.md:12-16 требует «сохранять `since` только после всех страниц» и «не терять поколение», но места хранения нет.
- A7: ответы владельца (комментарии) читаются только через `events --since --generation | jq` с фильтром по `entityKind === 'comment' && actorId === 'owner'` (транскрипт D5-D6); `digest` (`app.ts:938-1011`) комментариев не содержит.

### 1.5 Три реализации `canonical()`

- `src/server/operations.ts:27-34` и `src/server/admin.ts:231-238`: `JSON.stringify` с сортировкой ключей по кодовым единицам (`a < b`).
- `src/cli/outbox.ts:23-32`: собственная сериализация с `localeCompare`.
- Проверено 2026-09-08 (`scratchpad/golden.mts`): на реальных конвертах (camelCase-ключи) результаты совпадают; на ключах смешанного регистра расходятся: сервер даёт `{"B":1,"_x":3,"a":2,"ä":4}`, outbox `{"_x":3,"a":2,"ä":4,"B":1}`. Серверная версия определяет `commandHash` в таблице `operations`, поэтому именно она является контрактом. Эталон для теста: конверт `{"operationId":"op-golden","generation":"gen-golden","command":"task.create","payload":{"title":"Тест","area":"agency","note":"","checklist":[{"id":"i1","text":"шаг","done":false}]}}` → канонический `{"command":"task.create","generation":"gen-golden","operationId":"op-golden","payload":{"area":"agency","checklist":[{"done":false,"id":"i1","text":"шаг"}],"note":"","title":"Тест"}}`, sha256 `fc548ecccf52804821ba08d9737c89558fd9d3eeb30c82450773316d0f2a2f19`.

### 1.6 Ж2: тяжёлый `/api/context` ради `generation`

`run.ts:463-477`: перед каждой записью без `--generation` CLI запрашивает `/api/context`: полное состояние проектов, JSON-схемы 16 команд, счётчики (25 406 байт в живом цикле). То же для `events` без `--generation` (`run.ts:327-334`). Нужен только `generation`. `/health` (`app.ts:390-425`) отдаёт `generation` без авторизации, но план 11 закрывает `/health` по allowlist в Nginx, поэтому CLI на него опираться не должен. `/api/me` (`app.ts:427-434`) авторизован и лёгок, но `generation` не содержит.

### 1.7 B-09 (сторона CLI): 409 на курсоре прерывает `--all`

`app.ts:220-221`: курсор привязан к `latestSeq`, любая запись даёт `409 conflict «Данные изменились. Начните чтение страниц заново.»`. `run.ts:394-401`: `--all` идёт по `nextCursor` и при 409 завершается кодом 3 (`exitCode`, `client.ts:40`) без повтора. Уже напечатанные страницы остаются в stdout, агент трактует результат как конфликт. Серверная сторона (keyset-пагинация) в плане 01.

## 2. Цель и критерии приёмки

1. Состояние CLI разделено по серверу и агенту: два токена разных агентов при одном `XDG_STATE_HOME` не видят конверты друг друга; `operation resume` без аргумента отправляет только свои; `operation resume <id>` чужого конверта отвечает `{"code":"invalid_arguments","message":"Сохранённый конверт не найден"}`; конверт содержит `actorId`. Тест `tests/cli/state.test.ts`.
2. Посторонний файл, файл с недопустимым именем или битый JSON в каталоге outbox не мешает ни одной команде: файл пропускается, в stderr одна строка `{"warning":"outbox_skipped","file":…,"reason":…}`, битый файл переименован в `<имя>.corrupt`. Тест.
3. Справка генерируется из единой спецификации: `taskindex help`, `taskindex help <group> [<action>]`, `<cmd> --help` печатают команды, флаги с типами и обязательностью, пример вызова, коды выхода и коды ошибок. Тест: каждый ключ `commandPayloadSchemas` и каждый query-параметр каждого GET-маршрута из `/api/openapi.json` присутствуют в справке; каждая команда и флаг из SKILL.md присутствуют в справке (сам тест в плане 12).
4. Ошибки аргументов: русские сообщения (`z.config(z.locales.ru())`), у каждой `issue` поле `hint` из карты подсказок, `path` в формате `a.b[0]`; `taskindex task` перечисляет допустимые действия группы; `taskindex me` печатает актора.
5. `taskindex tasks --today true` и `--has-follow-up true` работают и совпадают с `queryTasks({today: true})` и `{hasFollowUp: true}` на сервере.
6. Сохранённый курсор: `taskindex cursor show|commit SEQ|reset`; `digest|activity|events --since last` подставляют `seq` и `generation` из файла; `generation_changed` печатает подсказку сбросить курсор. Сценарный тест.
7. `taskindex inbox [--since last|N]` печатает комментарии владельца с `taskId`, `text`, `seq`, `at` (после `digest.comments` из плана 04).
8. `taskindex tasks --all | head -c 1` завершается тихо с кодом 0; `events --follow` печатает только непустые страницы, интервал задаётся `--interval MS`.
9. `--json` удалён из парсера, справки и документации; `task focus` удалён (после плана 02); `--all` при 409 на курсоре перезапускает обход до 3 раз и печатает страницы только после успешного прохода.
10. Одна реализация канонизации `src/shared/canonical-json.ts`, тест с эталонным хешем из 1.5; `outbox.ts`, `operations.ts`, `admin.ts` её используют.
11. `runCli` не длиннее 120 строк; `src/cli/client.ts` не импортирует `../server/app.js`; `tsc` CLI не зависит от типов сервера (проверка: `grep -rn "server/" src/cli/*.ts` даёт только `admin-run.ts`).
12. Записи без `--generation` делают один лёгкий запрос `GET /api/me` (расширенный полем `generation`) вместо `/api/context`.
13. `npm run check` зелёный; существующие тесты `tests/cli/cli.test.ts` и `tests/cli/agent-cycle.test.ts` адаптированы к новому каталогу состояния и проходят.

## 3. Решение

### 3.1 Раскладка состояния

```
$XDG_STATE_HOME/taskindex/
  servers/<serverId>/                 serverId = sha256(baseUrl без завершающего /)[:12], уже есть в outbox.ts:144
    identities/<tokenHash>.json       tokenHash = sha256(token)[:16]; {actorId, agentId, label, scope, fetchedAt}
    agents/<agentId>/
      ops/<operationId>.json          конверты этого агента
      cursor.json                     {generation, seq, committedAt}
  ops/                                старый каталог (formatVersion 1): только чтение и предупреждение
```

Идентичность агента берётся из `GET /api/me` (`actorSchema`: `id`, `agentId`, `label`, `scope`) и кэшируется по хешу токена. Кэш нужен, чтобы перечислить свои неотправленные конверты до любого сетевого вызова и чтобы не делать лишний запрос на каждое чтение. Ротация ключа даёт новый `tokenHash`, но тот же `agentId`, поэтому каталог `agents/<agentId>` сохраняется, а неотправленные конверты не теряются. При отсутствии кэша и сети список конвертов пропускается с предупреждением в stderr; отправка без сети всё равно невозможна.

Отвергнутые варианты: каталог по `sha256(token)` (ротация ключа осиротит конверты, `agentId` не виден в диагностике); каталог по `agentId` без `serverId` (два сервера с одинаковыми именами агентов смешаются, как сегодня); хранить `actorId` в конверте без разделения каталогов (список чужих конвертов всё равно печатается, каталог растёт).

Конверт `SavedOperation` получает `formatVersion: 2` и `actorId`. Файлы `formatVersion: 1` в старом каталоге `taskindex/ops/` не пересылаются автоматически: при старте CLI печатает в stderr `{"warning":"legacy_outbox","files":[…],"next":"taskindex operation get <id>, затем удалить файл вручную"}`. Автоматический перенос невозможен, так как автор конверта неизвестен.

### 3.2 Спецификация команд как единственный источник

`src/cli/spec.ts` описывает всё декларативно:

```ts
export type FlagSpec = {
  name: string;
  kind: 'string' | 'boolean' | 'json' | 'number';
  description: string;
  required?: boolean;
  values?: readonly string[];
};
export type ReadSpec = {
  group: string;
  action?: string;
  path: string | ((id: string) => string);
  positional?: string[];
  query: FlagSpec[];
  pageable?: boolean;
  summary: string;
  example: string;
};
export type WriteSpec = {
  group: string;
  action: string;
  command: CommandName;
  positional: { name: string; payloadKey: string }[];
  summary: string;
  example: string;
};
export const GLOBAL_FLAGS: FlagSpec[]; // dry-run, operation-id, base-revision, generation, payload, file, all, limit, cursor, help, interval, out, operation
export const READS: ReadSpec[];
export const WRITES: WriteSpec[]; // ключи проверяются типом: Record<CommandName, …> без 'undo' и с явной записью для undo
export const HINTS: Record<string, string>; // подсказки по path[0] или полному пути
```

Из спецификации выводятся: `switches` (`kind: 'boolean'`), `jsonFlags`, allow-list каждого чтения, `HELP`. Флаги команд записи не перечисляются руками: они выводятся из `z.toJSONSchema(commandPayloadSchemas[command])` (свойства верхнего уровня, `required`, `description`, `enum`), как уже делает `/api/context` (`app.ts:893-896`). Тест сверяет `READS[*].query` с параметрами `/api/openapi.json`, чтобы CLI не отставал от API (как случилось с `today`).

Отвергнуто: `node:util.parseArgs`. Текущий парсер (`arguments.ts`, 104 строки) уже покрыт тестами и поддерживает `--k=v`, `--`, `-q`; замена даст мало, а поведение `switch` со значением (`--focus false`) в `parseArgs` требует обходных решений.

### 3.3 Ошибки

- `src/cli/index.ts`: `z.config(z.locales.ru())` до вызова `runCli` (Zod 4.5.4 содержит `ru`). Сервер делает то же в `createApp` (план 04), чтобы `issues` с обеих сторон были на одном языке.
- `src/cli/errors.ts`: `cliErrorCodeSchema = z.enum([...errorCodeSchema.options, 'invalid_arguments', 'client_error', 'network_error', 'invalid_response', 'admin_error'])`; `formatIssues(issues)` → `[{path: 'payload.baseRevision', message, hint}]`; `HINTS`: `baseRevision` → «Возьмите revision из `taskindex task get ID` и передайте `--base-revision N`»; `area` → «Допустимо: agency, development, personal»; `status` → «Допустимо: todo, doing, waiting, done»; `origin.version` → «Упорядоченная версия самого источника, не время наблюдения»; `generation` → «Возьмите generation из `taskindex me` или используйте `--since last`»; `id`/`taskId`/`itemId` → «Идентификатор: латиница, цифры, `_`, `-`, до 80 символов».
- Ошибка неполной команды: `{"ok":false,"code":"invalid_arguments","message":"task: ожидается get|history|find-origin|create|sync|update|save|move|archive|restore","hint":"taskindex help task"}`; неизвестная группа: `message: "Неизвестная команда: foo"`, `hint: "taskindex help"`.
- EPIPE: в `src/cli/index.ts` `process.stdout.on('error', (error) => { if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0); throw error; })`.

### 3.4 Курсор и `inbox`

`cursor.json` пишется только явной командой `taskindex cursor commit SEQ [--generation G]` (без `--generation` берётся из последнего успешного ответа этой же команды или из `/api/me`) или флагом `--commit` у `digest`/`activity`/`events`, который записывает курсор после того, как все страницы прочитаны (`more: false`). Автоматической записи после каждого чтения нет: SKILL.md требует сохранять `since` только после дочитывания всех страниц. `--since last` подставляет `seq` и `generation`; если файла нет, `since=0` и `generation` из `/api/me`. При `409 generation_changed` CLI печатает ответ сервера и `hint: "taskindex cursor reset, затем taskindex digest"`.

`taskindex inbox [--since last|N] [--generation G]` читает `GET /api/digest?since=…` и печатает раздел `comments` (план 04 добавляет: комментарии владельца после `since` с `taskId`, `taskTitle`, `text`, `seq`, `at`, постранично с `href`). Пока 04 не выполнен, `inbox` не добавляется: клиентская фильтрация `events` дублировала бы серверную логику.

### 3.5 `--all`, `--follow`, `me`, `openapi`

- `--all`: страницы накапливаются в памяти и печатаются по одной JSON-строке (формат прежний, SKILL.md:14-15) только после успешного прохода; при `409 conflict` с текстом курсора обход начинается заново, не более 3 раз, каждая попытка отмечается строкой в stderr `{"restart": n, "reason": "cursor_conflict"}`; после третьей неудачи печатается ответ сервера, код 3.
- `--follow`: печатает только страницы с событиями; пауза `--interval MS` (по умолчанию 1000, минимум 250); пустые страницы не печатаются. Возврат к печати пустых страниц не предусмотрен: для агента они шум.
- `taskindex me` → `GET /api/me`. `taskindex openapi` → `GET /api/openapi.json` (отдаётся без авторизации после плана 04, но CLI шлёт заголовок как обычно).
- `taskindex task focus` удаляется вместе с планом 02 (агентам поле недоступно). До выполнения плана 02 команда остаётся и печатает предупреждение в stderr.

### 3.6 Лёгкий запрос за `generation`

`GET /api/me` расширяется полем `generation` (и `seq`): в `app.ts:427-434` ответ `{ ...c.get('actor'), generation: generation(db), seq: latestSeq(db) }`, схема `meSchema = actorSchema.extend({ generation: idSchema, seq: z.number().int().nonnegative() })` в `src/shared/domain-schemas.ts`. Это единственная серверная правка плана; план 04 регистрирует `meSchema` в OpenAPI. CLI перед записью без `--generation` вызывает `/api/me` и одним запросом получает и актора (обновляет кэш идентичности), и `generation`.

### 3.7 Один транспорт

`ApiClient.request` использует только `fetch`; `hc<AppType>` и `import type { AppType }` удаляются. Конверты уже проверяются `commandEnvelopeSchema`/`batchEnvelopeSchema` до отправки (`run.ts:486-496`), RPC-типизация ничего не добавляла. Это снимает зависимость `src/cli` от `src/server` (кроме `admin-run.ts`, который намеренно работает с базой напрямую).

### 3.8 Декомпозиция

```
src/cli/index.ts      локаль Zod, EPIPE, сигналы, вызов runCli
src/cli/run.ts        разбор argv, диспетчер: help | me | cursor | operation resume | read | write   (<= 120 строк)
src/cli/spec.ts       READS, WRITES, GLOBAL_FLAGS, HINTS
src/cli/help.ts       renderHelp(spec, group?, action?) -> JSON
src/cli/state.ts      CliState: serverId, identity(token) с кэшем, Outbox для агента, Cursor
src/cli/outbox.ts     Outbox(directory): list с пропуском битых файлов, put/get/remove как сегодня
src/cli/reads.ts      buildReadPath(args), runRead: страницы, --all с перезапуском, followEvents, export --out
src/cli/writes.ts     buildEnvelope(args, spec), runWrite
src/cli/resume.ts     runResume
src/cli/errors.ts     cliErrorCodeSchema, formatIssues, HINTS применение
src/cli/client.ts     ApiClient: request(fetch), send, resume (без hc)
src/shared/canonical-json.ts   canonicalJson(value)
```

## 4. Шаги

Работа в отдельном worktree. Шаги 1-6 это P0-часть; тесты шагов 1-2 пишутся первыми и должны падать на текущем коде.

1. **Тесты изоляции и устойчивости (новый `tests/cli/state.test.ts`).** По образцу `tests/cli/cli.test.ts:25-56` (инъекция `fetch`, `stdout`, `stderr`, `XDG_STATE_HOME` в `mkdtemp`). Сценарии раздела 5, критерии 1-2. Для двух токенов `fetch` возвращает разные `/api/me` (`agent:a` и `agent:b`).

2. **`src/shared/canonical-json.ts`.** Перенести реализацию из `operations.ts:27-34` без изменений; `export function canonicalJson(value: unknown): string`. Тест `tests/unit/canonical-json.test.ts`: эталонная строка и хеш из раздела 1.5; смешанный регистр ключей даёт порядок по кодовым единицам (`B` раньше `_x`). Заменить локальные `canonical` в `operations.ts`, `admin.ts:231-238`, `outbox.ts:23-32` (`sameOperation`). Проверить `tests/api/*` и `tests/cli/*`: хеши существующих операций не меняются, так как алгоритм сервера сохранён байт в байт.

3. **`src/cli/state.ts` и правки `outbox.ts`.**
   - `Outbox` получает `constructor(directory: string)`; `list()` без аргумента `baseUrl` (каталог уже привязан к серверу), но `baseUrl` в конверте остаётся и сверяется в `client.send/resume` как сегодня (`client.ts:125-128`, `:184-187`).
   - `list()`: имена, не подходящие под `/^[A-Za-z0-9_-]{1,80}\.json$/`, пропускаются с предупреждением; `get()` при `SyntaxError` или несоответствии формата переименовывает файл в `<имя>.corrupt` через `rename` и возвращает `undefined`, предупреждение в stderr через инъецированный `warn`. Файлы `.pending-*` (временные, `outbox.ts:103`) старше часа удаляются.
   - `SavedOperation`: `formatVersion: 2`, `actorId: string`. `get()` принимает `formatVersion 1` только в legacy-каталоге.
   - `CliState`: `serverId(baseUrl)`, `identity(token, fetchMe)`: читает `identities/<tokenHash>.json`, при отсутствии вызывает `fetchMe` (`GET /api/me`) и записывает файл `0600`; `outboxFor(agentId)`; `cursor` (`read/commit/reset`); `legacyPending()` для предупреждения.
   - `run.ts` использует `CliState` вместо `new Outbox(env)`; `pendingOperations` печатается только для своих конвертов; `operation resume` без id: только свои; с id чужого: «Сохранённый конверт не найден».

4. **Расширить `/api/me`** (`src/server/app.ts:427-434`) полем `generation` и `seq`; `meSchema` в `src/shared/domain-schemas.ts`; тест в `tests/api/auth.test.ts` или `commands.test.ts`: ответ соответствует `meSchema`, `generation === generation(db)`. `run.ts:463-477` и `:327-334`: заменить `/api/context` на `/api/me`, парсить `meSchema.safeParse`, попутно обновлять кэш идентичности.

5. **EPIPE и локаль** в `src/cli/index.ts` (раздел 3.3). Тест `tests/cli/process.test.ts`: `spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'help'])` с `stdout.destroy()` сразу после первого чанка; ожидание: код 0, stderr пустой. Запускать под Node 24 (vitest уже так работает).

6. **Адаптация существующих тестов.** `tests/cli/cli.test.ts:108-118` читает `join(directory, 'taskindex', 'ops', 'op1.json')`: заменить на путь через `CliState` (экспортировать хелпер `statePaths(env, baseUrl, agentId)`); хендлеры `fetch` в тестах должны отвечать на `/api/me` (`{id:'agent:test', agentId:'test', label:'Тест', kind:'agent', scope:'write', generation:'g_first', seq:0}`) вместо `/api/context`. `tests/cli/agent-cycle.test.ts:60-66` уже даёт каждому агенту свой `XDG_STATE_HOME`; добавить утверждение, что при общем каталоге `reviewer` не видит конверт `source`. Прогнать `npm run check`; зафиксировать P0-часть отдельным коммитом.

7. **`src/cli/spec.ts` и `src/cli/help.ts`.** Перенести `HELP`, `controls`, `jsonFlags`, `booleanFlags` (`run.ts:34-111`) и `switches` (`arguments.ts:8-18`) в спецификацию; `parseArguments(argv, switches)` получает множество булевых флагов параметром. `renderHelp` строит JSON:

   ```json
   {"command":"task create","usage":"taskindex task create [ID] --area A --title T [--project-id P] [--note ...] | --payload JSON | --file F",
    "flags":[{"flag":"--area","type":"agency|development|personal","required":true,"description":"Область задачи или проекта"}, …],
    "globalFlags":[…],"example":"taskindex task create --area agency --title 'Проверить отчёт' --due 2026-09-10",
    "exitCodes":{…},"errorCodes":["invalid",…,"invalid_arguments",…]}
   ```

   Флаги записи из `z.toJSONSchema(commandPayloadSchemas[command]).properties` (имя → kebab-case, `type`/`enum`/`description`, `required`). Тест `tests/cli/help.test.ts`: (а) для каждого `CommandName` есть запись `WRITES` и её справка содержит все свойства схемы; (б) поднять приложение через `fixture()` из `tests/api/helpers.ts`, получить `/api/openapi.json`, для каждого `paths[p].get.parameters[in=query]` найти соответствующий флаг в `READS` (camelCase → kebab-case), исключение только для `/api/events/stream`; (в) `taskindex help tasks` содержит `--today` и `--has-follow-up`.

8. **A4, A5, `me`, `openapi`, `--json`, `task focus`.** В `spec.ts`: `tasks.query` += `today`, `has-follow-up` (в URL `hasFollowUp`); `READS` += `me`, `openapi`; диспетчер при отсутствии `action` или неизвестной паре печатает список действий группы (раздел 3.3). Удалить `json` из всех наборов; `--json` теперь неизвестный флаг → `invalid_arguments` с `hint: "вывод всегда JSON, флаг удалён"`. `task focus`: удалить из `WRITES` после мерджа плана 02 (до этого оставить с предупреждением).

9. **`src/cli/errors.ts`** (раздел 3.3); `run.ts:450-459` и `:486-496` печатают `formatIssues`. Тест: `task move t1 --status doing` без `--base-revision` → `issues[0] = {path:'baseRevision', message: <русское>, hint: <про task get>}`.

10. **Курсор** (`state.ts`, раздел 3.4): команды `cursor show|commit|reset`; `--since last` для `digest`, `activity`, `events`; `--commit` для тех же. Проверка `run.ts:223-230` сохраняется для явного числового `--since` без `--generation`, текст дополняется `hint: "используйте --since last или передайте --generation"`. Тест: `digest` → `cursor commit 7` → `digest --since last` формирует URL `since=7&generation=G`; после ответа `409 generation_changed` вывод содержит `hint` про `cursor reset`.

11. **`--all` с перезапуском и `--follow` без пустых страниц** (`reads.ts`, раздел 3.5). Тесты: хендлер отдаёт страницу 1, затем 409 на курсор, затем страницы 1 и 2 успешно → stdout две строки без дублей, stderr одна строка `restart: 1`; хендлер отдаёт 409 четыре раза → код 3, вывод сервера; `--follow` с мок-`sleep`: две пустые страницы и одна с событием → одна строка stdout.

12. **`inbox`** после плана 04: `READS` += `inbox` над `/api/digest`, вывод только раздела `comments` плюс `generation`, `seq`. Тест на форму вывода с мок-ответом.

13. **Декомпозиция** по разделу 3.8; `ApiClient` без `hc`; удалить `import type { AppType }`; `runCli` до 120 строк. Проверка: `npm run check`, `wc -l src/cli/run.ts`, `grep -rn "server/" src/cli/*.ts`.

14. **Документы.** `README.md:75` (`npm run cli -- --help`) описать `help <group>`; `skills/taskindex/SKILL.md`: путь outbox `$XDG_STATE_HOME/taskindex/servers/<server>/agents/<agent>/ops`, `--since last`, `cursor commit`, `inbox`, `me`, удаление `--json` (текст в плане 12); `docs/plans/2026-09-08-taskindex-v2.md` §10: отметить отклонение по `--json` и путь outbox (список дрейфа в плане 12).

15. **Проверка.** `npm run check`; ручной прогон по транскрипту ревью готовности с двумя ключами и общим `XDG_STATE_HOME` на sandbox (план 12): B не видит `leak-op-1`, `taskindex task` печатает действия, `taskindex tasks --today true` работает, `| head -c 1` тихо.

## 5. Тесты

| Критерий | Файл                                  | Сценарий                                                                                                                                  | Ожидание                                                                                                                    |
| -------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1        | `tests/cli/state.test.ts`             | токен A: `comment add` с обрывом сети до отправки (конверт остаётся); токен B (`/api/me` → `agent:b`), тот же `XDG_STATE_HOME`: `context` | stderr B без `pendingOperations`; каталог `agents/b/ops` пуст; файл A лежит в `agents/a/ops/` с `actorId: "agent:a"`        |
| 1        | там же                                | B: `operation resume`                                                                                                                     | `{"ok":true,"resumed":0}`, ни одного POST                                                                                   |
| 1        | там же                                | B: `operation resume <id A>`                                                                                                              | код 2, «Сохранённый конверт не найден»                                                                                      |
| 1        | там же                                | A с новым токеном (другой `tokenHash`, тот же `agentId`)                                                                                  | видит и досылает свой конверт                                                                                               |
| 1        | там же                                | старый каталог `taskindex/ops/x.json` формата 1                                                                                           | stderr `legacy_outbox`, файл не отправлен, команда выполнена                                                                |
| 2        | там же                                | в `agents/a/ops/`: `bad name.json`, `zzz.json` = `{not json`, `.pending-old`                                                              | `context` код 0; stderr две строки `outbox_skipped`; `zzz.json` переименован в `zzz.json.corrupt`                           |
| 10       | `tests/unit/canonical-json.test.ts`   | эталонный конверт                                                                                                                         | строка и sha256 из 1.5; порядок ключей `B`, `_x`, `a`                                                                       |
| 12       | `tests/api/*.test.ts`                 | `GET /api/me`                                                                                                                             | соответствует `meSchema`, `generation` совпадает с базой                                                                    |
| 12       | `tests/cli/cli.test.ts`               | любая запись без `--generation`                                                                                                           | ровно один запрос `/api/me`, ни одного `/api/context`                                                                       |
| 8        | `tests/cli/process.test.ts`           | реальный процесс CLI, stdout закрыт после первого чанка                                                                                   | код 0, stderr пустой                                                                                                        |
| 3        | `tests/cli/help.test.ts`              | `help`, `help task create`, `task create --help`                                                                                          | все свойства схемы `task.create` присутствуют; пример есть                                                                  |
| 3        | там же                                | параметры GET из `/api/openapi.json`                                                                                                      | каждый есть в `READS`                                                                                                       |
| 4        | `tests/cli/cli.test.ts`               | `task move t1 --status doing`                                                                                                             | код 2, `issues[0].path === 'baseRevision'`, русское `message`, `hint`                                                       |
| 4        | там же                                | `taskindex task`, `taskindex foo`                                                                                                         | код 2, список действий / `hint: taskindex help`                                                                             |
| 4        | там же                                | `taskindex me`                                                                                                                            | GET `/api/me`, вывод тела                                                                                                   |
| 5        | там же и `tests/api/commands.test.ts` | `tasks --today true`, `tasks --has-follow-up false`                                                                                       | URL `today=true`, `hasFollowUp=false`; набор совпадает с `queryTasks`                                                       |
| 6        | `tests/cli/cursor.test.ts`            | `cursor commit 7 --generation g1`; `digest --since last`; `events --since last --commit` при `more:false`                                 | URL `since=7&generation=g1`; `cursor.json` обновлён до последнего `seq`; при 409 `generation_changed` вывод содержит `hint` |
| 7        | `tests/cli/cli.test.ts`               | `inbox --since last` с мок-`digest`                                                                                                       | вывод `comments`                                                                                                            |
| 8        | там же                                | `events --follow`, мок-`sleep`, пустые страницы                                                                                           | одна строка stdout на страницу с событиями                                                                                  |
| 9        | там же                                | `--all` с 409 на второй странице, затем успех                                                                                             | две строки stdout, stderr `restart: 1`; после 4 неудач код 3                                                                |
| 9        | там же                                | `--json`                                                                                                                                  | код 2, `hint` про удалённый флаг                                                                                            |
| 11, 13   | `npm run check`                       |                                                                                                                                           | зелёный; `src/cli/run.ts` <= 120 строк                                                                                      |

## 6. Риски и откат

- **Смена каталога состояния.** Незавершённые конверты старого формата у владельца на машине не переносятся автоматически; CLI предупреждает и указывает путь. До рабочего переключения таких конвертов не ожидается; после него формат уже новый.
- **Кэш идентичности при отзыве ключа.** Кэш говорит «агент X», сервер отвечает 403 на первый же запрос; CLI печатает ответ сервера, запись не выполняется. Отзыв не даёт ложных отправок, так как конверт всё равно уходит с текущим токеном.
- **`--all` буферизует страницы.** Память: до `limit × страниц` записей; для личной доски это единицы мегабайт. Поведение при `--follow` не меняется (потоковое).
- **Удаление `hc`.** Теряется компиляционная проверка путей двух POST; заменяется тестом `tests/cli/cli.test.ts` на точные URL `/api/commands` и `/api/commands/batch` (уже есть в сценариях `bodies`).
- **`z.config(z.locales.ru())` глобально.** Затрагивает только процесс CLI; тесты, сравнивающие английские сообщения Zod, отсутствуют (проверено `grep -rn "Invalid input" tests/`).
- Откат: P0-часть (шаги 1-6) и остальное коммитятся раздельно; каждая часть откатывается `git revert` без миграций данных, старый каталог outbox остаётся на диске нетронутым.

## 7. Вне объёма

- Серверная keyset-пагинация, снимающая 409 на курсоре: `01-performance-history-and-pagination.md`.
- `digest.comments`, `issues` в ответах сервера, регистрация схем в OpenAPI, публичный `/api/openapi.json`: `04-api-contract-and-schemas.md`.
- Запрет `focus` для агентов и политика undo: `02-agent-permissions-and-sync-semantics.md`.
- Тексты SKILL.md, установка скилла, тест «скилл против справки», sandbox для ручного прогона: `12-ai-readiness-and-docs.md`.
- Разрез `admin-run.ts` и его флаги (`--password-op` не в README): документация в плане 12, структура в `06-server-structure-config-logging.md`.
- SSE-клиент в CLI вместо опроса `events --follow`: не планируется, опрос достаточен (вердикт ревью готовности).

## Покрытые находки

| ID                      | Отчёт                          | Кратко                                                                   | Где в плане                          |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------ |
| A1                      | AI-готовность                  | общий outbox, `operation resume` шлёт чужой конверт                      | 1.1, 3.1, шаги 1, 3, 6               |
| B-05                    | баги                           | битый или посторонний файл ломает все команды                            | 1.2, шаги 1, 3                       |
| A2                      | AI-готовность                  | справка без флагов и примеров, `--since` требует `--generation` молча    | 1.3, 3.2, шаги 7, 10                 |
| A3                      | AI-готовность                  | английские Zod-сообщения без подсказок                                   | 1.4, 3.3, шаги 5, 9                  |
| A4                      | AI-готовность                  | `task.undefined`, нет `me`                                               | 1.4, 3.3, 3.5, шаг 8                 |
| A5                      | AI-готовность                  | CLI отвергает `today`, `hasFollowUp`                                     | 1.4, шаг 8                           |
| A6                      | AI-готовность                  | нет сохранённого курсора                                                 | 1.4, 3.4, шаг 10                     |
| A7                      | AI-готовность                  | ответы владельца нечем прочитать                                         | 1.4, 3.4, шаг 12 (API в плане 04)    |
| A10                     | AI-готовность                  | EPIPE при `\| head`                                                      | 1.4, 3.3, шаг 5                      |
| A11                     | AI-готовность                  | `--follow` печатает пустые страницы                                      | 1.4, 3.5, шаг 11                     |
| §8 качества             | качество                       | четыре набора флагов, `--json` no-op, `runCli` 329 строк, два транспорта | 1.3, 3.2, 3.7, 3.8, шаги 7, 8, 13    |
| три `canonical()`       | качество §3                    | разные алгоритмы канонизации                                             | 1.5, шаг 2                           |
| Ж2                      | архитектура                    | `/api/context` ради `generation`, `hc` тянет тип сервера                 | 1.6, 3.6, 3.7, шаги 4, 13            |
| B-09 (CLI)              | баги, архитектура V1           | 409 на курсоре прерывает `--all`                                         | 1.7, 3.5, шаг 11                     |
| B7 (часть)              | AI-готовность                  | неиспользуемый `serverId`                                                | 3.1, шаг 3 (начинает использоваться) |
| план §10 `--json`       | AI-готовность B6, качество §10 | документация обещает `--json` по TTY                                     | шаги 8, 14                           |
| Astra B-03              | astra / TI-004                 | CLI считает любой 2xx JSON без `ok:false` успехом и удаляет конверт      | шаг 16                               |
| Astra Q-04 (CLI-часть)  | astra / TI-022                 | конверт outbox читается без схемы; сырые байты надо сохранять            | шаги 3, 18                           |
| Astra B-04 (курсор CLI) | astra / TI-008                 | `--since last` для `activity`/`digest` не видит операций без событий     | шаг 17; курсор операций в плане 04   |

## Сверка с ревью Astra (2026-09-08)

Кратко: Astra добавила B-03 (`astra-04-cli-operation-acknowledgement.md`, реестр TI-004): `exitCode` (`src/cli/client.ts:41-43`) возвращает 0 для любого 2xx с `body.ok !== false`, и `send` (`:144-148`) по этому признаку удаляет конверт; probe с ответом `{"status":"maintenance"}` даёт exit 0 и пустой outbox, повтор при сверке это подтвердил. Ревью-4 называло причину («клиент не валидирует ответы»), но не довело до следствия для durable outbox; здесь Astra точнее. Astra пропустила A1 (общий outbox двух агентов, TI-035, после повтора координатором поднят до P1), B-05 (посторонний файл ломает все команды, TI-039) и B-09 (409 на курсоре, TI-037), хотя перечислила `resume` и outbox как проверенные (`docs/audits/2026-09-08-multiside-review/03-bugs.md:232`). Их Q-04 (`astra-22`) о форме сохранённых данных совпадает с `formatVersion: 2` и `.corrupt` шага 3.

### Добавлено по итогам сверки

| Пункт                                                                                                                                  | Источник Astra                       | Реестр         | План Astra                                        | Что делаем здесь / где делается                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Перед удалением конверта проверять тело ответа схемой и совпадение `operationId`/`generation`; неизвестный ответ хранить как `unknown` | B-03                                 | TI-004         | `astra-04`, шаги 1-5                              | шаг 16 ниже; таблица исходов из `astra-04` шаг 2 ложится на коды выхода 0/1/2/3/4 этого плана          |
| `GET /api/operations/{id}` с сохранённым отказом не считать успехом                                                                    | B-03                                 | TI-004         | `astra-04`, шаг 3                                 | `client.resume` (`src/cli/client.ts:207-225`) уже различает `result.ok`; закрепляется тестом в шаге 16 |
| Схема сохранённого конверта; тесты malformed / верная версия неверная форма / старая версия; сырые байты не удалять                    | Q-04                                 | TI-022         | `astra-22-persisted-drafts-and-outbox-schemas.md` | шаг 3 уже вводит `formatVersion: 2` и `.corrupt`; шаг 18 ниже даёт Zod-схему и три теста               |
| Сохранённый курсор должен учитывать B-04                                                                                               | B-04, `ASTRA-VS-FABLE.md` §5 (FI:A6) | TI-008, TI-047 | `astra-08-operation-feed-cursor.md`               | шаг 17 ниже; курсор операций в плане 04                                                                |
| Идентичность агента при ротации ключа не должна теряться                                                                               | `ASTRA-VS-FABLE.md` §2 (FI:A1)       | TI-035         | нет                                               | 3.1 уже: каталог по `agentId`, кэш идентичности по хешу токена; без изменений                          |

### Расхождения и решение

- Тяжесть B-03. Astra P2, реестр P2; сверка по багам: низкая (нужен upstream, отвечающий JSON 200 не от TaskIndex: ошибочный `TASKINDEX_URL`, чужой прокси; HTML-заглушка nginx уже ловится `invalid_response`). Решение: делать в P0-части вместе с шагами 1-6, потому что правка это одна проверка в `client.ts:144-148`, а нарушение гарантии durable outbox настоящее.
- A1 и B-05. Astra не нашла; координатор реестра воспроизвёл A1 повторно (`createdBy=agent:agent-b`, конверт удалён) и поставил P1. План уже P0 для шагов 1-6; изменений нет.
- `hc<AppType>`. `astra-05` (web) советует использовать существующий Hono `AppType`/`hc` там, где он сохраняет тип маршрута; здесь 3.7 удаляет `hc` из CLI. Решение: удаление остаётся. Типы компиляции не проверяют байты ответа (о чём сама Astra говорит в S-04), два POST покрываются тестами на точные URL, а runtime-проверка схемами (шаг 16) даёт то, чего `hc` не давал.
- `astra-04` требует таблицу «outcome → exit code → состояние outbox» и проверку «после обрыва между commit и ответом CLI находит stored result»; второе уже покрыто `tests/cli/agent-cycle.test.ts` (шаг 5 агентского цикла), первое добавляется в справку (шаг 16).

### Дополнительные шаги

16. B-03, `src/cli/client.ts`. В `send` (`:144-148`) заменить признак успеха: `successful = operationSuccessSchema.safeParse(reply.body).success && reply.body.operationId === envelope.operationId && reply.body.generation === envelope.generation`; `definitive = operationErrorSchema.safeParse(reply.body).success && reply.body.retryable === false`; во всех остальных случаях (2xx без `ok`, пустое тело, чужой `operationId` или `generation`, неизвестный `code`) конверт остаётся, возвращается `{ status: reply.status, body: { ok: false, code: 'invalid_response', message: 'Ответ сервера не подтверждает операцию; проверьте taskindex operation get <id>', retryable: true } }`, код выхода 1. `exitCode` (`:41-43`) возвращает 0 для записи только при теле, прошедшем `operationSuccessSchema`; для чтений поведение прежнее. В `resume` (`:207-225`) тело `GET /api/operations/{id}` проверять `storedOperationSchema.safeParse`: сохранённый отказ (`result.ok === false`) удаляет конверт и даёт код по `status`, сохранённый успех даёт 0, любое другое 2xx тело считается `unknown` и конверт не удаляет. В справку (шаг 7) добавить таблицу «исход → код выхода → конверт»: успех → 0 → удалён; окончательный отказ → 1, при 409 → 3 → удалён; повторяемый отказ или сеть → 1 → сохранён, `status: unknown`; неподтверждённый ответ → 1, `invalid_response` → сохранён. Тесты (`tests/cli/cli.test.ts` или `tests/cli/client.test.ts` из плана 10): `{status:200, body:{status:'maintenance'}}` → конверт на месте, код 1, `code: 'invalid_response'`; пустое тело; успех с чужим `operationId`; успех с чужой `generation`; настоящий успех → удалён, код 0; сохранённый отказ через `resume` → удалён, код 1 или 3. Приёмка: probe Astra `cli-deletes-outbox-without-operation-result` (`docs/audits/2026-09-08-multiside-review/03-probes.ts`) даёт `outboxExists: true`.
17. Курсор и B-04 (шаг 10). `cursor.json` хранит `{ generation, seq, committedAt }` по событиям; до появления курсора операций (план 04, дополнительный шаг 11) справка для `activity --since last` и `digest --since last` содержит примечание «инкрементальное чтение не показывает операции без событий (отказы, no-op); полная лента: `activity` без `--since`». После плана 04 `cursor.json` получает поле `operationSeq`, `activity --since last` передаёт его в `after=`, примечание убирается. Тест `tests/cli/cursor.test.ts`: после `cursor commit` с ответом, содержащим `operationSeq`, файл хранит оба поля.
18. Q-04, форма конверта (шаг 3). `savedOperationSchema` в `src/cli/outbox.ts`: поля текущего `SavedOperation` (`outbox.ts:7-21`) плюс `formatVersion: z.literal(2)` и `actorId: idSchema`; `envelope` через `operationEnvelopeSchema` из плана 04 (до него `z.union([commandEnvelopeSchema, batchEnvelopeSchema])`); `get()` использует `safeParse` вместо ручных проверок и каста `as SavedOperation` (`:63-70`). При провале файл переименовывается в `<имя>.corrupt` (сырые байты сохраняются), stderr получает `outbox_skipped` с `reason: 'schema'`. Тесты в `tests/cli/state.test.ts`: битый JSON; `formatVersion: 2` с `envelope: null`; `formatVersion: 1` в новом каталоге; все три файла переименованы, команда выполнена, ни одного POST; валидный файл проходит без изменений.
