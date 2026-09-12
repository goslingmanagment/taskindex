# TaskIndex v2: инструкция для агентов-разработчиков

Личная доска задач одного владельца. Основные операторы продукта: ИИ-агенты
(Claude Code, Codex) через CLI `taskindex` и HTTP API с ключами агентов
(scope `read` | `tasks` | `write`). Владелец работает в браузере и проверяет
работу агентов. Этот файл для агентов, которые меняют код; правила для
агентов-операторов лежат в `skills/taskindex/SKILL.md`. `AGENTS.md` это
символическая ссылка на этот файл.

Истина по объёму и решениям: `docs/plans/2026-09-08-taskindex-v2.md`.
Отложенное: `BACKLOG.md`. Деплой и восстановление: `deploy/README.md`.

## Реестр находок и планы

- `issues.md` в корне репозитория это единственный реестр статусов и
  приоритетов: карточки `TI-NNN` со статусом, критерием закрытия и решением
  владельца. Шкала приоритетов везде одна, шкала реестра: P1 до рабочего
  запуска, P2 функциональные дефекты и существенные риски, P3 улучшения.
- Планы работ после ревью: `docs/plans/2026-09-08-v2-review/README.md`
  (планы Fable `01`…`13`) и `docs/plans/2026-09-08-v2-review/ASTRA-INDEX.md`
  (планы Astra `astra-01`…`astra-34`). Перед реализацией подсистемы
  выбирается один план из двух наборов; второй служит чек-листом
  «Проверки при реализации». Два плана не разрешают переделать подсистему
  дважды.
- Перед исправлением прочитать карточку целиком; после исправления статус
  карточки обновляется с revision и названием теста. Namespace обязателен:
  `Astra:B-01` и `FB:B-01` это разные находки. Новая находка сначала
  становится карточкой, потом работой.
- Если план расходится с кодом, верить коду и дописать в план одну
  датированную строку-примечание.

## Окружение

- Node строго 26.7.0 (`.node-version`, `.nvmrc`); `engines` в `package.json`
  задаёт границу `>=26.0.0 <27` (нижняя: tsdown объявляет `>=26.0.0`, а
  better-sqlite3 12.11 поставляет готовый бинарник для ABI 147; переход с
  24 на 26 описан в TI-084). Сначала `node --version`: имя каталога
  менеджера версий само по себе не подтверждает версию. На Mac владельца
  системный `node` (Homebrew и `~/.hermes`) сейчас даёт 26.7.0, отдельный
  runtime не нужен; при обновлении системного Node на другой мажор
  переключение через `fnm use` или `nvm use` в корне репозитория (читают
  `.node-version`). `npm run check`, `npm test`, `npm run dev`,
  `npm run e2e` и `npm run sandbox` сами проверяют версию
  (`scripts/preflight.mjs`) и под другой мажорной версией останавливаются
  с русским сообщением и кодом 1.
- `npm ci`, не `npm install`. `.npmrc` включает `engine-strict`, поэтому
  `npm ci` под другой мажорной версией останавливается с `EBADENGINE`.
- Одноразовое окружение для любых проверок CLI и API:
  `eval "$(npm run -s sandbox)"` поднимает сервер на свободном порту с
  временной базой в `$TMPDIR` и экспортирует `TASKINDEX_URL`,
  `TASKINDEX_TOKEN` (агент `claude`, scope `write`), `XDG_STATE_HOME`,
  `TASKINDEX_SANDBOX`. Второй ключ: `npm run -s sandbox -- --token codex`
  (scope `tasks`). Пароль владельца для входа в браузере: `owner.json` в
  каталоге sandbox. Остановка и удаление: `npm run sandbox -- --stop`
  (`--keep` оставляет каталог для разбора). Ключи sandbox не секрет, но
  годятся только для этой базы. Никогда не направлять CLI на рабочий сервер
  во время разработки.
- `npm run setup:dev` создаёт `.env` и `data/dev.db` в текущем чекауте. Это
  долгоживущее окружение владельца для ручной разработки в браузере, не для
  проверок. В основном чекауте `.env` и `data/dev.db` уже существуют: не
  запускать `setup:dev` там.

## Правило worktree

Любые правки кода только в отдельном `git worktree` на своей ветке
(`git worktree add ../.worktrees/taskindex-<тема> -b <тема>`). Основной
чекаут `~/code/taskindex` только для чтения, ops и релизных операций
(deploy-скрипты требуют main-чекаут). Поверх `main` без ветки не работать.
После мерджа или отказа: `git worktree remove` и удаление ветки. В конце
сессии с worktree: `git worktree list`. Коммит и push только по слову
владельца.

## Не трогать

- `data/` (личная база `dev.db` владельца), `.env`, `deploy/.runtime/`
  (состояние деплоя на VPS), `dist/`, `tsconfig.tsbuildinfo`, `test-results/`,
  `playwright-report/`.
- Применённые миграции `drizzle/v2/*.sql` не редактируются (сервер сверяет
  контрольные суммы применённого SQL; новая схема это новая миграция).
  `drizzle/v2/meta/*` генерируется `npm run db:generate`, руками не правится.
- `docs/reference/**` (визуальный эталон и артефакты проверки с sha256) и
  `docs/audits/**` (артефакты аудитов): только чтение. `npm run e2e` пишет
  артефакты в `test-results/e2e-artifacts/`; в `docs/reference/v2-validation/`
  только явно, `TASKINDEX_E2E_ARTIFACT_DIR=docs/reference/v2-validation`.
- `issues.md` правит только тот, кто закрывает карточку, и только статусы.
- Архив прежних данных `~/Backups/taskindex/…` (см. README). Секреты только
  через `op`; никаких вызовов `op` из тестов и скриптов проверки.

## Проверки

- `npm run check` = `tsc --noEmit`, `oxlint`, `oxfmt --check`,
  `npm run lint:shell` (`bash -n` и `shellcheck -S warning` по `deploy/*.sh`,
  без shellcheck пропускается с сообщением), `vitest run` (несколько секунд).
  Запускать перед каждым сообщением о готовности; вывод ошибок и тестов
  приводить целиком. `npm run format` чинит форматирование.
- `npm run e2e` (Playwright, нужен `npx playwright install chromium`;
  поднимает `tests/e2e/server.ts` на портах 4173 и 4001, изолированная
  SQLite в `/tmp`). Порты фиксированы: два прогона одновременно не работают.
- `bash deploy/local-drill.sh` (нужен Docker) репетирует деплой, откат и
  восстановление локально; к VPS и S3 не подключается.
  `bash deploy/drill/deploy-drill.sh` (~6–8 минут, на macOS сам заворачивается
  в Linux-контейнер) прогоняет настоящий `deploy.sh` поверх релиза, поставленного
  `deploy/bootstrap.sh`; `--only plan,before-stop` — отдельные фазы.
- `npm run unused-exports` — экспорты `src/**`, которые никто не импортирует
  (`tsc` их не видит): «мёртвые» удалять, «только для тестов» помечать
  `/** @internal for tests */`. В `check` не входит, пока список не пуст.
- `node scripts/gate.mjs` — локальный гейт релиза: те же команды и в том же
  порядке, что job `check` в CI, плюс отчёт `test-results/gate.json`
  (`--image` собирает образ, `--strict` отказывает при грязном дереве).
- `npm run build` проверяет сборку `dist/web`, `dist/server`, `dist/cli`.
- Каждый баг сначала получает регрессионный тест, который падает на текущем
  коде; потом исправление.

## Стили

Три слоя: токены (`src/web/tokens.css`, единственное место с литералами цветов),
примитивы (`src/web/ui/*`, `src/web/vendor/shadcn-base.css`, руками не
редактируются) и скин (`@layer skin` в `src/web/styles.css`, только `var(--…)`,
без `!important`). В примитив скин заходит через `[data-slot='…']`, не через
`.wrapper button`. Правила и порядок действий — раздел «Стили» в `README.md`.

## Карта кода

- `src/shared`: `schemas.ts` (payload команд, `commandPayloadSchemas`,
  union конвертов), `domain-schemas.ts` (сущности, события, ответы
  `operationSuccessSchema`/`operationErrorSchema`/`storedOperationSchema`),
  `commands.ts` (`applyCommand`, `applyEvent`, undo, sync, инварианты),
  `queries.ts` (Focus, поиск, фильтры), `model.ts` (типы из `z.infer`),
  `errors.ts` (`DomainError`, `fail`). Не импортирует ни `node:`, ни DOM.
- `src/server`: `app.ts` (маршруты, OpenAPI, `context`, `digest`, health),
  `operations.ts` (одна транзакция на операцию: состояние, события,
  сохранённый ответ), `db.ts` (миграции с контрольными суммами, чтение,
  запись), `auth.ts` (Better Auth: пароль и passkey владельца),
  `agent-keys.ts` (своя таблица ключей агентов), `admin.ts` (владелец,
  агенты, export/import, `mark-restored`, `open-writes`), `schema.ts`
  (Drizzle), `sse.ts`, `config.ts` (окружение на Zod: `BUILD`, `LOG_LEVEL`,
  `HOST`, пути), `log.ts` (структурный лог), `static.ts`, `index.ts`
  (`serve`, SIGTERM).
- `src/cli`: `spec.ts` (единственный источник команд: `READS`, `WRITES`,
  `SERVICE`, флаги; флаги записи выводятся из `commandPayloadSchemas`),
  `help.ts` (`renderHelp`: обзор, группа, команда), `run.ts` (разбор argv и
  `dispatch`), `session.ts` (клиент, состояние, очередь, `currentGeneration`),
  `reads.ts` (путь чтения, `--all` с перезапуском при 409, `--since last`,
  `--commit`, `events --follow`), `writes.ts` (payload из флагов, конверт,
  `--confirm-owner-fields`), `operations.ts` (`operation list|resume`),
  `cursor.ts` (`cursor show|commit|reset`), `errors.ts` (русские `issues`,
  `HINTS`, `withHints`), `client.ts` (один транспорт `fetch`, повторы, коды
  выхода; не импортирует `src/server`), `acknowledge.ts` (одно правило
  «исход → код выхода → конверт»), `outbox.ts` (конверты, карантин
  `*.corrupt`), `state.ts` (каталог по серверу и агенту, кэш идентичности по
  хешу ключа, `cursor.json`), `arguments.ts`, `admin-run.ts`
  (`taskindex-admin`, прямой доступ к базе; единственный файл CLI с
  импортами из `src/server`).
- `src/web/app`: `store.ts` (единый store, очередь операций), `sync.ts`
  (SSE), `drafts.ts`, `api.ts`, `url.ts`, компоненты `shell`, `board`,
  `card`, `editor`, `dialogs`, `activity`, `sidebar`, `overview`;
  `src/web/ui`: примитивы shadcn/Base UI; `src/web/lib`, `src/web/hooks`.
- `tests/{unit,api,property,web,cli}` (vitest), `tests/e2e` (Playwright),
  `scripts/` (`dev`, `setup-dev`, `preflight`, `sandbox`), `deploy/`
  (Dockerfile, compose, nginx, litestream, deploy/rollback/drill),
  `skills/taskindex/SKILL.md` (правила агента-оператора).

## Как добавить команду

Полный чек-лист: `docs/plans/2026-09-08-v2-review/04-api-contract-and-schemas.md`,
раздел 3.8. Кратко: payload в `src/shared/schemas.ts` (union и имена команд
собираются сами) → ветка в `applyCommand` с правами и правилами undo/sync →
подписи и описания (`tsc` не пройдёт без них) → запись в `WRITE_COMMANDS`
в `src/cli/spec.ts` (`tsc` требует её для каждого `CommandName`; флаги и
справка строятся из схемы сами) → SKILL.md → тесты
`tests/api/commands.test.ts`, `tests/property`, `tests/cli` → строка в плане v2
§5 → `npm run check`.

## Как добавить миграцию

Правка `src/server/schema.ts` → `npm run db:generate` → прочитать SQL в
`drizzle/v2/<n>_<имя>.sql` → версия схемы выводится из цепочки миграций
(`schemaVersion()` в `src/server/db.ts`), тест `tests/api/migrations.test.ts`
→ прогнать миграцию на копии старой базы (`cp data/dev.db /tmp/x.db`,
`DATABASE_PATH=/tmp/x.db npm run db:migrate`) → `npm run check`. Уже
применённые миграции не редактируются: сервер сверяет их контрольные суммы.
Приложение миграции при старте не выполняет: образ требует точного
совпадения версии схемы с базой.

## Как добавить GET-маршрут

`createRoute` в `src/server/app.ts` (после плана 06: `src/server/routes/*`) с
`.describe()` на каждом query-параметре; схема ответа в
`src/shared/domain-schemas.ts`; пагинация через `page()`; запись в `READS`
в `src/cli/spec.ts` (`route` в форме OpenAPI, `query` с каждым параметром:
тест `tests/cli/help.test.ts` сверяет их с `/api/openapi.json`); SKILL.md при
необходимости.

## Соглашения

- Идентификаторы, комментарии и названия тестов на английском; UI, ошибки,
  `.describe()`, документация и сообщения коммитов на русском.
- Ошибки только через `fail()`/`DomainError`; конверт ответа
  `{ok:false, code, message, retryable}`.
- CLI всегда печатает JSON (флаг `--json` удалён, TI-033); коды выхода
  0/1/2/3/4; `operationId` обязателен и повторяется без изменений; конверт
  не переписывается; конверт удаляется только после подтверждённого исхода
  своей операции (`src/cli/acknowledge.ts`).
- Все записи домена только через `executeOperation`; admin пишет в базу
  только при остановленном приложении.
- Тесты не мокают модули: реальные SQLite `:memory:`, Hono `app.request`,
  Better Auth; DI через `AppOptions`, `CliOptions`, `WorkspaceStore`.
- Переменная сборки `BUILD`; `LOG_LEVEL` читается `src/server/config.ts`
  (TI-020).
- Один коммит на карточку; в первой строке `TI-NNN`.

## Деплой

Только с VPS из чистого основного чекаута:
`op run --env-file=/protected/taskindex.env -- bash deploy/deploy.sh COMMIT`.
`deploy.sh --plan` печатает JSON плана и ничего не меняет; первая установка —
`deploy/bootstrap.sh`. Секреты только через `op`. После `open-writes` автоматический откат запрещён;
восстановление по `deploy/README.md`. Агент деплой не запускает без явного
поручения владельца.

## Стиль ответов владельцу

Лаконично, результат первой фразой, без вводных и итоговых резюме; не
пересказывать то, что владелец видит сам. Просит подробно: подробно. Ошибки и
вывод тестов приводить целиком. Сабагенты наследуют модель сессии (Fable);
масштаб и цену большого фан-аута озвучивать до запуска.
