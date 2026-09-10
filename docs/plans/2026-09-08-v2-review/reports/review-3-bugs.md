# TaskIndex v2 — обзор корректности (баги, безопасность), 2026-09-08

Проверялось незакоммиченное дерево `/Users/dmitriy/code/taskindex` (main, только чтение). Node 24.20.0. Все проверки — на временных/`:memory:` базах; `data/dev.db` и `.env` не трогались. Критичных и высоких дефектов не найдено: ядро (транзакции, идемпотентность, SSE, CSRF, скоупы, миграции, деплой) сходится. Найдены 12 реальных проблем средней и низкой тяжести, все подтверждены кодом и/или repro-скриптами.

---

## Находки

### B-01 · средняя · CONFIRMED — агент со scope `tasks` отменяет решения владельца через `undo`

**Где:** `src/shared/commands.ts:65-68` (`requireScope`), `:329` (вызов в `undo`), `:444` (для комментариев есть проверка автора, для задач — нет).

**Что не так.** `requireScope(actor, kind)` проверяет только scope ключа и вид сущности. Для `undo` над задачей нет проверки, чей была отменяемая операция. Правило из `/api/context` («Undo сохраняет … ручные решения», `app.ts:902`) и модель продукта («владелец проверяет работу агентов и отменяет ошибки», план §роли) не выполняются в обратную сторону: агент отменяет ручные решения владельца.

**Сценарий.** Владелец архивирует задачу (`task.archive`, `ownerFields` получает `archived`). Агент с ключом `tasks` шлёт `undo {operationId: <op владельца>}` → 200, задача возвращается из архива. Аналогично: агент отменяет `task.move done`, правку названия, `task.restore` владельца.

**Проверка.** `scratchpad/repro/agent-undo-owner.mts`:

```
agent(tasks) undo of owner archive -> 200 {"ok":true}
task archived after agent undo: false ownerFields: ["archived",...] ownerTouchedAt: 2026-09-08T12:00:00.000Z
```

Тест `enforces scopes on commands and the net effects of undo` (`tests/api/commands.test.ts:250`) проверяет только запрет `project.*`-undo для `tasks`; случай «агент отменяет владельца» тестами не покрыт.

**Исправление.** В ветке `undo` (`commands.ts:294-363`) для `ctx.actor.kind !== 'owner'` запрещать группы, где `events.some(e => e.actorId === 'owner')` (или как минимум если `keys` пересекаются с `record.ownerFields`), с кодом `forbidden`. Добавить тест.

---

### B-02 · средняя · CONFIRMED — агент ставит `focus: true` и попадает в «Выбрано мной», минуя «Новое от агентов»

**Где:** `src/shared/schemas.ts:82` (`focus` описан как «Выбрано владельцем в Focus», но разрешён во всех командах), `:85-90` (`createFields` для `task.sync`/`task.create`), `src/shared/commands.ts:561-573` (для sync `focus` блокируется только при `ownerTouchedAt`), `src/shared/queries.ts:73-75` (группа `selected` имеет приоритет над `new`).

**Сценарий.** Агент делает `task.sync {fields: {area, title, focus: true}}` (или `task.create`/`task.update` с `focus: true`) для задачи, которую владелец не трогал → задача сразу в группе `selected` («Выбрано мной»), а не в `new`. Список «выбранного владельцем» становится недостоверным; агент может «протолкнуть» свои задачи в личный шорт-лист владельца. Digest/`counts.focus` тоже искажаются.

**Проверка.** Тот же скрипт:

```
agent-synced focus:true task lands in group: selected | createdBy agent:test-agent ownerTouchedAt null
agent task.update focus:true -> 200 true
```

**Исправление.** Для `ctx.actor.kind === 'agent'` игнорировать/отклонять `focus` во всех task-командах (в sync — всегда `skipped: {field:'focus', reason:'owner'}` независимо от `ownerTouchedAt`), либо убрать `focus` из `taskFieldsSchema` для агентов через отдельную схему.

---

### B-03 · средняя · CONFIRMED — стоимость каждой команды и ленты операций растёт линейно от размера журнала

**Где:**

- `src/server/operations.ts:93-95` — на каждую команду `readState(db)` (все задачи, чеклисты, комментарии) и `readEvents(db)` (весь журнал событий с JSON-парсингом `changes`), хотя `assertMerge`/`undo` нужны события только одной сущности (индекс `events_entity_revision` есть, не используется).
- `src/server/db.ts:235-273` — `readOperations` читает все операции и делает до 3 SELECT на каждую (заголовки); используется в `/api/operations` (`app.ts:713`), `/api/operations/{id}` (`app.ts:736` — полный скан ради одной записи), `/api/digest` (`app.ts:962`), `/api/export`.
- `src/server/app.ts:679` — `/api/tasks/{id}/history` читает весь журнал и фильтрует в JS.
- `src/web/app/activity.tsx:138-179` — лента перезагружает все открытые страницы при каждом изменении `seq` (то есть при каждом событии в пространстве).

**Измерение** (`scratchpad/repro/perf.mts`, `:memory:`, 2 010 задач / 4 010 событий / 4 010 операций):

```
task.create @ ~0 events: 3.3 ms/op
task.create @ 4k events: 35.7 ms/op
task.update @ 4k events: 37.9 ms/op
GET /api/operations?limit=50: 95.2 ms/op
GET /api/operations/{id} (single): 88.0 ms/op
GET /api/tasks/{id}/history: 14.5 ms/op
GET /api/digest: 108.1 ms/op
```

Рост ×11 на команду уже при 4k событий. При активных агентах (десятки тысяч операций за год) — сотни миллисекунд на каждую команду, около секунды на страницу ленты, при этом открытая «Активность» дергает это на каждое событие. Сервер синхронный (better-sqlite3): в это время не обслуживаются другие запросы и heartbeat SSE.

**Исправление.** В `executeOperation` грузить события только по затронутым сущностям (`WHERE entity_kind=? AND entity_id=?`), для `undo` — по `operation_id`/`seq`. `readOperations`: пагинация в SQL (`ORDER BY created_at DESC LIMIT/OFFSET` или keyset), заголовки — одним JOIN по `events`. `/api/operations/{id}` — прямой `WHERE id=?`. История задачи — запрос по индексу.

---

### B-04 · средняя · CONFIRMED — операция из прежнего поколения базы «зависает» в панели навсегда и без возможности убрать

**Где:** `src/web/app/store.ts:379-420` (`recover`), `:409` (`continue` без `finish`), `:327-339` (`retry` отклоняет), `src/web/app/shell.tsx:531-555` (кнопка «Повторить» `disabled`, других действий нет).

**Сценарий.** В момент восстановления базы (новое `generation`) в localStorage лежит `taskindex/ops/<id>` незавершённой операции. После перезагрузки `recover()` добавляет её в `pending` со статусом `unknown`, пропускает (`generation` не совпадает) и никогда не вызывает `finish()` → запись остаётся в localStorage, при каждой загрузке снова появляется баннер «Изменение от прежней версии базы. Перенесите текст вручную», кнопка недоступна, API для удаления нет (`finish` приватный). Превью команды при этом не применяется (`publish`, `:79`), так что «перенести текст» пользователь может только вручную из DevTools.

**Проверка.** `scratchpad/repro/store-foreign-pending.mts`:

```
pending after refresh: [{"id":"op-old","gen":"OLD-GEN","status":"unknown"}]
storage still has op: true
retry rejected: Операция относится к прежней версии базы. Перенесите текст вручную.
pending after 2nd reload: 1 | any API to dismiss? finish is private: function
```

**Исправление.** Публичный `dismiss(id)` → `finish(id)`; в баннере показать содержимое конверта (title/note) и кнопку «Убрать»; либо автоматически переносить такие конверты в черновики и удалять из `taskindex/ops/*`.

---

### B-05 · средняя · CONFIRMED — один посторонний/битый файл в outbox ломает все команды CLI, включая чтение

**Где:** `src/cli/outbox.ts:83-98` (`list` → `get` → `path` бросает `ArgumentError` при неподходящем имени; `JSON.parse` бросает `SyntaxError`; оба не перехвачены), `src/cli/run.ts:212` (`outbox.list` вызывается безусловно до любой команды).

**Сценарий.** В `~/.local/state/taskindex/ops/` появляется `bad name.json` (или валидно названный файл с обрезанным JSON — например после сбоя диска/ручного редактирования; атомарная запись через `link` защищает только собственные записи CLI). Любой запуск `taskindex context`, `tasks`, `task create …` завершается `{"ok":false,"code":"client_error"/"invalid_arguments",…}` с кодом 1/2. Агент теряет доступ к API целиком, пока кто-то не удалит файл вручную; диагностика не указывает на файл.

**Проверка.** `scratchpad/repro/outbox-stray.mts`, `outbox-stray2.mts`:

```
list threw: ArgumentError operationId: недопустимый идентификатор
list threw (corrupt json): SyntaxError Expected property name or '}' in JSON at position 1
```

**Исправление.** В `list()` перехватывать ошибки по каждому файлу, пропускать (или переименовывать в `*.corrupt`) и печатать предупреждение в stderr; имена фильтровать регуляркой до вызова `get`.

---

### B-06 · низкая · CONFIRMED — при дублировании имени проекта в `current` возвращается отклонённая запись, а не существующий проект

**Где:** `src/shared/commands.ts:183-188` (`assertInvariants`: новый проект добавлен в конец `state.projects`, при итерации `names.has(name)` срабатывает на нём → `current: p` = новая запись), потребитель — `src/web/app/dialogs.tsx:283-284, 351-384` (диалог показывает `conflict.name`/`description`/`color` как «Актуальная версия» и предлагает «Совместить»).

**Сценарий.** Есть проект «Маркетинг» (`p-first`). Владелец создаёт « маркетинг » → 409 `conflict`, `current.id = p-second` (собственный ввод). Диалог показывает пользователю его же данные как «актуальную версию» и после «Совместить и проверить» отправляет `project.update` по несуществующему `id` (`base = conflict`, `revision: 0` → снова create → снова conflict). Для агента через API `current` также бесполезен.

**Проверка.** `scratchpad/repro/name-conflict-current.mts`:

```
status 409 code conflict current.id = p-second (existing is p-first)
```

**Исправление.** Хранить `Map<nameKey, Project>` и возвращать в `current` ранее встреченный проект; для `task` в аналогичных проверках (`:197`, `:212`) — тоже первую (существующую) запись.

---

### B-07 · низкая · CONFIRMED — без Web Locks каждый вход создаёт новый набор черновиков и копирует все старые; наборы не удаляются

**Где:** `src/web/app/drafts.ts:121-134` (`claim` → `false`, если `navigator.locks` нет), `:144-169` (всегда новый scope + копия из `previous`/`choices[0]`), `clear` (`:57-72`) чистит только текущий scope. Старые scope не собираются никогда (и при наличии locks — scope закрытых вкладок остаются, но тогда рост ограничен числом вкладок).

**Сценарий.** Приложение открыто не в secure context (например `http://192.168.x.x:3001` напрямую на Node-порт — `index.ts:39` слушает `0.0.0.0`) → `navigator.locks` отсутствует → каждая перезагрузка удваивает ключи `taskindex/drafts/*`.

**Проверка.** `scratchpad/repro/drafts-scope.mts` (fake storage, `navigator = {}`):

```
after load #1: scopes=1 draftKeys=3
after load #2: scopes=2 draftKeys=6
…
after load #5: scopes=5 draftKeys=15
```

**Исправление.** Без locks — переиспользовать `previous` из sessionStorage без копии; ввести GC: при инициализации удалять scope, у которых `draft-scope/<id>` старше N дней и которые не удалось claim'нуть… точнее, которые не заняты (`claim` успешен → освободить и удалить).

---

### B-08 · низкая · CONFIRMED — кнопка «Назад» браузера не меняет вид

**Где:** `src/web/app/url.ts:27-34` (`read()` при пустом `location.search` берёт состояние из `localStorage['taskindex/location']`), `:55` (`popstate` → `read()`), `:70-75` (`update()` каждый раз перезаписывает этот же ключ текущим состоянием).

**Сценарий.** Открыть `/` → вид из localStorage (например `area=agency`). Кликнуть «Разработка» → `pushState('?area=development…')`, localStorage ← `area=development`. Нажать «Назад» → URL становится `/` без query → `read()` → fallback на localStorage → снова `development`. Адрес поменялся, экран — нет. То же для любого возврата к первой записи истории.

**Исправление.** Fallback на localStorage использовать только в инициализаторе `useState(read)`, а в обработчике `popstate` читать строго `location.search` (пустой → `defaults`).

---

### B-09 · низкая · CONFIRMED — постраничное чтение обрывается 409 при любой записи в базу; CLI `--all` не восстанавливается

**Где:** `src/server/app.ts:220-221` (`cursor.seq !== latestSeq(db) || fingerprint` → `conflict`), `src/cli/run.ts:394-401` (`--all` просто идёт по `nextCursor`; 409 → exit 3), `src/web/app/activity.tsx:180-199`, `:407-427` («Показать ещё»/«Ещё комментарии» получают тот же 409 и показывают ошибку).

**Сценарий.** Агент читает `taskindex tasks --all` (несколько страниц по 500), параллельно другой агент делает любую команду → вторая страница отвечает `409 "Данные изменились. Начните чтение страниц заново."` → CLI завершается кодом 3 без повтора; агент трактует как конфликт. В UI — ошибка под лентой. Это осознанный «замороженный» дизайн курсора, но без повторной попытки на клиенте он делает чтение больших списков на живой доске ненадёжным.

**Исправление.** В CLI при 409 `conflict` на курсоре перезапускать обход с первой страницы (ограниченное число раз); в UI — автоматически перечитывать с начала до достигнутой глубины (как уже делает `Activity` при смене `version`, но не в `more()`).

---

### B-10 · низкая · CONFIRMED — `/health` доступен из интернета без авторизации и раскрывает build/generation/seq; нет security-заголовков

**Где:** `deploy/nginx/taskindex.conf:37` (`location /` проксирует всё, включая `/health`), `src/server/app.ts:390-425` (маршрут вне `/api/*`, без auth; отдаёт `generation`, `seq`, `build` = commit SHA, `writes`), заголовков `Strict-Transport-Security`/`X-Content-Type-Options`/`X-Frame-Options` нет ни в nginx, ни в приложении.

**Сценарий.** Любой внешний клиент видит текущий коммит, поколение базы и счётчик событий (сколько операций и когда происходят — по разнице `seq`). Скрипты деплоя ходят на `127.0.0.1:3100/health` напрямую (`deploy.sh:34,84,98`, `common.sh:34`), Docker healthcheck — внутри контейнера, поэтому публичность не нужна.

**Исправление.** `location = /health { allow 127.0.0.1; allow ::1; deny all; proxy_pass …; }`; добавить `add_header Strict-Transport-Security "max-age=31536000" always;`, `X-Content-Type-Options nosniff`, `X-Frame-Options DENY` (или CSP `frame-ancestors 'none'`).

---

### B-11 · низкая · CONFIRMED — SSE-переподключение с давним курсором отдаёт весь хвост журнала одним синхронным пакетом

**Где:** `src/server/app.ts:851` (`send(readEvents(db, since))` без лимита; для сравнения `/api/events` ограничен 500, `:519,527`), `:810-823` (`desiredSize` проверяется только после enqueue всего массива).

**Сценарий.** Вкладка была закрыта/в фоне неделю (или `Last-Event-ID` очень старый), за это время агенты сделали десятки тысяч событий → при коннекте сервер синхронно читает и сериализует весь хвост в память стрима (блокировка event loop, всплеск памяти на каждого такого клиента), только потом срабатывает backpressure.

**Исправление.** Отдавать хвост порциями (по 500, `readEvents(db, since, 501)` в цикле с проверкой `desiredSize`), либо при хвосте больше N событий сразу посылать `event: reset` — клиент возьмёт снимок.

---

### B-12 · низкая · PLAUSIBLE — dev-сервер слушает `0.0.0.0` с реальными cookie-сессиями по HTTP

**Где:** `src/server/index.ts:39` (`hostname: '0.0.0.0'` и в dev, и в prod), `scripts/dev.mjs` (BASE_URL `http://localhost:5173`).

**Сценарий.** `npm run dev` на ноутбуке в общей сети: API с личными данными (`data/dev.db`) и аутентификацией доступен по `http://<LAN-IP>:3001` без TLS; Origin-проверка защищает только мутации из браузера. Для контейнера `0.0.0.0` нужен, для dev — нет. Не воспроизводилось сетевым запросом (только код), поэтому PLAUSIBLE.

**Исправление.** `hostname: production ? '0.0.0.0' : '127.0.0.1'` (или `HOST` из окружения).

---

## Сводная таблица

| ID   | Тяжесть | Статус    | Слой           | Суть                                                                           | Файл                                                                  |
| ---- | ------- | --------- | -------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| B-01 | средняя | CONFIRMED | shared         | агент отменяет операции владельца через `undo`                                 | `commands.ts:65,329`                                                  |
| B-02 | средняя | CONFIRMED | shared         | агент ставит `focus` → «Выбрано мной»                                          | `schemas.ts:82`, `commands.ts:561`, `queries.ts:73`                   |
| B-03 | средняя | CONFIRMED | server/web     | O(N) на команду и на страницу ленты, ×11 уже при 4k событий                    | `operations.ts:93`, `db.ts:235`, `app.ts:679,736`, `activity.tsx:138` |
| B-04 | средняя | CONFIRMED | web            | операция прежнего поколения висит навсегда без удаления                        | `store.ts:379-420`, `shell.tsx:531`                                   |
| B-05 | средняя | CONFIRMED | cli            | посторонний/битый файл в outbox ломает все команды CLI                         | `outbox.ts:83`, `run.ts:212`                                          |
| B-06 | низкая  | CONFIRMED | shared/web     | `current` при дубле имени проекта — отклонённая запись                         | `commands.ts:183`, `dialogs.tsx:351`                                  |
| B-07 | низкая  | CONFIRMED | web            | рост localStorage: новые scope черновиков без GC (без Web Locks — каждый вход) | `drafts.ts:121-169`                                                   |
| B-08 | низкая  | CONFIRMED | web            | «Назад» не меняет вид из-за fallback на localStorage                           | `url.ts:27,55,70`                                                     |
| B-09 | низкая  | CONFIRMED | server/cli/web | 409 на курсоре при любой записи; `--all` и «Ещё» не повторяют                  | `app.ts:220`, `run.ts:394`, `activity.tsx:180`                        |
| B-10 | низкая  | CONFIRMED | deploy         | `/health` публичен, нет security-заголовков                                    | `nginx/taskindex.conf:37`, `app.ts:390`                               |
| B-11 | низкая  | CONFIRMED | server         | SSE отдаёт неограниченный хвост синхронно                                      | `app.ts:851`                                                          |
| B-12 | низкая  | PLAUSIBLE | server         | dev слушает `0.0.0.0`                                                          | `index.ts:39`                                                         |

Регрессий по исправлениям B01–B06 предыдущего аудита не найдено: логика владения черновиками по scope (B01), явная очистка (B02), подписка обеих форм (B03), `base`/`conflict` в диалоге проекта (B04), отдельная раскладка футера (B05), SSE-подсказка `operations` без смены курсора (B06) — согласованы с кодом и подтверждены 18/18 E2E.

---

## Выполненные команды и результаты (дословно)

Окружение: `export PATH=/private/tmp/taskindex-v2-tools/node-v24.20.0-darwin-arm64/bin:$PATH`, `node --version` → `v24.20.0`.

```
=== TSC ===            npx tsc --noEmit                       → tsc exit=0 (без вывода)
=== LINT ===           npm run lint                           → lint exit=0 (без замечаний)
=== FORMAT ===         npm run format:check                   → "All matched files use the correct format. Finished in 105ms on 88 files using 14 threads." exit=0
=== VITEST ===         npx vitest run --reporter=verbose      → Test Files 14 passed (14); Tests 75 passed (75); Duration 2.23s; exit=0
=== E2E ===            npm run e2e (tests/e2e/playwright.config.ts; временная БД в mkdtemp, порты 4173/4001)
                                                              → 18 passed (32.5s); e2e exit=0
```

(полные логи: `scratchpad/check-static.log`, `scratchpad/vitest.log`, `scratchpad/e2e.log`).

Repro-скрипты (`scratchpad/repro/*.mts`, запуск `node --import <repo>/node_modules/tsx/dist/loader.mjs …`, cwd = корень репозитория, БД `:memory:`/файлы в scratchpad):

| Скрипт                                     | Вывод                                                                                                                                                                                                    | Вывод                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `agent-undo-owner.mts`                     | `agent(tasks) undo of owner archive -> 200 {"ok":true}` · `task archived after agent undo: false` · `agent-synced focus:true task lands in group: selected` · `agent task.update focus:true -> 200 true` | B-01, B-02                                |
| `perf.mts`                                 | см. B-03 (3.3 → 35.7 ms/op; `/api/operations` 95 ms; digest 108 ms)                                                                                                                                      | B-03                                      |
| `store-foreign-pending.mts`                | `pending after refresh: [{"id":"op-old","gen":"OLD-GEN","status":"unknown"}]` · `retry rejected: …` · `pending after 2nd reload: 1`                                                                      | B-04                                      |
| `outbox-stray.mts`, `outbox-stray2.mts`    | `list threw: ArgumentError operationId: недопустимый идентификатор` · `list threw (corrupt json): SyntaxError …`                                                                                         | B-05                                      |
| `name-conflict-current.mts`                | `status 409 code conflict current.id = p-second (existing is p-first)` · `/api/events since>latest -> 200 {…"latestSeq":1,"more":false,"events":[]}`                                                     | B-06                                      |
| `drafts-scope.mts` (без `navigator.locks`) | `after load #1: scopes=1 draftKeys=3` … `after load #5: scopes=5 draftKeys=15`                                                                                                                           | B-07                                      |
| `hono-use.mts`                             | `["mw-commands:/api/commands","mw-batch:/api/commands/batch"]` — `app.use('/api/commands')` не матчит `/api/commands/batch`; лимиты тел не пересекаются                                                  | гипотеза снята                            |
| `health-write2.mts`                        | `after 20 /health: {"busy":0,"log":47,"checkpointed":47}`; `data_version` соседнего соединения не меняется → `UPDATE settings SET value=value` не порождает коммита/кадров WAL                           | гипотеза «запись на каждый /health» снята |

---

## Проверено — проблем не найдено

- **Атомарность операций** (`operations.ts:51-198`): одна синхронная `db.transaction(...).immediate()`, внутри нет `await`; запись состояния, событий и записи операции — в одной транзакции; отклонение (DomainError) сохраняется как операция в той же транзакции, `unavailable`/`dryRun` — не сохраняются; `generation_changed`/`forbidden`/`operation_mismatch` бросаются до записи. `seq = MAX+1` под immediate-блокировкой; UNIQUE/FK-коллизии предотвращены `assertInvariants` до записи; placeholder'ы `~id`/`_×61+id` в `writeState` не пересекаются с реальными ключами.
- **Идемпотентность**: канонический sha256 конверта после Zod-парсинга; тот же id с другим payload → 409 `operation_mismatch`; чужой actor → 403; повтор возвращает сохранённый статус/тело без повторной SSE-подсказки.
- **Поколение/восстановление**: `markRestored` ротирует generation и снимает `approved_deployment`; `importWorkspace` валидирует полный replay журнала и сбрасывает `sqlite_sequence`; удаление owner/ключей при `import --replace` задокументировано (`deploy/README.md:153`).
- **PRAGMA** на каждое соединение (`db.ts:21-24`), `synchronous=FULL` подтверждён тестом `durability.test.ts`.
- **SSE** (`app.ts:752-866`): `Last-Event-ID` `gen:seq` парсится по последнему `:`; чужое поколение → `event: reset` + close (клиент закрывает EventSource и берёт снимок, `sync.ts:30-35`); heartbeat 25 s < `proxy_read_timeout 1h`, `proxy_buffering off` + `X-Accel-Buffering: no`; @hono/node-server 2.1.1 вызывает `reader.cancel()` при закрытии сокета (`dist/index.mjs:758-766`) → `cleanup()` снимает подписчиков и таймер; `closeStreams()` при SIGTERM; backpressure по `desiredSize`.
- **Снимок и курсоры**: `/api/snapshot` и `/api/digest` — в транзакции; `/api/events` читает два стейтмента без транзакции, но в одном потоке без `await` между ними, а потребители (`store.catchUp`, CLI `--follow`) используют `events[last].seq`, не `latestSeq` — расхождение не влияет.
- **Auth/CSRF/скоупы**: владелец — только сессия `user.id === 'owner'`; `disableSignUp: true`, passkey-регистрация требует сессии; Origin-проверка для всех не-GET владельца на `/api/*` (`app.ts:313-318`), Better Auth проверяет Origin для `/api/auth/*`; ключи хешируются плагином, привязка к агенту и scope — по собственным колонкам, отзыв/отключение агента проверяются на каждом запросе; `read` не пишет, `tasks` не трогает проекты (прямые команды); `/api/openapi.json` под auth; email при входе нормализуется Better Auth (`sign-in.mjs:315`).
- **Admin CLI**: пароль только из stdin/`op read`, один `\n` срезается; файл ключа `0600` + `wx`, при ошибке записи ключ отзывается; секреты не печатаются; `DATABASE_PATH` обязателен, база не создаётся молча.
- **Домен**: `byOrder` — бинарное сравнение (совместимо с `fractional-indexing`), `COLLATE BINARY` в схеме; `order()` корректен для пустой колонки, before/after, переноса между колонками (dnd → `task.move`, `board.tsx:63-80`); `applyEvent` совпадает с записью сервера (property-тест + трассировка `emit`/`applyEvent`, `commentCount`, `updatedAt = at`); `task.sync` дедуп строго по `(system, ref)` как и UNIQUE в БД; undo складывает A→B→C, учитывает поздние правки по сущности и занятость слота orderKey; `dateSchema` — календарная дата без TZ, `today` — в Europe/Moscow через Intl.
- **Web**: `useSyncExternalStore` получает стабильный объект `state`; pending-очередь с тем же `operationId` при повторе; gap detection + `catchUp` с постраничным добором; XSS-поверхности нет (`innerHTML`/`dangerouslySetInnerHTML` отсутствуют, `originUrl` валидирован как http(s) на сервере и рендерится с `rel="noreferrer"`); `beforeunload` при dirty; чеклист/даты — контролируемые инпуты.
- **CLI**: outbox — временный файл + `link` (без перезаписи чужого конверта) + fsync каталога; повтор строго с тем же конвертом; 409/403 — терминальные, 5xx/сеть — `status: 'unknown'`; токен только в `Authorization` к тому же origin, `redirect: 'error'`; `--follow` идёт по `events.at(-1).seq`.
- **Деплой**: `set -Eeuo pipefail`, `umask 077`, `flock`; бэкап делается при остановленных app и litestream с подтверждённым `sync -wait`; rollback только до `open-writes` и только при отсутствии boundary-файла и других контейнеров на volume; новый sibling-prefix реплики после восстановления; `held` переживает рестарт через `approved_deployment`; Dockerfile — multi-stage на одном glibc-базе, `USER node`, tini, `drizzle/v2` и `database.mjs` скопированы; `compose.yml` — порт только на 127.0.0.1, healthcheck, `stop_grace_period` ≥ `shutdown-sync-timeout`; nginx — `X-Real-IP` перезаписывается на всех location (наследование `proxy_set_header` корректно).
- **Миграции**: `0000_taskindex.sql` соответствует `schema.ts` (тест `migrations.test.ts`), защита от более новой схемы и неизвестных миграций (`db.ts:61-76`).
- **Тесты**: тавтологических assert'ов не найдено; `toBeDefined()` используется по делу (наличие конверта в outbox). Не покрыто тестами: агентский `undo` операций владельца (B-01), агентский `focus` (B-02), масштабирование (B-03), поведение outbox с посторонними файлами (B-05).
