# TaskIndex v2 — готовность к работе через ИИ-агентов (ревью 5)

Дата: 2026-09-08. Проверено незакоммиченное дерево v2 в `/Users/dmitriy/code/taskindex`
(только чтение; временный сервер и база подняты в scratchpad). Все ссылки на код —
`файл:строка` текущего дерева.

## (a) Вердикт

| Часть                                   | Оценка   | Обоснование одной строкой                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Агенты как операторы продукта        | **6/10** | Ядро (идемпотентность, outbox, `task.sync` с приоритетом владельца, конфликты с `current`, атрибуция, undo, батчи) работает и проверено вживую; проваливается «обнаруживаемость»: справка без примеров и без обязательных флагов, английские Zod-ошибки без подсказок, нет `me`/`--today`/inbox, курсор не сохраняется, общий outbox двух агентов на одной машине смешивает их конверты, OpenAPI не пригоден как справочник (970 КБ, без security/operationId, только по ключу). |
| B. Агенты как разработчики кодовой базы | **4/10** | Нет `CLAUDE.md`/`AGENTS.md`; Node 26 по умолчанию ломает `better-sqlite3` без понятного сообщения; нет одной команды для одноразового окружения (setup-dev пишет `.env` и `data/` в репозиторий); новая команда требует правок в 6+ местах без проверок исчерпывающести; `app.ts` 1072 строки. Хорошее: `npm run check` быстрый (75 тестов за 1.4 с), типы выводятся из Zod, миграции проверяются против snapshot.                                                               |

**Топ-5 блокеров** (по влиянию на ежедневную работу агентов):

1. **Нет инструкции для агента-разработчика** (`CLAUDE.md`/`AGENTS.md` отсутствуют, `.claude/` нет). Агент с нулевым контекстом начнёт с `node` v26, получит падение `better-sqlite3`, затем `npm run setup:dev` перезапишет/создаст `.env` и `data/dev.db` в основном чекауте, нарушив правило worktree-only. → раздел (e).
2. **Общий outbox двух агентов на одной машине** (`src/cli/outbox.ts:47-53`, `:83-98`; `src/cli/run.ts:232-244`): каталог `~/.local/state/taskindex/ops` не разделён по ключу/агенту; `operation resume` без id пересылает ЧУЖОЙ конверт под своим ключом — воспроизведено: конверт агента `claude-review` исполнен как `agent:codex-review` (транскрипт B4–B7). Это и есть сценарий владельца: Claude Code и Codex под одним пользователем macOS.
3. **Справка и скилл не позволяют выполнить операцию без чтения исходников**: `taskindex --help` — один JSON без флагов команд и примеров (`run.ts:34-88`); `--since N` требует `--generation`, о чём справка молчит (`run.ts:223-230`); `tasks --today` не поддерживается CLI при поддержке API (`run.ts:255-266` vs `src/server/app.ts:541-556`); нет `me`; ошибки валидации — английские сообщения Zod без подсказки (`run.ts:452-459`); `taskindex task` → «Неизвестная команда: task.undefined» (`run.ts:430,448-449`).
4. **Нет «что изменилось для меня» и сохранённого курсора**: агент вынужден сам хранить `seq`+`generation` (скилл требует, механизма нет); ответы владельца в комментариях доступны только фильтрацией `events` на клиенте (D6); `digest` не содержит комментариев (`app.ts:938-1011`).
5. **API-контракт не «самообслуживаемый»**: `/api/openapi.json` отдаётся только по ключу (401 без него), 970 600 байт из-за inline-схем без `$ref`, 0 `operationId`, 0 `summary`, нет `securitySchemes` (`app.ts:1056-1065`); ошибка валидации тела — «Проверьте параметры запроса» без `issues` (`app.ts:245-257`, транскрипт B12).

## (b) Матрица паритета UI ↔ CLI ↔ API

Источники: `src/web/app/shell.tsx`, `card.tsx`, `editor.tsx`, `dialogs.tsx`, `activity.tsx`, `sidebar.tsx`, `src/web/lib/use-workspace.ts`; CLI `src/cli/run.ts`; API `src/server/app.ts`. ✓ — есть; ✗ — нет; ~ — есть с оговоркой.

| Операция владельца в UI                          | Команда/маршрут                                                                                                      | CLI                                                                                         | API                              | Комментарий                                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Вход по паролю/passkey, выход                    | Better Auth `/api/auth/*`                                                                                            | н/п                                                                                         | н/п                              | Агенты входят ключом (`auth.ts:47-49`, `Authorization: Bearer` или `x-api-key`)                           |
| Навигация по областям/проектам, список/доска     | `GET /api/tasks?area&project&status`                                                                                 | ✓ `tasks --area --project --status`                                                         | ✓                                | `project=none` работает в обоих                                                                           |
| Глобальный поиск, «искать в архиве»              | `GET /api/tasks?q&archived`                                                                                          | ✓ `tasks -q … --archived true`                                                              | ✓                                |                                                                                                           |
| Фильтр «На сегодня» (`shell.tsx:482`)            | `GET /api/tasks?today=1`                                                                                             | **✗** «Флаг --today не поддерживается»                                                      | ✓ (`app.ts:551`)                 | **Разрыв CLI↔API**; то же `hasFollowUp` (`app.ts:552`)                                                    |
| Экран Focus                                      | `GET /api/focus`, `/api/digest`                                                                                      | ✓ `focus`, `digest`                                                                         | ✓                                |                                                                                                           |
| Архив области                                    | `GET /api/tasks?archived=1&area`                                                                                     | ✓                                                                                           | ✓                                |                                                                                                           |
| Быстрое создание задачи (N)                      | `task.create`                                                                                                        | ✓ `task create` (флаги/`--payload`)                                                         | ✓                                | `--position '{"after":ID}'` есть                                                                          |
| Редактор: сохранить поля+статус+чеклист атомарно | `task.save`                                                                                                          | ✓ `task save --fields/--status/--checklist/--payload`                                       | ✓                                |                                                                                                           |
| Редактор: перенос области/проекта                | `task.save`/`task.update`                                                                                            | ✓ `task update --area --project-id null`                                                    | ✓                                |                                                                                                           |
| Карточка: завершить/вернуть в очередь            | `task.move status=done                                                                                               | todo`                                                                                       | ✓ `task move --status`           | ✓                                                                                                         |                                                                             |
| Карточка: смена колонки, DnD, «В начало очереди» | `task.move before/after`                                                                                             | ~ `task move --before/--after`                                                              | ✓                                | Агенту нужно самому найти первый id (`tasks --status todo`), нет `--first`                                |
| Карточка: в фокус / из фокуса                    | `task.update focus`                                                                                                  | ~ `task focus ID` только ставит; снять — `task update --focus false` (в справке не сказано) | ✓                                |                                                                                                           |
| В архив / вернуть                                | `task.archive                                                                                                        | restore`                                                                                    | ✓                                | ✓                                                                                                         |                                                                             |
| Чеклист: добавить/отметить/удалить/переставить   | `checklist.*`                                                                                                        | ✓                                                                                           | ✓                                |                                                                                                           |
| Комментарии: список, добавить, удалить           | `comment.*`, `GET /tasks/{id}/comments`                                                                              | ✓                                                                                           | ✓                                | Чужой комментарий агенту удалить нельзя (D8) — как у владельца, только владелец может                     |
| История карточки                                 | `GET /tasks/{id}/history`                                                                                            | ✓ `task history`                                                                            | ✓                                |                                                                                                           |
| Проект: создать/изменить (имя, цвет, описание)   | `project.create                                                                                                      | update`                                                                                     | ✓ (нужен scope `write`)          | ✓                                                                                                         | Удаления проекта нет ни в UI, ни в API — паритет соблюдён, продуктовая дыра |
| Активность: лента, раскрыть операцию             | `GET /api/operations`, `/operations/{id}`                                                                            | ✓ `activity`, `operation get`                                                               | ✓                                |                                                                                                           |
| Активность: отменить операцию / событие          | `undo {operationId                                                                                                   | seq}`                                                                                       | ✓ `undo --operation`, `undo SEQ` | ✓                                                                                                         |                                                                             |
| Активность: фильтр по агенту                     | `GET /api/operations?actor=`                                                                                         | ✓ `activity --actor`                                                                        | ✓                                | **В UI фильтра нет** (`activity.tsx:143-160` грузит `?limit=50` без `actor`) — разрыв в сторону владельца |
| Тост «Отменить» после действия                   | `undo {operationId}`                                                                                                 | ✓                                                                                           | ✓                                |                                                                                                           |
| — (только агентам)                               | `task.sync`, `task find-origin`, `batch`, `--dry-run`, `snapshot`, `events`, `export`, `operation resume`, `context` | ✓                                                                                           | ✓                                | В UI нет — так и задумано                                                                                 |
| — (только API)                                   | `GET /api/me`                                                                                                        | **✗** нет `taskindex me`                                                                    | ✓                                | Агент не может проверить, кем он вошёл и с каким scope                                                    |
| — (только API)                                   | `GET /api/openapi.json`                                                                                              | ✗ нет `taskindex openapi`                                                                   | ~ только с ключом                |                                                                                                           |
| —                                                | `GET /api/events/stream` (SSE)                                                                                       | ~ CLI использует опрос `events --follow`                                                    | ✓                                | Приемлемо                                                                                                 |

Итог: из операций владельца агенту недоступна через CLI только «На сегодня» (и `hasFollowUp`), остальное покрыто. Владельцу недоступен фильтр активности по агенту. Плюс два API-маршрута без CLI (`/api/me`, `/api/openapi.json`).

## (c) Подробные находки

Формат: **Серьёзность** · где · почему агент провалится или владелец потеряет доверие · что сделать (критерий приёмки).

### A. Агенты как операторы

**A1 · блокер · Общий outbox и `operation resume` исполняют чужой конверт.**
`src/cli/outbox.ts:47-53` — каталог только из `XDG_STATE_HOME`; `:83-98` — `list()` фильтрует по `baseUrl`, не по ключу/агенту; `src/cli/run.ts:212-221` печатает чужие `pendingOperations`; `:232-244` `operation resume` без id пересылает все. Воспроизведено (B4–B7): агент B (`codex-review`, scope `tasks`) отправил сохранённый конверт агента A и стал автором комментария. Владелец в «Активности» увидит неверного автора; агент B может исполнить действие, для которого у него не было поручения.
→ Разделить состояние: `…/taskindex/<serverId(baseUrl)>/<agentId>/ops` (`agentId` брать из `/api/me` при первом запуске или из sha256(token)[:12]; уже есть неиспользуемый `serverId()` в `outbox.ts:144`); в конверт писать `actorId` (не секрет) и отказываться пересылать чужой; `operation resume` без аргумента — только свои. Критерий: тест в `tests/cli/cli.test.ts`: два токена с одним `XDG_STATE_HOME`, B не видит и не отправляет конверт A.

**A2 · блокер · Справка непригодна как единственный источник.**
`run.ts:34-88` — `HELP` статичен: `events --since N [--follow]` без обязательного `--generation` (проверка `run.ts:223-230`, ответ «Для --since после первого события нужен --generation исходного курсора», exit 2 — транскрипт 29–30; API `/api/digest?since=` при этом работает без generation, D1); `--json` объявлен, но никогда не читается (no-op); нет флагов чтения (`--actor`, `--group`, `--system/--ref`, `--today`); нет примеров; `taskindex task create --help` печатает тот же общий JSON.
→ Генерировать справку из `commandPayloadSchemas` (`z.toJSONSchema`) и таблицы read-запросов: `taskindex help [group [action]]` и `<cmd> --help` с флагами, типами, примером вызова; убрать `--json` или сделать `--human`. Критерий: тест «каждый ключ `commandPayloadSchemas` и каждый query-параметр каждого GET из `app.ts` упомянут в справке».

**A3 · важно · Ошибки аргументов — английские Zod-сообщения без подсказки.**
`run.ts:452-459` печатает `validation.error.issues` как есть: «Invalid input: expected number, received undefined» для `baseRevision` (транскрипт 14), «Invalid option: expected one of…» для `area` (17). Сервер отвечает по-русски, CLI — по-английски; главное — нет `hint` («возьмите `revision` из `task get ID` и передайте `--base-revision`»).
→ `z.config(z.locales.ru())` при старте CLI и карта подсказок по `path[0]` (`baseRevision`, `area`, `origin.version`). Критерий: ошибка содержит `hint` и русский `message`.

**A4 · важно · `taskindex task`, `taskindex me`, `taskindex foo` → «Неизвестная команда: task.undefined».**
`run.ts:430` склеивает `${group}.${action}`; `:448-449` печатает результат склейки. Агент не получает списка допустимых действий.
→ Валидировать `group` и `action` отдельно; в ошибке перечислять допустимые действия группы. Добавить `taskindex me` (`GET /api/me`). Критерий: `taskindex task` → `{"code":"invalid_arguments","message":"task: ожидается get|create|…"}`; `taskindex me` печатает актора и scope.

**A5 · важно · CLI отвергает поддерживаемые API-фильтры `today` и `hasFollowUp`.**
`run.ts:255-266` allow-list без `today`, `hasFollowUp`; API принимает (`app.ts:549-552`, D1). Владелец пользуется «На сегодня» (`shell.tsx:482`), агент не может воспроизвести тот же список.
→ Добавить оба флага (kebab `--has-follow-up`). Критерий: `tasks --today true` возвращает тот же набор, что `queryTasks({today:true})`.

**A6 · важно · Нет сохранённого курсора и команды «что изменилось».**
Скилл (`skills/taskindex/SKILL.md:12-16`) требует хранить `since` только после всех страниц и не терять `generation`, но CLI не даёт места хранения; агент в каждой сессии должен сам изобретать файл. `digest --since` без `--generation` → exit 2 (30).
→ `taskindex digest --since last` / `taskindex cursor show|commit SEQ`: файл `<state>/<server>/<agent>/cursor.json` `{generation, seq}`; `commit` — явное подтверждение после чтения всех `more`. При `generation_changed` курсор сбрасывать с сообщением. Критерий: сценарий «digest → дочитать href → commit → следующий digest начинается с сохранённого seq» покрыт тестом.

**A7 · важно · Ответы владельца агенту нечем прочитать первым классом.**
Комментарии — канал отчётов, но обратного канала нет: D5 показывает `activity --actor owner` только заголовки и `lastSeq`; текст видно лишь через `events` и фильтр на клиенте (D6). `digest` (`app.ts:938-1011`) не включает комментарии; `commentSchema` не имеет адресата/упоминаний.
→ Минимум: раздел `comments` в `digest` (комментарии владельца с `since`, с `taskId`, `text`) и CLI `taskindex inbox --since`. Лучше: соглашение об упоминании `@agentId` и фильтр `mentions=agent:ID`. Критерий: после `comment.add` владельца агент одной командой получает текст и id задачи.

**A8 · важно · API-валидация без деталей.**
`app.ts:245-257` (`defaultHook`) и `:259-271` (`ZodError`) возвращают «Проверьте параметры/поля запроса» без `issues`. B12: опечатка `titel` → нет пути ошибки. Агент через прямой HTTP (без CLI) будет гадать. CLI спасает только тем, что валидирует локально.
→ Добавить `issues: [{path, message}]` в оба ответа (сохранив `code: invalid`). Критерий: curl с опечаткой возвращает `issues[0].path == ["payload","title"]`.

**A9 · важно · OpenAPI не пригоден как справочник для LLM.**
Замер по живому `/api/openapi.json`: 970 600 байт, 19 операций, `operationId` 0, `summary` 0, `tags` 0, `examples` 0, `components.securitySchemes` отсутствует, 6847 из 7701 свойств с `description` (89 %); query-параметры `/api/tasks` `limit/cursor/q/project/archived/focus/today/hasFollowUp` без описаний (`app.ts:79-83`, `:544-553`); без ключа — 401. Причина размера: схемы не зарегистрированы как компоненты, каждая вложенная `taskSchema` инлайнится.
→ `taskSchema.openapi('Task')` и т. д. (получим `$ref`), `securitySchemes.bearer` + `security`, `operationId`/`summary`/`tags` на каждом `createRoute`, `.describe()` на `pageQuery` и фильтрах, отдавать `/api/openapi.json` без авторизации (в нём нет данных) и добавить `taskindex openapi`. Критерий: размер < 150 КБ, у каждой операции `operationId` и `summary`, документ читается без ключа.

**A10 · желательно · CLI падает со stack trace при закрытии stdout.**
`run.ts:191` пишет в `process.stdout` без обработчика `error`; `taskindex tasks --all | head -c 50` → «Unhandled 'error' event … EPIPE» (E3, C9). Агент, использующий `| head`/`| jq -c .items[0]`, получит шум вместо результата.
→ `process.stdout.on('error', e => e.code === 'EPIPE' ? process.exit(0) : …)` в `src/cli/index.ts`. Критерий: `tasks --all | head -c 1` завершается тихо.

**A11 · желательно · `events --follow` печатает пустую страницу каждую секунду** (`run.ts:377-393`, E4: 2 строки за 2 с без событий). Для агента-наблюдателя — мусор в контексте. → флаг `--quiet` (печатать только непустые страницы) или интервал `--interval`.

**A12 · желательно · Любой агент отменяет операции другого агента.**
D10: агент scope `tasks` отменил `checklist.add` другого агента; `commands.ts:329-335` ограничивает только чужие комментарии. Это равенство с владельцем по замыслу, но для доверия владельца стоит зафиксировать политику явно (в скилле: «отменяй только своё, чужое — комментарием») либо ограничить undo для агентов своими `operationId`, оставив полный undo владельцу.

**A13 · желательно · Скилл: нет установки, окружения и примеров чтения ответов.**
`SKILL.md:1-4` — frontmatter только `name`/`description` (для Claude Code достаточно; для Codex способ подключения не описан ни в README, ни в BACKLOG — план §3 говорит «симлинк в ~/.claude/skills», README молчит). Нет строки вида `export TASKINDEX_TOKEN=$(op read 'op://…')` или `op run --env-file`; нет примера `task get → --base-revision`; нет `tasks --today` (потому что его нет); есть всё, что реально существует в CLI (проверено построчно: `context`, `digest`, `tasks --all`, `activity --all`, `events --follow --since --generation`, `task sync --payload`, `find-origin`, `-q`, `task get`, `--base-revision`, `comment add`, `task save --payload`, `batch --file`, `--dry-run`, `undo --operation|SEQ`, `operation get|resume`, каталог outbox, коды выхода — совпадают с `run.ts`/`client.ts:24-44`). `tests/e2e/agent-cycle.md` — прозаический чек-лист на 7 шагов, не исполняемый; шаг 5 частично автоматизирован в `tests/cli/agent-cycle.test.ts:52-110` (потеря ответа после commit), шаг 6 — в `tests/cli/cli.test.ts:146-181` (503 held). Шаги 1–4, 7 — ручные.
→ Дописать в скилл: установка (`ln -s … ~/.claude/skills/taskindex`; для Codex — `~/.codex/skills` или ссылка из `AGENTS.md`), окружение через `op`, 5 коротких примеров с ожидаемым JSON (create, get+update, sync, conflict, resume), правило про undo. Превратить `agent-cycle.md` в сценарий `scripts/agent-cycle.mjs` против одноразового окружения (см. B2) с проверкой ожидаемых полей. Критерий: скилл проходит проверку «каждая упомянутая команда/флаг есть в `HELP`» тестом.

**A14 · желательно · `context` не содержит списка агентов и не говорит, кто «я».** `app.ts:867-937`. Атрибуция в событиях полная (`actorId`, `actorLabel`), но агент не знает других операторов. → добавить `agents: [{id,label}]` и `me` в `context`.

**A15 · хорошо (зафиксировать в скилле) · Семантика `task.sync` прозрачна.** E1: после касания владельца ответ `applied:["note","due"]`, `skipped:[{area:locked},{projectId:locked},{title:owner},{status:owner}]`; повтор той же версии → `skipped:"all", reason:"stale"` (E2); `ownerFields`/`ownerTouchedAt` видны в `task get` (D3), так что агент может предсказать отказ до отправки. Конфликт `task.update` даёт `conflicts[].fields` и `current` (D7), непересекающиеся поля сливаются (C5).

### B. Агенты как разработчики

**B1 · блокер · Нет `CLAUDE.md`/`AGENTS.md`, ловушка Node 26.**
Подтверждено: `ls CLAUDE.md AGENTS.md .claude .codex .github` — нет. `.nvmrc` = `24`, `.node-version` = `24.20.0`, `package.json engines >=24.11.0 <25`, но ничто не останавливает запуск под v26 с внятным текстом; падение приходит из `better-sqlite3` при загрузке модуля. Глобальные правила Дмитрия (worktree-only, Fable-сабагенты, лаконичность) в репозитории не продублированы. Содержание — раздел (e).
→ Добавить `CLAUDE.md` (и `AGENTS.md` как симлинк/копию для Codex) + `scripts/preflight.mjs` в `pretest`/`precheck`: проверка `process.versions.node` против `engines` с сообщением «используйте Node 24.20.0: `nvm use`/путь». Критерий: `node26 npm test` завершается за секунду сообщением про версию, а не трассой `better-sqlite3`.

**B2 · блокер · Нет одноразового окружения одной командой.**
`scripts/setup-dev.mjs:8-31` пишет `.env` и `data/dev.db` в текущем чекауте (в worktree — во worktree, но `.env` там нет и он создаётся заново с другим секретом); `tests/e2e/server.ts` поднимает временную БД с владельцем, но без агента/ключа и с Vite. Для проверки CLI мне пришлось вручную собрать цепочку (см. (g)): `admin migrate` → `create-owner` (stdin) → `agent create` ×2 → `agent-key create --out` → сервер с `DATABASE_PATH/PORT/BASE_URL/BETTER_AUTH_SECRET`.
→ `scripts/sandbox.mjs`: mkdtemp, миграции, владелец, агент(ы), ключи, сервер на свободном порту; печатает `export TASKINDEX_URL=… TASKINDEX_TOKEN=… XDG_STATE_HOME=…` и PID; `--stop`. Критерий: `eval "$(node scripts/sandbox.mjs)" && npm run cli -- digest` работает из чистого worktree без `.env`.

**B3 · важно · Добавление команды — 6+ мест без проверки исчерпывающести.**
Схема payload: `src/shared/schemas.ts:91-212`; вручную продублированные union'ы `commandSchema` (`:219-316`) и `commandEnvelopeSchema` (`:317-430`) — 16 записей × 2; исполнение — строковый if/else в `src/shared/commands.ts:268-654` без `default: never`; справка `run.ts:52-61`; подписи UI `activity.tsx:19-38` — `Record<string,string>`, не `Record<CommandName,string>`; скилл; тесты. `grep never` по `src/` — только `fail(): never`. Забытая запись в `commandEnvelopeSchema` → команда валидна локально в CLI (`run.ts:448-451` смотрит `commandPayloadSchemas`), но отклоняется сервером. CLI подхватит новую команду автоматически только если она следует схеме `group.action` (`run.ts:430`).
→ Строить оба union'а циклом из `commandPayloadSchemas`; `labels: Record<CommandName | 'batch', string>`; в `applyCommand` `switch(name)` с `default: assertNever(name)`; тест «HELP содержит все команды». Критерий: добавление ключа в `commandPayloadSchemas` без правки остальных мест ломает `tsc`/`vitest`.

**B4 · важно · Миграция без bump `SCHEMA_VERSION` не ловится.**
`tests/api/migrations.test.ts:11-25` проверяет snapshot ↔ `schema.ts` и журнал ↔ `__taskindex_migrations`, но не связь с `SCHEMA_VERSION` (`src/shared/model.ts:86`). README (раздел «Локальный запуск») требует «вместе с новой миграцией повышается SCHEMA_VERSION» — только словами.
→ Ассерт `SCHEMA_VERSION === journal.entries.length` (сейчас 1 = 1) или явная таблица `{migration → version}`. Критерий: новый `.sql` без bump валит `npm test`.

**B5 · важно · Структура: `src/server/app.ts` 1072 строки, всё в одном `createApp`.**
Маршруты чтения, команды, SSE, `context`, `digest`, `focus`, пагинация, middleware, логирование — один файл. Агенту «где добавить GET» приходится читать целиком; типизированный `hc<AppType>` (`client.ts:49`) зависит от цепочки `.openapi()` — разрезать нужно аккуратно (собирать `app.route()` или сохранять цепочку через функции, возвращающие `OpenAPIHono`).
→ `server/routes/{read,commands,stream,context,digest}.ts` + `server/paging.ts`; `AppType` собирать явно. Критерий: ни один файл в `src/server` > 400 строк, `tsc` и `tests/cli` зелёные (проверяют `hc`).

**B6 · важно · Дрейф документации.**

- `LOG_LEVEL`: объявлен в `deploy/.env.example:7`, `deploy/compose.yml:15`, плане §12 — в `src/` не используется (grep: 0). Агент будет «настраивать» несуществующий уровень логов.
- `HELP` (`run.ts:48,62-73`): `events --since N` без `--generation`; `--json` — мёртвый флаг; `digest` без указания `--since/--generation`.
- README и BACKLOG: «установить скилл в обе среды» / «подробности в скилле» — способа установки нет ни в одном документе (план §3: симлинк `~/.claude/skills`).
- План §10 обещает `--json «по умолчанию, если stdout не терминал»` — реализовано «всегда JSON» (для агентов лучше, но текст устарел).
- `tests/e2e/agent-cycle.md` — назван «приёмкой», но не исполняем; README «Пройти полный агентский цикл» отсылает к прозе.
- Проверено и совпадает: README команды `setup:dev`, `admin create-owner` через stdin, порты 5173/3001, `npm run cli -- --help`, права 0600 на файл ключа; `deploy/README.md` — порт 3100, `stop_grace_period 20s`, Litestream 0.5.12, `taskindex-admin` в образе (`Dockerfile`), `TASKINDEX_FAIL_AT`, `deploy/.runtime`, `quarantine-and-install` с `TASKINDEX_OFFLINE_RESTORE`.

**B7 · желательно · Неиспользуемый код и слабые линты.**
`outbox.ts:144 serverId()` не используется; `tsconfig.json` без `noUnusedLocals`; `.oxlintrc.json` — только `correctness`. Агент не получит сигнала о мёртвом коде. → `noUnusedLocals`, `noUnusedParameters`, категория `suspicious` в oxlint.

**B8 · желательно · Сгенерированные файлы не помечены.**
`drizzle/v2/meta/0000_snapshot.json`, `_journal.json` — без пометки «сгенерировано drizzle-kit, не редактировать»; `docs/reference/**/*-sha256.json`, `docs/audits/**` — артефакты. → короткий `drizzle/v2/README.md` и упоминание в `CLAUDE.md` (do-not-touch список).

**B9 · желательно · Русские `.describe()` и сообщения — не помеха.**
Все текущие модели (Claude, GPT) читают русский свободно; для агента полезнее единообразие: сейчас сервер и справка — по-русски, Zod-ошибки CLI — по-английски (A3). Оставить русский, устранить смешение.

**B10 · важно · Деплой агентом.**
`deploy/deploy.sh:8-41`: требует Linux, чистый чекаут, работающий app, `flock`, проверяет `/health` перед началом — хорошие «отказы в неверном состоянии»; `deploy/rollback.sh:11-21` требует явной авторизации `TASKINDEX_ROLLBACK_AUTHORIZATION=pre-open-writes` и отсутствия файла границы; секреты только через `op run --env-file` (`compose.yml:12-13` `:?` guard, `dc config --quiet`). Недостатки для агента: нет `--dry-run`/`--plan` (печатать намерения: commit, образ, deploymentId, что будет остановлено); `git checkout --detach` меняет чекаут (`deploy.sh:40`) — надо явно предупредить в README; первичная установка — 6 ручных шагов без проверочных команд для TLS/nginx; после `open-writes` откат только руками по README «Восстановление». → `deploy.sh --plan`, вынести первичную установку в `deploy/bootstrap.sh` с теми же guard'ами. Критерий: `--plan` без Docker печатает план и выходит 0.

## (d) Транскрипт живого цикла (сокращённо)

Окружение: временная БД `scratchpad/agent.db`, сервер `node --import tsx src/server/index.ts` на `:3999` (`BUILD=review-loop`), два агента: `claude-review` (scope `write`), `codex-review` (scope `tasks`). Полные логи: `scratchpad/loop-{a,b,c,d,e}.txt`, `server.log`, `openapi.json`.

```
$ taskindex --help
{"usage":"taskindex <command> [--payload JSON | --file file.json] [flags]","reads":[…14],"writes":[…8],"flags":["--json","--dry-run","--operation-id ID","--base-revision N","--generation ID",…],"exitCodes":{…}}   # exit 0
# ⚠ ни флагов чтения (--actor/--group/--system), ни примеров; --json — no-op

$ taskindex context            # 25 406 байт: areas, statuses, projects, JSON-схемы 16 команд, rules, counts, links
$ taskindex digest             # пустая сводка: focus[4], waiting, counts, operations(href)

$ taskindex project create --area agency --name 'Ревью агентов' --color '#3763df' --id review-project
{"ok":true,"operationId":"c6cb…","firstSeq":1,"lastSeq":1,"results":[{"record":{"id":"review-project",…}}]}

$ taskindex task create --area agency --title 'Первая задача через флаги' --project-id review-project --due 2026-09-10 --operation-id op-create-1
{"ok":true,…"createdBy":"agent:claude-review","createdByLabel":"Клод (ревью)",…}

$ taskindex batch --file batch.json --operation-id op-batch-1      # 2 task.create → firstSeq 3, lastSeq 4, одна операция

$ taskindex tasks --today true
{"ok":false,"code":"invalid_arguments","message":"Флаг --today не поддерживается этим запросом"}   # exit 2  ⚠ API поддерживает

$ taskindex task move t-batch-1 --status doing --base-revision 5
{"ok":false,"code":"invalid","message":"Базовая версия из будущего.",…}                            # exit 1

$ taskindex task move t-batch-2 --status doing
{"ok":false,"code":"invalid_arguments","issues":[{"expected":"number","code":"invalid_type","path":["baseRevision"],"message":"Invalid input: expected number, received undefined"}]}   # exit 2 ⚠ английский, без подсказки

$ taskindex task            → {"code":"invalid_arguments","message":"Неизвестная команда: task.undefined"}   ⚠
$ taskindex me              → {"code":"invalid_arguments","message":"Неизвестная команда: me.undefined"}     ⚠

$ taskindex comment add t-batch-1 --text 'Отчёт агента…' --operation-id op-comment-1     # ok, seq 6
$ taskindex comment add t-batch-1 --text 'Отчёт агента…' --operation-id op-comment-1     # повтор → тот же ответ, seq 6 ✓ идемпотентно
$ taskindex comment add t-batch-1 --text 'Другой текст' --operation-id op-comment-1
{"ok":false,"code":"operation_mismatch","message":"Этот operationId уже использован для другого запроса.","retryable":false}   # exit 3 ✓

$ taskindex task sync --origin '{"system":"telegram","ref":"chat1:msg7","version":"1"}' --fields '{…"note":"v1"}'   # создана, originVersion 1
$ … version 2 --fields '{…"note":"v2"}'    # обновлена, revision 2 ✓
$ … version 2 ещё раз                        # {"firstSeq":null,"results":[{"skipped":"all","reason":"stale"}]} ✓ без события
$ … без version                              # skipped all, reason freshness_unknown ✓

$ taskindex undo --operation op-comment-1    # ok: deletedAt проставлен ✓
$ taskindex undo --operation op-batch-1
{"ok":false,"code":"conflict","message":"После операции записи уже менялись.","current":{…"revision":2},"conflicts":[{"entityKind":"task","entityId":"t-batch-1","fields":[…]}]}   # exit 3 ✓ объяснимо

$ taskindex events --since 3
{"code":"invalid_arguments","message":"Для --since после первого события нужен --generation исходного курсора"}   # exit 2 ⚠ справка молчит
$ taskindex digest --since 2      # та же ошибка ⚠ (API /api/digest?since=2 работает без generation)

$ taskindex activity --actor agent:claude-review --limit 3   # включает отклонённую операцию: {"command":"undo","status":409,"ok":false,"errorCode":"conflict",…} ✓

# ---- агент B (scope tasks), тот же XDG_STATE_HOME, что у A ----
$ taskindex project create …     → {"code":"forbidden","message":"У ключа недостаточно прав."}   # exit 4 ✓
(в общий каталог ops положен неотправленный конверт A: comment.add от имени A)
$ taskindex context              # stderr: {"pendingOperations":["leak-op-1"],"next":"taskindex operation get <id> или operation resume <id>"}
$ taskindex operation resume     # ⚠ отправил конверт A под ключом B → ok, actorId "agent:codex-review"
$ curl /api/operations/leak-op-1 → {"actorId":"agent:codex-review","command":"comment.add","ok":true}   # ⚠ ложная атрибуция

$ curl -d '{…"payload":{"area":"agency","titel":"x"}}' /api/commands
{"ok":false,"code":"invalid","message":"Проверьте параметры запроса.","retryable":false}   # ⚠ без issues

# ---- владелец через cookie закрывает задачу telegram (status done, title) ----
$ taskindex task get <tg>  → {"status":"done","title":"Заголовок владельца","ownerTouchedAt":"…","ownerFields":["orderKey","status","title"]}
$ taskindex task sync … version 4 --fields '{"title":…,"note":"v4","status":"todo","projectId":"review-project","due":"2026-09-12"}'
{"applied":["note","due"],"skipped":[{"field":"area","reason":"locked"},{"field":"projectId","reason":"locked"},{"field":"title","reason":"owner"},{"field":"status","reason":"owner"}]}   ✓

# ---- владелец пишет комментарий «Клод, перепроверь сроки» ----
$ taskindex activity --actor owner --limit 5   → [{"command":"comment.add","titles":["Пакетная задача 1 (кодекс)"],"lastSeq":23}]   # текста нет
$ taskindex events --since 14 --generation G | jq '…select(.entityKind=="comment" and .actorId=="owner")'  → [{"seq":23,"taskId":"t-batch-1","text":"Клод, перепроверь сроки"}]   # ⚠ только так

$ [B] taskindex task update t-batch-1 --base-revision 2 --note 'Конфликтная правка'
{"ok":false,"code":"conflict","conflicts":[{"fields":["note"]}],"current":{"revision":6,"note":"Правка кодекса"}}   # exit 3 ✓
$ [B] taskindex task update t-batch-1 --base-revision 3 --title '…'      # другое поле → слито ✓
$ [B] taskindex comment remove <комментарий A> → {"code":"forbidden","message":"Нельзя удалить чужой комментарий."}   # exit 4 ✓
$ [B] taskindex undo 16          # отменил checklist.add агента A → ok (политика?)

$ taskindex tasks --all --limit 1 | head -c 50
{"generation":"95194beb-…                        # stderr: node:events:505 throw er; // Unhandled 'error' event … EPIPE ⚠

server.log: {"requestId":"…","operationId":"owner-closes","command":"task.save","actor":"owner","code":200,"durationMs":2} ✓ (35 записей, 7 с кодом 4xx)
```

Точки трения для LLM (итог): справка без флагов/примеров; обязательный `--generation` при `--since`; английские Zod-ошибки без подсказок; `task.undefined`; нет `me`; нет `--today`; курсор не хранится; ответы владельца видны только через `events`+jq; общий outbox; OpenAPI по ключу и 970 КБ; ошибки API без `issues`; EPIPE при `| head`; шумный `--follow`.

## (e) Что должен содержать `CLAUDE.md` / `AGENTS.md` репозитория

- **Назначение и контекст**: одна доска одного владельца, агенты — основные операторы через CLI/API; ссылки на план `docs/plans/2026-09-08-taskindex-v2.md` (истина по объёму), ревью, `BACKLOG.md`, скилл.
- **Окружение**: строго Node 24.20.0 (`.node-version`); как получить (`nvm use`, путь `/private/tmp/taskindex-v2-tools/…` на этой машине); симптом неверной версии — падение `better-sqlite3`; `npm ci`, не `npm install`.
- **Правило worktree**: любые правки только в `git worktree`; основной чекаут — чтение/ops/деплой; `git worktree list` в конце сессии; коммит — только по слову владельца.
- **Do-not-touch**: `data/`, `.env`, `deploy/.runtime/`, `dist/`, `tsconfig.tsbuildinfo`, применённые миграции `drizzle/v2/*.sql`, `drizzle/v2/meta/*` (генерируется `npm run db:generate`), `docs/reference/**` и `docs/audits/**` (артефакты с sha256), `test-results/`.
- **Гейты**: `npm run check` = `tsc` + `oxlint` + `oxfmt --check` + `vitest` (≈2 с); `npm run e2e` (нужен Chromium Playwright, поднимает `tests/e2e/server.ts` на 4173/4001); `bash deploy/local-drill.sh` (Docker). Запускать `check` перед каждым сообщением о готовности.
- **Карта кода**: `src/shared` (схемы `schemas.ts`, `domain-schemas.ts`; редьюсер `commands.ts`; запросы `queries.ts`; `model.ts` c `SCHEMA_VERSION`), `src/server` (`app.ts` маршруты/SSE/context/digest, `operations.ts` транзакция, `db.ts` миграции/чтение/запись, `auth.ts`, `admin.ts`), `src/cli` (`run.ts` разбор и справка, `client.ts` повторы и коды выхода, `outbox.ts`), `src/web/app` (store/sync/UI), `tests/{unit,api,property,web,cli,e2e}`.
- **Как добавить команду end-to-end**: `schemas.ts` (payload + обе union'ы), `commands.ts` (`applyCommand`, `isSubjectField`, правила undo), при необходимости `db.ts writeState`, `run.ts` (`HELP`, маппинг positional→payload), `activity.tsx labels`, `SKILL.md`, тесты `tests/api/commands.test.ts` + `tests/cli/cli.test.ts` + property.
- **Как добавить миграцию**: правка `src/server/schema.ts` → `npm run db:generate` → проверить SQL → bump `SCHEMA_VERSION` (`model.ts:86`) → `tests/api/migrations.test.ts` → прогон миграции на копии старой базы; применённые миграции не редактировать.
- **Как добавить GET-маршрут**: `createRoute` в `app.ts` с `operationId/summary/.describe()`, схема ответа из `domain-schemas.ts`, пагинация через `page()`, добавить в `HELP.reads` и allow-list `query()` в `run.ts`, скилл.
- **Одноразовое окружение**: `node scripts/sandbox.mjs` (после B2) → `TASKINDEX_URL/TOKEN`; никогда не направлять CLI на рабочий сервер во время разработки.
- **Соглашения**: русский язык сообщений и `.describe()`, JSON-вывод CLI, коды выхода 0/1/2/3/4, `operationId` обязателен и повторяется без изменений, ошибки только через `fail()`/`DomainError`.
- **Деплой**: только с VPS, `op run --env-file … -- bash deploy/deploy.sh COMMIT`; никогда не откатывать после `open-writes` автоматически; `deploy/README.md` — процедуры.
- **Стиль ответов владельцу**: лаконично, результат первой фразой; ошибки и вывод тестов целиком.

## (f) Чек-лист «стать AI-ready» (по влиянию/усилиям)

1. `CLAUDE.md` + `AGENTS.md` по (e); `scripts/preflight.mjs` с проверкой версии Node в `precheck`/`pretest`. _(0.5 дня, снимает B1)_
2. `scripts/sandbox.mjs` — одноразовое окружение с агентским ключом; переписать `tests/e2e/agent-cycle.md` в исполняемый `scripts/agent-cycle.mjs` поверх него. _(1 день, B2/A13)_
3. Разделить состояние CLI по серверу и агенту; `operation resume` только своих; тест с двумя токенами. _(0.5 дня, A1)_
4. Справка из схем: `taskindex help`, `<cmd> --help`, примеры; `taskindex me`; `tasks --today/--has-follow-up`; внятная ошибка для неполной команды; русская локаль Zod + `hint`; обработка EPIPE. _(1–1.5 дня, A2–A5, A10)_
5. `issues` в ответах валидации API; OpenAPI: компоненты `$ref`, `securitySchemes`, `operationId/summary/tags`, описания query, отдача без ключа; `taskindex openapi`. _(1 день, A8–A9)_
6. Курсор: `digest --since last` / `cursor commit`; `digest.comments` + `taskindex inbox`. _(1 день, A6–A7)_
7. Проверки исчерпывающести: union'ы из `commandPayloadSchemas`, `labels: Record<CommandName,…>`, `assertNever`, тест HELP↔схемы↔SKILL, ассерт `SCHEMA_VERSION`↔журнал. _(0.5 дня, B3–B4)_
8. Обновить скилл (установка для Claude Code и Codex, `op`, примеры ответов, политика undo) и README/HELP (убрать `--json`, `LOG_LEVEL`, документировать `--generation`). _(0.5 дня, A13, B6)_
9. Разрезать `app.ts` по маршрутам, `noUnusedLocals`, убрать `serverId`/использовать; пометить сгенерированные файлы. _(1 день, B5, B7, B8)_
10. `deploy.sh --plan`, `deploy/bootstrap.sh`; фильтр по актору в UI «Активности». _(1 день, B10, паритет для владельца)_

## (g) Что запущено и проверено

- `npx tsc --noEmit` под Node 24.20.0 — exit 0 (инкрементально, 1.4 с).
- `npx vitest run` — 14 файлов, 75 тестов, все зелёные, 1.43 с.
- Временный сервер: `DATABASE_PATH=<scratch>/agent.db PORT=3999 BASE_URL=http://localhost:3999 BETTER_AUTH_SECRET=… node --import tsx src/server/index.ts`; база подготовлена `node --import tsx src/cli/admin.ts migrate | create-owner (stdin) | agent create ×2 | agent-key create --out` (файлы ключей 0600 подтверждены). `/health` → `{"ok":true,"schemaVersion":1,"build":"review-loop","writes":"open"}`.
- ≈70 вызовов CLI двумя ключами (write и tasks) и curl-пробы (`/api/me`, неверный ключ → 403, неизвестный маршрут → 404 JSON, опечатка в теле → 400 без `issues`, `/api/tasks?today=1`, `/api/digest?since=` без generation, вход владельца по cookie и его команды).
- Анализ `openapi.json` через `jq` (пути, security, operationId, покрытие `description`, размер).
- Проверка `server.log`: JSON-строки с `requestId/operationId/command/actor/code/durationMs` для каждого `/api/commands*`.
- Сверка README/`deploy/README.md`/`SKILL.md`/`BACKLOG.md`/плана §5–6, §10, §12 с кодом (команды, флаги, порты, переменные, пути).
- Репозиторий не изменён: `git status` без новых файлов, `data/dev.db` и `.env` с прежними mtime; сервер остановлен (`server stopped`).
- Не запускалось по условиям: `oxlint`/`oxfmt`, `npm run build`, `npm run e2e` (Playwright), `deploy/local-drill.sh` (Docker), миграции против `data/`.

## (h) Что проверено и признано хорошим

- **Идемпотентность и восстановление**: `operationId` генерируется CLI (`run.ts:406`), конверт пишется до отправки атомарным `link()` без перезаписи (`outbox.ts:100-132`), 4 попытки с экспоненциальной паузой (`client.ts:132-137`), удаляется только при `ok` или `retryable:false`; повтор того же конверта возвращает сохранённый ответ, другой payload с тем же id → `operation_mismatch` (409/exit 3); токен не попадает в outbox и логи (проверяется `tests/cli/agent-cycle.test.ts:107`).
- **Семантика `task.sync`** реализована на сервере, ответ объясняет каждое поле (`applied`/`skipped[{field,reason}]`, `reason: stale|freshness_unknown|version_incomparable`); `ownerFields`/`ownerTouchedAt` доступны для чтения заранее.
- **Конфликты**: `conflicts[].fields` + `current`, слияние непересекающихся правок (`commands.ts:125-153`), `baseRevision` из будущего → `invalid`.
- **Права**: scope `read/tasks/write` проверяется в `commands.ts:65-68`; чужой комментарий не удалить; `operationId` привязан к актору (`operations.ts:65-70`).
- **Атрибуция и наблюдаемость владельца**: `actorId/actorLabel` в каждом событии и операции, `createdBy/createdByLabel` в задаче, группа Focus «Новое от агентов», отклонённые операции сохраняются и видны в `activity` с `errorCode`, undo целой операции и отдельного события, структурированный лог сервера с `operationId`.
- **Единый конверт ошибок** `{ok:false, code, message, retryable}` для API и CLI; коды выхода стабильны и задокументированы.
- **Батчи атомарны**, `--dry-run` возвращает результат без событий, `generation` проверяется в каждом запросе, курсоры пагинации содержат `generation`+`seq`+fingerprint.
- **Тесты**: быстрые, детерминированные (фиксированное `now`), покрывают потерю ответа после commit, 503 при held, миграции против drizzle-snapshot, property-тесты undo.
- **Типы** выводятся из Zod (`model.ts:41-60`), дрейф схема↔тип невозможен; `strict` TS.
- **Деплой**: guard'ы на состояние, `flock`, явная авторизация отката, граница `open-writes` фиксируется до вызова, секреты только через `op run`, health/replica проверки, Litestream закреплён по версии.
- **Гигиена секретов**: пароль владельца только через stdin/`op://`, ключ агента — файл 0600, `.gitignore` закрывает `.env`, `*.db`, `data/`.
