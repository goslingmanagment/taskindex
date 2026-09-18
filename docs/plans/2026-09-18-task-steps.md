# План TI-095: шаги задачи как план агента

**Статус:** волна А выполнена 2026-09-18 в ветке `task-steps` (правило защиты
шагов, правило в `/api/context`, раздел «Шаги» в скилле). Волна Б спроектирована
ниже, не начата.

**Решение владельца (2026-09-18, «делай как правильнее и лучше»).** Подзадачи
живут внутри карточки шагами, а не карточками на доске. Шаг становится записью
журнала со своей ревизией и своей защитой владельца (пересмотр решения Ж7 плана
02 от 2026-09-10 «защита чеклиста целиком»). Отметка шага и добавление новых
шагов агентом флага не требуют; переименование, удаление, перестановка шагов
владельца и снятие его отметки требуют `confirmOwnerFields`. Порядок: волна А
(правило и скилл на текущей модели), затем волна Б (шаги как записи).

**Цель:** владелец говорит «оформи» или «выполни», агент пишет план шагами,
работает по нему несколько сессий, отмечает шаги с итогами, а владелец правит
формулировки и ставит галочки сам, не блокируя агента. На карточке видно, кто
и когда закрыл шаг и что вышло; шаг, переросший задачу, выносится в отдельную
задачу со ссылкой.

**База:** `main` `cf576a1` (2026-09-18). Прод `c159b8b`, схема 7.

## 0. Что изменится для владельца, на примерах

1. **«Оформи задачу про перенос бота».** Claude показывает шесть шагов
   действиями («Поднять контейнер на новом сервере», «Перенести базу»,
   «Тесты зелёные»), после «да» пишет их. На карточке 0/6, на столе Focus
   первый шаг как следующее действие. Так уже работает.
2. **Ты поправил формулировку четвёртого шага в браузере.** До волны А весь
   чеклист становился твоим полем и агент получал 403 на любую отметку. После
   волны А агент отмечает шаги и добавляет новые свободно; переписать или
   убрать твой шаг он может только по твоим словам с флагом. После волны Б
   защищён только тот шаг, который ты трогал.
3. **Codex выполнил шаги 1–3 вчера, Claude шаг 4 сегодня.** После волны Б под
   каждым отмеченным шагом подпись «Codex Mac · 17.09» и строка итога
   («PR #12, тесты зелёные»); в «Активности» те же события словами.
4. **Шаг «Настроить мониторинг» оказался неделей работы.** После волны Б агент
   предлагает вынести его в задачу того же направления, после «да» одна
   операция создаёт задачу и связывает шаг; у шага чип задачи со статусом.
   Галочку на шаге ставит агент или ты, когда задача закрыта.

## 1. Волна А (сделано 2026-09-18)

Правило в `commitTaskPatch` (`src/shared/commands.ts`, функция
`overridesOwnerSteps`): для поля `checklist` из `ownerFields` агент без флага
проходит, если существующие шаги сохранили текст, относительный порядок и ни
одна отметка не снята; новые шаги в любом месте и отметки `done: true`
свободны. `task.sync` чеклист после касания владельца по-прежнему не трогает.

Тесты: `tests/api/permissions.test.ts` (`TI-095: after the owner edited a step…`,
падал на `cf576a1` с 403; `TI-095: rewording, removing, reordering or unticking…`),
оракул `tests/property/commands.test.ts` знает правило пошагово. Правило в
`/api/context` (`src/server/context.ts`), `skills/taskindex/SKILL.md` раздел
«Шаги», `reference.md` абзац о прямых командах.

## 2. Волна Б: шаги как записи

### 2.1 Запись `step`

Новый вид записи в `ENTITY_KINDS` (`src/shared/entities.ts`), коллекция
`steps` в `WorkspaceState`, таблица остаётся `checklist_items`.

| Поле | Тип | Смысл |
|---|---|---|
| `id`, `taskId` | id | шаг принадлежит одной задаче; идентификаторы шагов уникальны во всём пространстве (инвариант есть сегодня) |
| `text` | ≤ `LIMITS.checklistText` (500) | действие одной строкой |
| `orderKey` | дробный ключ (`fractional-indexing`, как `orderKey` задачи) | порядок внутри задачи; уникален среди неудалённых шагов задачи |
| `done` | boolean | отметка |
| `doneAt`, `doneBy`, `doneByLabel` | stamp / актор / подпись, `null` пока не отмечен | ставятся редьюсером вместе с `done: true`, снимаются вместе с `done: false` |
| `result` | ≤ `LIMITS.stepResult` (1000), по умолчанию `''` | итог шага: что вышло, ссылка на PR или файл |
| `linkedTaskId` | id или `null` | задача, в которую вырос шаг |
| `removedAt` | stamp или `null` | мягкое удаление, как `deletedAt` комментария: отмена возвращает шаг |
| `createdBy`, `createdByLabel` | как у задачи | кто добавил шаг |
| `ownerTouchedAt`, `ownerFields` | как у задачи | защита владельца по этому шагу |
| `revision`, `createdAt`, `updatedAt` | как у задачи | своя ревизия: `baseRevision` команд шага это ревизия шага |

Предметные поля (`subjectFields`): `text`, `orderKey`, `done`, `doneAt`,
`doneBy`, `doneByLabel`, `result`, `linkedTaskId`, `removedAt`. `doneAt` и
`doneBy` предметные, чтобы отмена отметки возвращала их вместе с `done`.

`Task.checklist` остаётся в каждом чтении задачи и в снимке как производное
поле: неудалённые шаги задачи по `orderKey`, в форме записи шага (с `revision`,
`doneByLabel`, `result`, `linkedTaskId`). Оно ведётся так же, как
`commentCount`: редьюсер пересчитывает его при каждом изменении шагов,
`changesBetween` его не журналирует, `applyEvent` по событию шага перестраивает
чеклист родителя. `checklist` уходит из `subjectFields` задачи; события задач
с `changes.checklist`, записанные до миграции, история читает по-прежнему
(`history.ts`, `checklistText`), `applyEvent` их игнорирует, отмена таких
событий отвечает `invalid` «событие прежнего формата».

### 2.2 Команды

Группа CLI остаётся `checklist` (установленные обёртки и привычка агентов),
вид записи `step`.

| Команда | Payload | Что делает |
|---|---|---|
| `checklist.add` | `taskId`, `id?`, `text`, `position?` (индекс с нуля) ; `baseRevision?` принимается и игнорируется один релиз ради старых CLI | создаёт шаг с ключом между соседями; ревизия задачи не нужна, как у `comment.add` |
| `checklist.update` | `taskId`, `itemId`, `baseRevision` (шага), `text?`, `done?`, `result?`, `linkedTaskId?` | правка одного шага; `done: true` ставит `doneAt/doneBy`, `done: false` снимает |
| `checklist.remove` | `taskId`, `itemId`, `baseRevision` | `removedAt = now` |
| `checklist.move` (новая) | `taskId`, `itemId`, `baseRevision`, `before` или `after` | новый `orderKey` одному шагу |
| `checklist.reorder` | `taskId`, `itemIds` (все неудалённые) ; `baseRevision?` игнорируется | свежие ключи всем перечисленным; оставлена для API-совместимости |
| `checklist.promote` (новая) | `taskId`, `itemId`, `baseRevision`, `title?`, `priority?`, `projectId?` | одна операция: `task.create` в области родителя (направление родителя, если не задано; заметка «Шаг задачи «…»» со ссылкой `?task=ID`; P2; `todo`) и `linkedTaskId` на шаге; scope `tasks` достаточно |
| `task.create` | `checklist: [{id?, text, done?}]` как сегодня | создаёт шаги той же операцией, эффекты `task` + N `step` |
| `task.save` | без `checklist` | веб собирает пакет: `task.save` полей плюс `checklist.*` по разнице черновика и базы |
| `task.sync` | `fields.checklist` | шаги создаются только при создании задачи; дальше `skipped: [{field: 'checklist', reason: 'locked'}]` |

Входная схема `checklistSchema` (для `task.create`/`task.sync`) остаётся
`{id?, text, done?}`; форма чтения шага это новая `stepSchema` в
`domain-schemas.ts`.

### 2.3 Правила домена

- **Защита владельца по шагу.** `emit` ведёт `ownerTouchedAt`/`ownerFields` у
  записей с этими полями (задача и шаг), не только у задачи. Прямая команда
  агента над шагом проходит проверку `ownerFields` этого шага, тем же кодом,
  что `commitTaskPatch`. Следствия: владелец поправил текст шага 1, агент
  свободно отмечает шаг 1 и переименовывает шаг 2; владелец поставил галочку,
  агент снимает её только с флагом; новый шаг агента никем не защищён.
- **Конфликты по шагу.** `assertMerge('step', …)` по `baseRevision` шага:
  два актора правят разные шаги без конфликта.
- **Текущий шаг = первый неотмеченный.** Состояния «в работе» у шага нет.
- **Все шаги отмечены не значит Готово.** Статус задачи меняется отдельно.
- **Связанный шаг** показывает статус дочерней задачи, но не отмечается сам.
  `linkedTaskId` должен существовать и не совпадать с `taskId`; архив дочерней
  задачи связь не рвёт.
- **Инварианты** (`assertInvariants`): у неудалённых шагов задачи уникальные
  `orderKey`; не больше `LIMITS.checklistItems` неудалённых шагов на задачу;
  идентификаторы шагов уникальны во всём пространстве; `taskId` существует.
- **Отмена**: по записи шага, как у комментария. `undo` операции `promote`
  откатывает оба эффекта тем же путём, что `undo` `task.create` сегодня
  (проверить в `tests/property/undo.test.ts` и повторить для двух записей).
- **Права**: `requireScope(actor, 'step')` как у `task` (`tasks` и `write`);
  `read` получает 403.

### 2.4 Хранение, миграция 0008, экспорт 8

`src/server/schema.ts`: колонки таблицы `checklist_items` `order_key`,
`done_at`, `done_by`, `done_by_label`, `result` (NOT NULL DEFAULT ''),
`linked_task_id`, `removed_at`, `created_by`, `created_by_label`,
`owner_touched_at`, `owner_fields` (JSON, DEFAULT '[]'), `revision`,
`created_at`, `updated_at`; колонка `position` и индекс `checklist_position`
удаляются; новый уникальный индекс `(task_id, order_key) WHERE removed_at IS
NULL`, индекс `(task_id)`.

Миграция `drizzle/v2/0008_steps.sql` (DDL через `npm run db:generate`,
backfill руками, правило плана 09): `order_key` из `position` ключами, которые
породил бы `generateKeyBetween` при последовательном добавлении: для
`position < 62` это `'a' || substr(BASE62, position + 1, 1)`, дальше
`'b0' || substr(BASE62, position - 61, 1)`, где `BASE62 =
'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'` (лимит 100
шагов укладывается); `created_at`, `updated_at`, `created_by`,
`created_by_label` из родительской задачи; `revision = 1`; `owner_fields =
'[]'` (прежние касания владельца по шагам миграция не восстанавливает, история
их хранит); из `tasks.owner_fields` удаляется элемент `"checklist"`.
Тест `tests/api/migrations.test.ts`: после миграции копии ключи валидны для
`generateKeyBetween` и упорядочены как прежние позиции.

Экспорт: `FORMAT_VERSION = 8`, массив `steps` полными записями вместо
`checklistItems`; импорт форматов 1–7 конвертирует `checklistItems` в записи
шагов тем же правилом (`src/server/export-upgrade.ts`), фикстура
`tests/fixtures/export-schema-7.json` уже есть.

### 2.5 Чтение, SSE, веб-стор

- `readState`/`readTask` (`src/server/db.ts`) читают шаги в `state.steps` и
  собирают `task.checklist`; `writeState` пишет изменённые шаги upsert-ом, а не
  «удалить всё и вставить».
- События `step` несут `taskId` (как комментарии); `journal.summarize` уже
  берёт заголовок задачи по `e.taskId`.
- `applyEvent` (`src/shared/commands.ts`): событие `step` обновляет запись в
  `steps` и пересобирает `checklist` родителя; событие `task` с
  `changes.checklist` игнорируется.
- `src/web/app/commands.ts`: `taskSaveCommand` без `checklist`;
  `checklistDiffCommands(base, draft)` даёт `add`/`update`/`remove`/`move`;
  `use-save-intent.ts` отправляет пакет, когда изменились и поля, и шаги.
  `checklistToggleCommand` передаёт ревизию шага.
- `conflict-panel.tsx`: конфликт с `entityKind: 'step'` показывается словами
  «Шаг «…» изменился», текст черновика остаётся в форме.

### 2.6 Интерфейс

- Редактор (`checklist-editor.tsx`): под отмеченным шагом подпись
  «{doneByLabel} · {дата}»; строка итога (свёрнута, раскрывается по клику,
  textarea до 1000 знаков); у связанного шага чип задачи со статусом и
  переходом `?task=ID`; меню строки: «В задачу», «Убрать». Перетаскивания
  шагов нет и не появляется.
- Стол (`desk-current.tsx`): та же подпись под отмеченными шагами; отметка
  как сегодня.
- Карточка (`card.tsx`) не меняется: счётчик n/m.
- «Активность» (`history.ts`): подписи полей шага; события словами: «добавлен
  шаг «…»», «шаг «…» отмечен выполненным, итог: …», «шаг «…» вынесен в задачу
  «…»», «шаг «…» убран», «шаг «…» возвращён».

### 2.7 CLI и скилл

`src/cli/spec.ts`: `checklist add` без `--base-revision` (флаг принимается и
предупреждения не даёт), `checklist update` с `--result` и `--linked-task-id`,
новые `checklist move` и `checklist promote`; для `update|remove|move|promote`
CLI подставляет ревизию шага сам через `GET /api/tasks/{taskId}`
(`fillAutofilled` в `writes.ts`, как для `appearance.update`), явный флаг
побеждает. `task get` печатает шаги с новыми полями. Скилл: раздел «Шаги»
получает `promote` и `--result`; шпаргалка обновляется; `reference.md`
описывает защиту по шагу.

### 2.8 Тесты

- `tests/api/commands.test.ts`: создание с чеклистом даёт записи шагов и
  события `step`; `add` в середину; `move`; `remove` мягкий и `undo` возвращает;
  `update done` ставит и снимает `doneAt/doneBy`; `promote` создаёт задачу с
  направлением родителя и ссылкой; лимит неудалённых шагов.
- `tests/api/permissions.test.ts`: защита по шагу (сценарии из 2.3), `read`
  403, `tasks` может `promote`.
- `tests/api/migrations.test.ts`, `tests/api/migration-compat.test.ts`:
  0008 на копии базы и импорт формата 7.
- `tests/property/undo.test.ts`, `tests/property/commands.test.ts`: генератор
  получает `checklist.update|remove|move`; оракул защиты по шагу.
- `tests/web/store.test.ts`, `tests/web/history.test.ts`: `applyEvent` для
  шагов, подписи истории.
- `tests/e2e/web-client.spec.ts`, `tests/e2e/desk.spec.ts`: редактор (добавить,
  отметить, итог, «В задачу»), стол (подпись автора).
- `tests/cli/cli.test.ts`, `tests/cli/docs.test.ts`: подстановка ревизии, новые
  команды в справке и скилле.

### 2.9 Карта файлов

| Файл | Что меняется |
|---|---|
| `src/shared/entities.ts` | вид `step`, коллекция `steps`, предметные поля; `checklist` уходит из полей задачи |
| `src/shared/domain-schemas.ts` | `stepSchema`, `task.checklist` в форме шага, `entitySchema`, экспорт формата 8 и схема формата 7 |
| `src/shared/schemas.ts` | payload-схемы `checklist.*`, `task.save` без `checklist` |
| `src/shared/limits.ts` | `stepResult: 1000` |
| `src/shared/model.ts` | `Step`, `steps` в `WorkspaceState`, `FORMAT_VERSION = 8` |
| `src/shared/commands.ts` | `applyStep*`, производный `checklist`, защита по шагу в общем хвосте, инварианты, `applyEvent` |
| `src/shared/queries.ts` | сортировка шагов по `orderKey` |
| `src/server/schema.ts`, `drizzle/v2/0008_steps.sql`, `drizzle/v2/meta/*` | таблица и миграция |
| `src/server/db.ts` | чтение и запись шагов |
| `src/server/export-upgrade.ts`, `src/server/backup.ts` | формат 8, конверсия 7 → 8 |
| `src/server/context.ts` | правило про шаги |
| `src/cli/spec.ts`, `src/cli/writes.ts`, `src/cli/help.ts` | команды, подстановка ревизии |
| `src/web/app/commands.ts`, `editor/use-save-intent.ts`, `editor/checklist-editor.tsx`, `desk/desk-current.tsx`, `desk/desk.tsx`, `history.ts`, `conflict-panel.tsx`, `store.ts` | пакет по разнице, подписи, итог, чип, конфликт шага |
| `src/web/skin/editor.css`, `src/web/skin/desk.css` | подпись и строка итога через `var(--…)` |
| `skills/taskindex/SKILL.md`, `reference.md` | `promote`, `--result`, защита по шагу |

### 2.10 Порядок работ

Каждый шаг заканчивается `npm run check`; e2e после шагов 5 и 6.

1. Общая модель: `entities`, `model`, `limits`, `domain-schemas`, `schemas`.
2. Редьюсер: команды шага, производный `checklist`, защита, инварианты,
   `applyEvent`; property-тесты.
3. Сервер: `schema.ts`, миграция 0008, `db.ts`, экспорт 8 и конверсия,
   правило в `context.ts`; тесты миграций на копии `data/dev.db` вне основного
   чекаута.
4. CLI: команды, подстановка ревизии, справка; скилл и справочник; `docs.test`.
5. Веб: стор, пакет по разнице, редактор, стол, история, конфликт шага.
6. E2E, `npm run e2e`, релиз `bash deploy/release.sh <sha>` после зелёного CI;
   в день выпуска открытые вкладки перезагрузить до первой записи
   (`schemaVersion` снимка меняется).

Оценка: два–три дня работы агентов; сопоставимо с «метки как данные»
(`044f27a`), шире за счёт производного поля задачи и веб-стора.

## 3. Не делаем

Задачи-дети с `parentId`, вложенные шаги, сроки и исполнители у шагов,
автоматическое «Готово» по последней отметке, зеркалирование статуса дочерней
задачи в отметку шага, перетаскивание шагов в редакторе.

## 4. Риски и открытые места

- Старые CLI на маке и winpc передают `baseRevision` в `checklist.add`: схема
  принимает и игнорирует поле один релиз, затем поле убирается.
- Производный `checklist` в двух местах (`readState` и `applyEvent`): один
  helper `projectChecklist(steps, taskId)` в `src/shared`, тест на равенство
  снимка и результата replay (`tests/web/replay-identity.test.ts`).
- `task.sync` с шагами после создания задачи пропускается; если появится
  источник, которому нужны шаги, правило пересмотреть отдельным решением.
- `TASKS.md` в `/OS` шаги не печатает; при желании владельца добавить строку
  «n/m» в `scripts/render_tasks_md.py` отдельной правкой.
