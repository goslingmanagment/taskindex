# TaskIndex: справочник по CLI

Техника для редких случаев. Правила поведения и повседневные команды в
`SKILL.md`; этот файл открывают при работе с внешними источниками, курсорами,
после обрыва сети и при разборе кодов ошибок. Справка любой команды:
`taskindex help`, `taskindex help <group>`, `taskindex help <group> <action>`
или `<команда> --help` печатают `usage`, флаги с типами и обязательностью,
пример, коды выхода и коды ошибок. Неполная команда (`taskindex task`)
перечисляет действия группы; неизвестный флаг называет команду и её справку.
Флага --json нет: вывод всегда JSON.

## Окружение

CLI читает `TASKINDEX_URL` и `TASKINDEX_TOKEN` из окружения. На маке их
подставляет обёртка `~/.local/bin/taskindex` из `~/.config/taskindex/<агент>.env`
(установка описана в README, раздел «Агенты»); заданные явно переменные (sandbox
из `npm run sandbox`) обёртка не трогает. Секрет не включается в сообщения, файлы
поручения и аргументы команд. Проверка: `taskindex me` печатает актора ключа
(`id`, `label`, `scope`) без секрета.

## Чтение и курсоры

Начни с `taskindex context` для модели и описаний направлений и `taskindex digest`
для текущего состояния. Полный согласованный список даёт только
`taskindex snapshot` (`/api/snapshot`). Если часть digest содержит `more`,
дочитай её по указанным `href`/`nextCursor`; новый `since` сохраняй только после
всех страниц операций. `tasks --all` и `activity --all` выводят каждую страницу
отдельной JSON-строкой после полного прохода.

Страницы `/api/tasks` идут по ключу (`orderKey`, `id`): запись между страницами
не даёт `409`, обход продолжается, но перемещённая задача может повториться или
выпасть; разные `seq` первой и последней страницы CLI помечает stderr
`list_changed_during_walk`. Это предупреждение, не отказ: для согласованного
списка возьми `snapshot`. Настоящий `409 conflict` на курсоре страниц (курсор
чужой выборки или устаревший) CLI обрабатывает сам: повторяет обход с первой
страницы до трёх раз (stderr `restart`). При ручном обходе по `nextCursor` после
`409` начни с первой страницы. `tasks --today true` повторяет выборку «На
сегодня» владельца, `tasks --has-follow-up true|false` даёт задачи с датой
возврата или без.

Позиция чтения хранится в `cursor.json` рядом с очередью конвертов, отдельно для
каждого сервера и агента: `taskindex cursor show|commit SEQ|reset`.
`digest|activity|inbox|events --since last` читают от сохранённой позиции (без
курсора с нуля под текущим поколением), `--commit` записывает `seq`,
`operationSeq` и `generation` ответа только после дочитывания всех страниц
(`more: false`); неполный обход курсор не двигает (stderr
`cursor_not_committed`). Числовой `--since N` при `N > 0` требует `--generation`
исходного курсора. В курсоре две независимые позиции одного поколения: `seq` по
событиям и `operationSeq` по журналу операций; коммит, знающий только одну,
сохраняет другую. `activity --since last` идёт по журналу (`after=operationSeq`,
по возрастанию), поэтому показывает и отказы, и операции без изменений; то же
окно у `digest --since-op N`. Окно по событиям (`--since`) их не содержит.
`activity --actor agent:ID` показывает операции одного агента: так проверяют,
что до «да» владельца агент ничего не записал.

Входящие для агента — `taskindex inbox`: комментарии владельца после `since` с
текстом, задачей и `seq` (одна строка JSON: `comments`, `generation`, `seq`,
`more`, `href`); продолжение — `inbox --since <seq последнего показанного>` или
`--commit`. `events --follow --since last` читает изменения опросом и печатает
только страницы с событиями (пустые страницы не выводятся, ошибки выводятся
всегда); интервал `--interval MS`, по умолчанию 1000, минимум 250.

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
`tasks -q TEXT`, затем создание. `existing: true` означает найденную прежнюю
задачу, включая архивную, а не новое создание. Восстановление — отдельное
решение владельца.

## Правки, поля владельца, отмена

Перед осознанной правкой прочитай `task get ID` и передай его `revision` через
`--base-revision`. При конфликте перечитай `current`, переоцени поручение и
сохрани только всё ещё нужные изменения. Не подставляй свежую revision
механически. Для атомарного редакторского сохранения используй
`task save --payload` с `fields`, изменённым статусом и чеклистом.

Приоритет, метки и проблема: `--priority p1|p2|p3` (по умолчанию `p2`),
`--labels dengi,lora` (только слаги действующих меток из `labels` в
`taskindex context`, до 8 без повторов; неизвестный или архивный слаг сервер
отклоняет; JSON-массив тоже принимается, `--labels '[]'` снимает все метки),
`--closes lora-km-of-vacancy` (`null` снимает). Чтение: `tasks --priority p1`,
`tasks --label dengi`, `tasks --closes SLUG`; `digest` несёт `counts.p1` для
незавершённых P1 вне архива.

Два разных правила защиты решений владельца:

- **Прямая команда** (`task update|save|move|archive|restore`, чеклист) над
  полем, которое владелец действительно менял сам (`ownerFields` задачи),
  проходит только с флагом `--confirm-owner-fields`; без него 403 `forbidden`
  с `conflicts[].fields`. Шаг это запись со своей `revision`
  (`checklist[].revision` в `task get`) и своей защитой: переименование,
  удаление, перестановка шага, который владелец написал или правил, и снятие
  его отметки требуют флага; отметка `--done true`, `--result`, новые шаги и
  правка шагов, которых владелец не касался, проходят без него (TI-095,
  2026-09-18). `checklist update|remove|move|promote` берут ревизию шага сами
  из `task get`, явный `--base-revision` побеждает; `checklist add` и
  `reorder` ревизии не требуют. Поле, которого владелец не касался, агент меняет по
  поручению без флага: владелец поправил только название, агент по поручению
  переносит задачу в другую область или ставит P1 прямой командой свободно.
  Флаг это след поручения в «Активности» (`confirmedOwnerFields` в результате
  операции), а не доказательство: ставь его, когда владелец поручил именно это
  изменение, иначе оставь поле и напиши комментарий.
- **`task sync`** флага не требует и решений владельца не перезаписывает:
  после первого касания владельцем задачи `sync` пропускает `status`, архив,
  `area`, `project`, `priority` (`skipped: owner` или `locked`), а `labels` и
  `closes` только если владелец их менял; `focus` в `sync` пропускается всегда
  (`skipped: owner`).

Массовые изменения передавай через `batch --file commands.json`, где файл содержит
массив `{command,payload}`. Пакет атомарен. `--dry-run` показывает предполагаемый
результат; полномочия даёт поручение владельца, а не dry-run. `--dry-run` входит
в конверт операции, поэтому пробный прогон с уже использованным `operationId`
отвечает `operation_mismatch` (код 3): это контракт, а не сбой — исход прежней
операции узнают через `operation get ID`, не через dry-run. Создание проекта
неотменяемо; не смешивай его с пакетом, для которого нужна отмена целиком.
`undo --operation ID` отменяет одну операцию, `undo SEQ` — событие. Если отмена
конфликтует, не обходи конфликт новыми записями без переоценки поручения.

Отмена и focus (решение владельца, план 02): агент не отменяет операции с
событиями владельца (403 `forbidden`); операции другого агента отменяет в рамках
scope, чужой комментарий — нет. Ошибку владельца не исправляй отменой: сообщи
комментарием. `focus` ставит и снимает только владелец: в командах его не
передавай (403); команды `task focus` в CLI нет, `focus` — чтение стола.
`taskindex focus` печатает стол владельца одной строкой JSON: `current`, `next`,
`waiting`, `recent`, `counts` и `groups`; `taskindex focus --group ГРУППА --all`
читает одну группу постранично, а `taskindex digest` несёт `current` и `next`
того же стола. Оформление доски (`taskindex appearance get` — режим, скин,
галочка «Без P3», `revision`) меняет только владелец: `taskindex appearance set
--mode system|light|dark --skin-id ID --hide-p3 true|false` (без
`--base-revision` CLI берёт revision из `appearance get`); агенту сервер
отвечает 403 `forbidden`.

## Предложения агентов

Предложение это точная команда задачи, которая ждёт «да» владельца: `new_task`
(`task.create`) или `task_change` (`task.update`, `task.move` только в `done`,
`task.archive`) с `taskId` и `baseRevision` задачи, которую видел автор. Доска,
`snapshot`, `digest` и Focus их не показывают; «Активность» владельца скрывает
создание и показ.

- `taskindex proposals [--status queued,shown] [--since ДАТА] [--all]`: список по
  времени создания, постранично как `tasks`; `taskindex proposal get N|ID`.
  `N` из одной-двух цифр это номер среди показанных сейчас.
- `taskindex proposal create --payload '{"kind","taskId","baseRevision","command":{"command","payload"},"reason","evidence":[{"source","ref","at","quote"}],"fingerprint","rank"}'`:
  в очередь; тот же `fingerprint` в любом статусе новой записи не даёт,
  `results[0].existing: true` и прежнее предложение (отказ держится). По «да»
  выполняется только то, что видно в утреннем сообщении: `focus`,
  `focusPosition`, `position`, `origin`, отмеченный шаг (`done: true`) и итог
  шага (`result`) предложение не несёт (400 `invalid`), заметка новой задачи
  до 300 символов.
- `taskindex proposal deliver [--limit 1..5]`: утренний показ одной операцией.
  `results[0]` это `{date, shown, queued, expired, stale}`: показанные сегодня
  по номеру, сколько осталось, какие истекли (3 дня без ответа) и какие стали
  `stale` (задача изменилась, в архиве или закрыта). Повтор в тот же день
  отвечает тем же и ничего не меняет; больше пяти в день не показывается.
- `taskindex proposal accept N|ID [--patch JSON]`: выполняет команду
  предложения с правкой владельца поверх `payload` (ключ `command` меняет вид
  действия) как его поручение: поля из `ownerFields` считаются
  подтверждёнными (`confirmedOwnerFields`). `results[0]` это `{proposal,
  task}`. Задача изменилась после предложения: ответ успешный, `task: null`,
  `proposal.status: stale`, `reason` объясняет, задача не тронута. Не `shown`:
  `conflict` с названием статуса.
- `taskindex proposal reject N|ID [--reason ТЕКСТ]`: из `shown` или `queued`.
- `undo --operation ID` принятия откатывает и запись задачи, и решение
  (предложение снова `shown`); `undo SEQ` любого события принятия, записи
  задачи тоже, отвечает `not_undoable`; создание и показ не отменяются.

Scope `propose` (ночная смена): все чтения и только `proposal create` и
`proposal deliver`, остальное `forbidden`. `accept` и `reject` нужны `tasks`
или `write`.

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

`taskindex export --out FILE` пишет полный экспорт формата 9: у каждой операции
обязателен `operationSeq` (позиция в журнале операций), в `settings` обязателен
`schema_version`, и рядом с задачами лежит запись `appearance` — предпочтение
оформления владельца, ровно одна. Формат 5 включает `priority`, `labels`, `closes`
и `appearance.hideP3`, формат 8 шаги записями, формат 9 предложения агентов.
Форматы 1–8 читаются импортом с восстановлением отсутствующих полей по
умолчанию, но не пишутся.

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
