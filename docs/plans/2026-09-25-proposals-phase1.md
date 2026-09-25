# План: предложения агентов, фаза 1

Спека: [2026-09-25-agent-proposals.md](../specs/2026-09-25-agent-proposals.md),
разделы 5.1, 5.2 (этапы 3 и 5), 5.3, 5.4, 6, 8. Базовый коммит `f2ab3d5` плюс
исправление копий доски (ветка `backup-restore`, фаза 0). Владелец одобрил
спеку 2026-09-25 («да давай кодь»).

Работа делится на две части, которые идут параллельно в своих worktree и
сходятся в одну ветку перед выпуском:

- **Часть А: сервер, CLI, скилл.** Сущность, права, команды, чтение, журнал,
  экспорт, веб не ломается.
- **Часть Б: ночная смена, фаза 1.** Проверка доски без нейросети, отчёт
  прогона, утреннее сообщение. Пишется против контракта ниже; до слияния с
  частью А проверяются только чистые функции.

## 1. Контракт (общий для обеих частей)

### 1.1. Запись `proposal`

| Поле | Тип | Правило |
|---|---|---|
| `id` | `idSchema` | как у задач |
| `kind` | `'new_task' \| 'task_change'` | |
| `taskId` | id или `null` | обязателен для `task_change`, `null` для `new_task` |
| `baseRevision` | целое или `null` | revision задачи, которую видел автор; обязателен для `task_change` |
| `command` | `{ command, payload }` | `command` из `task.create`, `task.update`, `task.move`, `task.archive`; `payload` проходит схему этой команды. `new_task` только с `task.create`; `task_change` с остальными тремя, `payload.id === taskId`, `payload.baseRevision === baseRevision`. `task.move` только `status: 'done'` без `before`/`after`. Заметка в `task.create` не длиннее 300 символов. |
| `reason` | строка 1–300 | для человека |
| `evidence` | массив 1–3 `{ source, ref, at, quote }` | `source`: `session` \| `telegram` \| `board`; `ref` до 200; `at` дата `YYYY-MM-DD` или момент ISO; `quote` 1–200 |
| `fingerprint` | строка 1–200 | уникальна среди всех предложений за всё время |
| `rank` | `1 \| 2 \| 3` | 1 срочное, 3 уборка |
| `status` | `queued`, `shown`, `accepted`, `rejected`, `expired`, `stale` | |
| `number` | 1–15 или `null` | только у `shown` |
| `shownOn` | `YYYY-MM-DD` или `null` | дата показа в поясе владельца (`settings.timezone`) |
| `decidedAt`, `decidedBy`, `decidedByLabel` | | кто и когда перевёл в итоговый статус; для `expired` и `stale` это актор операции `deliver` или `accept`, которая это сделала |
| `decisionReason` | строка до 300 или `null` | причина отказа, `stale` или `expired` |
| `patch` | объект или `null` | правка владельца при принятии |
| `resultTaskId` | id или `null` | задача, созданная или изменённая принятием |
| `createdBy`, `createdByLabel`, `createdAt`, `revision`, `updatedAt` | | по образцу задач и шагов |

Лимиты в `src/shared/limits.ts`.

### 1.2. Команды

| Команда | CLI | Scope | Результат |
|---|---|---|---|
| `proposal.create` | `taskindex proposal create [ID] --payload JSON \| --file` | `propose`, `tasks`, `write` | `{ proposal, existing }`; при существующем `fingerprint` операция без изменений, `existing: true`, прежняя запись |
| `proposal.deliver` | `taskindex proposal deliver [--limit N]`, N 1–5, по умолчанию 5 | `propose`, `tasks`, `write` | `{ date, shown, queued, expired, stale }`: `shown` показанные сегодня по номеру, `queued` сколько осталось в очереди, `expired`/`stale` id снятых этим вызовом |
| `proposal.accept` | `taskindex proposal accept REF [--patch JSON]` | `tasks`, `write` | `{ proposal, task }` |
| `proposal.reject` | `taskindex proposal reject REF [--reason TEXT]` | `tasks`, `write` | `{ proposal }` |

`REF`: строка из одной-двух цифр это номер среди `shown`, иначе `id`.

`proposal.deliver` по шагам, всё в одной операции:
1. `today` = дата сейчас в `settings.timezone`.
2. Есть `shown` с `shownOn === today`: вернуть их, больше ничего не менять.
3. `shown` с `shownOn` раньше `today − 3 дня`: `expired`, номер свободен.
4. `queued` и `shown` с `task_change`, у которых задача не найдена, в архиве,
   в `done` или `revision !== baseRevision`: `stale` с причиной.
5. Из `queued` по `rank`, затем `createdAt`, затем `id`: до `limit`, пока
   свободны номера 1–15; каждый получает наименьший свободный номер,
   `shown`, `shownOn = today`.

`proposal.accept`: предложение должно быть `shown` (иначе `conflict` с
названием статуса). `task_change` с несовпавшей revision: предложение
`stale`, ответ `conflict` «задача изменилась после предложения» (запись
`stale` сохраняется, сама задача не меняется). Иначе в одной операции
выполняется `command` с наложенным `patch` (глубина одна: поля payload),
как по поручению владельца с подтверждёнными полями владельца, и
предложение становится `accepted` с `resultTaskId`. `patch` проходит ту же
проверку, что и `command` в 1.1. `undo` операции откатывает обе части.

`proposal.reject`: только из `shown` или `queued`.

### 1.3. Чтение

- `GET /api/proposals?status=a,b&since=YYYY-MM-DD` → CLI `taskindex
  proposals [--status S,…] [--since DATE]`, постранично как `tasks`.
  `since` по `createdAt`.
- `GET /api/proposals/{ref}` → `taskindex proposal get REF`.
- Схемы ответа в `src/shared/domain-schemas.ts`, записи в `READS`
  `src/cli/spec.ts`. Читать может любой scope.

### 1.4. Scope `propose`

`read` < `propose` < `tasks` < `write` не образуют лестницы: `propose` даёт
все чтения и две записи (`proposal.create`, `proposal.deliver`), и больше
ничего. `tasks` и `write` могут всё про предложения. Владелец в браузере
может всё (кнопок нет, но API не запрещает). Хранение: столбец
`agent_keys.scope` текстовый, миграция для нового значения не нужна;
enum в `schema.ts`, `domain-schemas.ts`, admin `agent-key create --scope`
принимают `propose`.

## 2. Часть А: сервер, CLI, скилл

Следовать чек-листу `docs/plans/2026-09-08-v2-review/04-api-contract-and-schemas.md`
§3.8 и образцу шагов (коммит `5c1bd12`, TI-095):

1. `src/shared`: `ENTITY_KINDS` + `proposal`, поля subject в `entities.ts`,
   `proposalSchema` в `domain-schemas.ts`, `WorkspaceState.proposals`,
   payload-схемы в `schemas.ts`, ветки `applyCommand`, `requireScope`
   с `propose`.
2. `src/server`: таблица в `schema.ts`, `npm run db:generate` (обход TTY из
   прошлых волн: см. `drizzle/v2/README.md`), прочитать SQL `0009`,
   `writeState`, загрузка состояния, маршруты чтения, `context`.
3. Экспорт: `FORMAT_VERSION = 9`, `export-upgrade.ts` для 1–8 (пустой
   список), `validateExport` воспроизводит события предложений; фикстура
   `tests/fixtures/export-schema-9.json` по образцу `export-schema-8`.
4. Веб: состояние принимает коллекцию; доска, Focus, digest и inbox
   предложения не показывают; подписи команд в `activity.tsx`; «Активность»
   скрывает `proposal.create` и `proposal.deliver`.
5. CLI: `WRITES`, `READS`, справка, флаги.
6. Скилл: исключение в правиле 6 и раздел «Предложения» по спеке 5.4 в
   `skills/taskindex/SKILL.md`, команды в `reference.md`.
7. Тесты: `tests/api/proposals.test.ts` (спека §8, сервер), строки матрицы
   прав в `tests/api/permissions.test.ts`, генератор в
   `tests/property/commands.test.ts`, `tests/cli` для флагов, миграция в
   `tests/api/migrations.test.ts`, совместимость экспорта 8 → 9.
8. `docs/plans/2026-09-08-taskindex-v2.md` §5: строки команд.

## 3. Часть Б: ночная смена, фаза 1

Каталог `scripts/night-shift/`, модули `.mts` (Node 26 исполняет их
напрямую). Логика в чистых функциях, покрытых `tests/unit`; каталог в охвате
`typecheck`, `lint`, `format:check` и `test`.

1. `audit.mts`: `auditBoard({ tasks, lastEventAt, today }) → ProposalDraft[]`
   по правилам спеки 5.2 этап 3 (дата в названии прошла → `task.archive`,
   rank 3; срок прошёл → `task.update` со сроком `today + 7`, rank 2; «Сделать»,
   не P3, без срока, 14 дней без событий → `task.archive`, rank 3; отпечатки
   `audit:dated:…`, `audit:overdue:…`, `audit:stale:…`). Архивные, `done` и
   P3 не трогаются (P3 только для третьего правила; просрочка P3 предлагается).
   `lastEventAt` по задаче из `taskindex events --all` (самое позднее событие
   с `entityKind: 'task'` и `entityId` задачи или шагов этой задачи), не из
   `updatedAt`: миграции и переименование агента двигают `updatedAt` без
   событий.
2. Запуск аудита: `taskindex snapshot`, `taskindex events --all`,
   `taskindex proposals --status queued`; при 15 в очереди новых не
   создавать; иначе `taskindex proposal create --payload` на каждый черновик,
   пока очередь не 15. Все вызовы с `TASKINDEX_AGENT=night-shift`.
3. `run.sh`: запускает аудит, пишет `last-run.json` атомарно (временный файл
   и переименование) в `${XDG_STATE_HOME:-~/.local/state}/taskindex/night-shift/`:
   `{ startedAt, finishedAt, ok, window, stages: { board: { tasks, drafts,
   created, existing, skippedByCap } }, errors: [] }`. Каталог 0700.
4. `morning.mts`: `formatMorning({ deliver, lastRun, now }) → string` и
   запуск: прочитать `last-run.json`, вызвать `taskindex proposal deliver
   --limit 5`, напечатать текст или `NO_REPLY`. Строка сбоя по спеке 5.3 п.1.
   Для текста `task_change` нужна задача: `taskindex task get` на каждую.
   Формат из спеки раздел 2 и 5.3; даты `ДД.ММ`.
5. Тесты: правила и отпечатки на фикстуре снимка; P3 и архив не трогаются;
   золотые тексты утреннего сообщения (новая задача, изменение каждого вида,
   строка сбоя, тишина `NO_REPLY`).
6. `scripts/night-shift/README.md`: что запускается, ключ, каталог
   состояния, две команды `openclaw cron add` (`night-shift:v1` 04:30 и
   `proposals-morning:v1` 10:00 Europe/Moscow, `payload.kind: command`,
   утро с `announce` в `telegram:6065935464`). Кроны ставит ведущий после
   выпуска.

## 4. Выпуск

1. Часть А сливается первой, часть Б перебазируется на неё.
2. Сквозной сценарий спеки §8 в sandbox с настоящим CLI.
3. `npm run check`, `npm run e2e`, PR, зелёный CI, `deploy/release.sh`.
4. На проде: агент `night-shift` («Ночная смена»), ключ scope `propose`,
   файл `~/.config/taskindex/night-shift.env`, мастер-копия в 1Password.
5. Кроны OpenClaw, первый прогон руками (`openclaw cron run`), проверка
   утреннего текста без доставки, потом включение.
6. `ROADMAP.md` и `BACKLOG.md` ссылаются на спеку.

## Расхождения с кодом части А

- 2026-09-25: `proposal.accept` по задаче, изменившейся после предложения, не
  отвечает `conflict`: отказ операции ничего не записывает, а итог `stale`
  сохранить нужно. Поэтому это успешная операция: предложение `stale`,
  `results[0].task: null`, `reason` «Предложение устарело: …. Задача не
  изменена.», код выхода 0; задача не меняется.
- 2026-09-25: `proposal.deliver` считает день показанным, если сегодня уже
  показано хоть одно предложение в любом статусе: повтор после ответов
  владельца не присылает новую пятёрку (решение «не больше 5 в день»);
  `shown` в ответе это ещё не решённые из сегодняшних.
- 2026-09-25: ключ `command` в `patch` меняет вид действия (спека §5.4); payload
  тогда собирается из `id` и `baseRevision` предложения и полей правки.
  `undo SEQ` одного события решения отвечает `not_undoable` (решение
  отменяется только операцией целиком), создание и показ не отменяются.
  `/api/snapshot` предложений не несёт, как и комментариев: их читают через
  `/api/proposals`.
- 2026-09-25 (ревью PR #7): по «да» выполняется только показанное. Карточка
  новой задачи в утреннем сообщении называет ещё состояние, если не
  «Очередь», «вернуться», «ждём», «закрывает» и шаги; `position`, `origin`,
  отмеченный шаг и итог шага предложение не несёт, `id` задачи допустим. `undo
  SEQ` любого события операции решения, записи задачи тоже, отвечает
  `not_undoable`; в «Активности» у частей решения своей кнопки отмены нет, в
  истории задачи отмена её записи откатывает решение целиком.
