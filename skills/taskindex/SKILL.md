---
name: taskindex
description: 'Вести задачи, проекты и отчёты TaskIndex через CLI: читать контекст, создавать из источников, обновлять, перемещать и отменять операции без дублей и потери ручных решений.'
---

TaskIndex — доска владельца, которую преимущественно ведут агенты. CLI `taskindex`
работает через `TASKINDEX_URL` и `TASKINDEX_TOKEN`; секрет подставляется из 1Password
через `op`, не включается в сообщения, файлы поручения или командные аргументы.
Команды выводят JSON; актуальные схемы и правила находятся в `taskindex context`.

## Установка и окружение

Claude Code: `ln -s "$(pwd)/skills/taskindex" ~/.claude/skills/taskindex` из корня
репозитория (или копия каталога). Codex: `AGENTS.md` репозитория ссылается на этот
файл, текст скилла вставляется в поручение. `TASKINDEX_URL=https://<домен>`,
`TASKINDEX_TOKEN` только через 1Password:
`op run --env-file=~/.config/taskindex/agent.env -- taskindex digest`, где в файле
`TASKINDEX_TOKEN=op://Vault/TaskIndex agent claude/credential`; либо
`export TASKINDEX_TOKEN=$(op read 'op://…')` в начале сессии. Проверка установки:
`taskindex help` печатает обзор, `taskindex me` — актора ключа (`id`, `label`,
`scope`) без секрета. Для проверок без рабочего сервера — sandbox из `CLAUDE.md`.

Справка строится из спецификации команд и схем payload: `taskindex help`,
`taskindex help <group>`, `taskindex help <group> <action>` или `<команда> --help`
печатают `usage`, флаги с типами и обязательностью, пример, коды выхода и коды
ошибок. Неполная команда (`taskindex task`) перечисляет действия группы; неизвестный
флаг называет команду и её справку. Флага --json больше нет: вывод всегда JSON.

## Чтение

Начни с `taskindex context` для модели и описаний проектов и `taskindex digest` для
текущего состояния. Снапшот нужен только для полного обзора; полный согласованный
список даёт только `taskindex snapshot` (`/api/snapshot`). Если часть digest
содержит `more`, дочитай её по указанным `href`/`nextCursor`; новый `since` сохраняй
только после всех страниц операций. `tasks --all` и `activity --all` выводят каждую
страницу отдельной JSON-строкой после полного прохода; при `409 conflict` на
курсоре страниц (список изменился между страницами) CLI повторяет обход сам, до
трёх раз (stderr `restart`), а разные `seq` первой и последней страницы помечает
stderr `list_changed_during_walk`. При ручном обходе по `nextCursor` после `409`
начни с первой страницы. `tasks --today true` повторяет выборку «На сегодня»
владельца, `tasks --has-follow-up true|false` — задачи с датой возврата или без.

Позиция чтения хранится в `cursor.json` рядом с очередью конвертов, отдельно для
каждого сервера и агента: `taskindex cursor show|commit SEQ|reset`.
`digest|activity|inbox|events --since last` читают от сохранённой позиции (без
курсора — с нуля под текущим поколением), `--commit` записывает `seq`,
`operationSeq` и `generation` ответа только после дочитывания всех страниц
(`more: false`); неполный обход курсор не двигает (stderr
`cursor_not_committed`). Числовой `--since N` при `N > 0` требует `--generation`
исходного курсора. В курсоре две независимые позиции одного поколения: `seq` по
событиям и `operationSeq` по журналу операций; коммит, знающий только одну,
сохраняет другую. `activity --since last` идёт по журналу (`after=operationSeq`,
по возрастанию), поэтому показывает и отказы, и операции без изменений; то же
окно у `digest --since-op N`. Окно по событиям (`--since`) их не содержит.
Входящие для агента — `taskindex inbox`: комментарии владельца после `since` с
текстом, задачей и `seq` (одна строка JSON: `comments`, `generation`, `seq`,
`more`, `href`); продолжение — `inbox --since <seq последнего показанного>` или
`--commit`. `events --follow --since last` читает изменения опросом и
печатает только страницы с событиями (пустые страницы не выводятся, ошибки
выводятся всегда); интервал `--interval MS`, по умолчанию 1000, минимум 250.
Не теряй поколение, которому принадлежит курсор: `generation_changed` означает,
что база восстановлена — `taskindex cursor reset`, свежий `digest` и новая оценка
действия. Отзыв ключа завершает `/api/events/stream` событием `revoked`: не
переподключайся в цикле, запроси новый ключ у владельца.

## Задачи из источников

Для задачи из Telegram, Hub или другого источника используй `task sync`:

```sh
taskindex task sync --payload '{"origin":{"system":"telegram","ref":"chat:message","version":"123"},"fields":{"area":"agency","title":"Проверить результат"}}'
```

`origin.version` — упорядоченная версия самого источника (его момент изменения с
поясом или неотрицательное целое строкой). Время наблюдения, ETag и хеш её не
заменяют. Без версии первая обработка создаёт задачу, существующая сохраняется с
`freshness_unknown`. `applied`/`skipped` показывают, какие поля приняты и почему
остальные сохранены. `stale`, `version_incomparable` и `freshness_unknown` не дают
права повторить ту же автоматическую правку через `update`.

Для остальных задач сначала `task find-origin --system S --ref R` и поиск
`tasks -q TEXT`, затем создание. Выбирай проект по описанию; при сомнении оставляй
задачу в нужной области без проекта. `existing: true` означает найденную прежнюю
задачу, включая архивную, а не новое создание. Восстановление — отдельное решение.

## Правки

Перед осознанной правкой прочитай `task get ID` и передай его `revision` через
`--base-revision`. Решения владельца имеют приоритет. При конфликте перечитай
`current`, переоцени поручение и сохрани только всё ещё нужные изменения. Не
подставляй свежую revision механически. Отчёты и находки пиши через `comment add`;
описание задачи меняй по поручению. Для атомарного редакторского сохранения
используй `task save --payload` с `fields`, изменённым статусом и чеклистом.

Массовые изменения передавай через `batch --file commands.json`, где файл содержит
массив `{command,payload}`. Пакет атомарен. `--dry-run` показывает предполагаемый
результат; полномочия даёт поручение владельца, а не dry-run. Создание проекта
неотменяемо; не смешивай его с пакетом, для которого нужна отмена целиком.
`undo --operation ID` отменяет одну операцию, `undo SEQ` — событие. Если отмена
конфликтует, не обходи конфликт новыми записями без переоценки поручения.

Отмена и focus, по решению владельца (план 02, «Решение владельца»): агент не
отменяет операции с событиями владельца (403 `forbidden`); операции другого
агента отменяет в рамках scope, чужой комментарий — нет. Ошибку владельца не
исправляй отменой: сообщи комментарием. `focus` ставит и снимает только владелец:
в командах его не передавай (403), в `task sync` поле пропускается
(`skipped: owner`); команды `task focus` в CLI нет, `focus` — чтение групп Focus.
Оформление доски (`taskindex appearance get` — режим, скин, `revision`) меняет
только владелец командой `taskindex appearance set --mode system|light|dark
--skin-id ID` (без `--base-revision` CLI берёт revision из `appearance get`);
агенту сервер отвечает 403 `forbidden`.
Поле, которое владелец правил руками (`ownerFields` задачи, после первого
ручного сохранения — статус, архив, проект, область и чеклист целиком), прямая
команда меняет только с флагом `--confirm-owner-fields`; без него 403 с
`conflicts[].fields`. Флаг — след поручения в «Активности»
(`confirmedOwnerFields` в результате операции), а не доказательство: ставь его,
когда владелец поручил именно это изменение, иначе оставь поле и напиши
комментарий. `task sync` решения владельца не перезаписывает и флага не требует.

## Примеры ответов

1. `taskindex task create --area agency --title 'Проверить отчёт' --due 2026-09-10`
   → `{"ok":true,"operationId":"…","generation":"…","results":[{"record":{"id":"…","revision":1,"createdBy":"agent:claude",…},"changes":{…}}],"events":[…]}`.
2. `taskindex task get t1` → `{"id":"t1","revision":3,…}`; затем
   `taskindex task update t1 --base-revision 3 --note 'Уточнение по звонку'`.
3. `taskindex task sync --origin '{…,"version":"124"}' --fields '{…}'` →
   `{"ok":true,…,"results":[{"record":{…},"existing":true,"applied":["title"],"skipped":[{"field":"status","reason":"owner"}]}]}`.
4. `taskindex task update t1 --base-revision 2 --note '…'` с устаревшей revision →
   `{"ok":false,"code":"conflict","message":"…","retryable":false,"current":{"revision":3,…},"conflicts":[{"entityKind":"task","entityId":"t1","fields":["note"]}]}`,
   код выхода 3: перечитай `current`, переоцени поручение.
5. Обрыв сети → `{"ok":false,"code":"network_error","status":"unknown","operationId":"…","retryable":true,…}`,
   код 1 → `taskindex operation get ID` → при необходимости `taskindex operation resume ID`.
6. Ошибка аргументов → `{"ok":false,"code":"invalid_arguments","message":"Проверьте поля команды task.move","issues":[{"path":"baseRevision","message":"…","hint":"Возьмите revision из `taskindex task get ID` и передайте `--base-revision N`"}],"hint":"taskindex help task move"}`,
   код 2; `issues[].path` называет поле, `hint` — что сделать.

## Восстановление и коды

При `status: unknown` сначала `operation get ID`, затем при необходимости
`operation resume ID`. CLI сохраняет исходный конверт до отправки в
`$XDG_STATE_HOME/taskindex/servers/<сервер>/agents/<агент>/ops` (по умолчанию
`~/.local/state/taskindex/...`); каталог выбирается по серверу и по агенту из
ключа (`GET /api/me`), поэтому два агента на одной машине не видят и не
пересылают конверты друг друга. `operation resume` без ID досылает только свои
конверты; `operation list` показывает свою очередь и повреждённые файлы
(они переименованы в `*.corrupt` и не отправляются; предупреждение
`outbox_skipped` в stderr не мешает чтениям). `retryable: true`, в том числе
503 при деплое, оставляет конверт для повторов. Не создавай новый operationId
для прежнего намерения, не переписывай сохранённый конверт и не меняй его
generation. `generation_changed` требует свежего контекста и новой оценки
действия после восстановления базы (`cursor reset`, затем `digest`).

Коды выхода: 0 успех; 1 сервер, сеть или неизвестный исход; 2 аргументы;
3 конфликт/неприменимая отмена/смена поколения; 4 нет доступа. Смотри JSON `code`,
`retryable`, `current`, `applied`, `skipped`, а не только числовой код.
Коды сервера: `invalid` (поля запроса, см. `issues`), `unauthorized` (ключ не
принят), `forbidden` (scope, решение владельца, focus), `not_found`, `conflict`
(revision или курсор страниц), `operation_mismatch` (тот же operationId с другим
конвертом), `generation_changed` (база восстановлена), `not_undoable`,
`unavailable` (повторяемо, запись закрыта), `internal`. Коды CLI:
`invalid_arguments` (аргументы, код 2), `client_error` (сбой самого CLI),
`network_error` (обрыв, исход неизвестен), `invalid_response` (ответ не
подтверждает операцию). У ошибок полей есть `issues[].path` и `issues[].hint`.
Исход записи и судьба конверта решаются одним правилом: `ok: true` с тем же
`operationId` и `generation` — код 0, конверт удалён; окончательный отказ
(`ok: false`, `retryable: false`) — конверт удалён, код 3 для `conflict`,
`operation_mismatch`, `generation_changed`, `not_undoable`, код 4 для
`unauthorized`/`forbidden`, иначе 1; повторяемый отказ или обрыв — код 1,
`status: unknown`, конверт сохранён; ответ, не подтверждающий операцию
(2xx без результата, чужой `operationId`/`generation`, не JSON) — код 1,
`code: invalid_response`, `status: unknown`, конверт сохранён: проверь
`operation get ID` и не создавай новый operationId.

TaskIndex не отправляет сообщения, не переводит деньги и не меняет внешние
операционные системы. Запись задачи об этих действиях не означает их выполнение.
