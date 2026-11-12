# TaskIndex: инструкция для агентов-разработчиков

Личная доска задач одного владельца. Операторы продукта: ИИ-агенты через CLI
`taskindex` и HTTP API с ключами агентов (scope `read` | `tasks` | `write`);
владелец работает в браузере. Этот файл для агентов, которые меняют код;
правила агента-оператора: `skills/taskindex/SKILL.md`. Стек, карта кода,
запуск, стили и проверки — `README.md`; деплой и восстановление —
`deploy/README.md`.

## Where this project stands in the system

TaskIndex is the home of the owner's tasks (areas, projects, steps, the Focus desk) and of
nothing else. It never keeps a second copy of what lives elsewhere: people and sign-in,
sales, custom orders and matters (what waits for a person) live in Agency Hub, accounting
in the ledger; a task links to them, it does not mirror them. The owner signs in with the
hub's one-time code («Войти через хаб», `deploy/README.md`, `src/server/hub-signin.ts`).
The classic skin takes Hub's look from `vendor/hub-look` (re-vendor from a clean hub commit
with `node scripts/vendor-look.mjs`); the «focus» skin keeps its own values. The one map of
the system is `~/code/SYSTEM.md` on the owner's machine.

## Окружение и проверки

- Node 26.7.0 (`.node-version`; `fnm use` / `nvm use`), `npm ci`. CLI и API
  проверять только в одноразовом sandbox: `eval "$(npm run -s sandbox)"`.
  `setup:dev` в основном чекауте не запускать: там живёт база владельца.
- Локально — typecheck, lint и тесты затронутого. Полный `npm run check`
  (typecheck, lint, format:check, build, test) и e2e гоняет CI на Ready PR,
  push в `main` и теги `v*`.
- Тесты — только там, где ошибка стоит данных владельца или доступа:
  команды и инварианты домена, вход и ключи агентов, миграции и бэкапы,
  идемпотентность CLI, черновики и порядок записей в браузере. Тестов на
  UI, тексты и проводку не писать.
- `npm run e2e` — смоук основных сценариев на Chromium, фиксированные порты;
  два прогона одновременно — только в разных слотах (`TASKINDEX_E2E_SLOT=N`).
- CI — только на GitHub-hosted раннерах (репа публичная). `check` идёт по частям
  через `scripts/ci-parallel-check.mjs`; PR только с документами (`*.md`,
  `docs/**`) зеленеет за секунды.
- Тесты не мокают модули: реальные SQLite `:memory:`, Hono `app.request`,
  Better Auth.

## Деплой

`bash deploy/release.sh COMMIT` из основного чекаута (коммит в
`origin/main` и зелёный push-прогон CI; пропущенный Draft его не заменяет).
Агент деплоит сам после слияния своей работы; откат, восстановление и
любые действия с данными прода — только по поручению владельца.

## Не трогать

- `data/` (база владельца), `.env`, `deploy/.runtime/`, `dist/`,
  `test-results/`, `playwright-report/`.
- Применённые миграции `drizzle/v2/*.sql`: сервер сверяет контрольные
  суммы; новая схема — новая миграция (`src/server/schema.ts` →
  `npm run db:generate` → прочитать SQL → тест
  `tests/api/migrations.test.ts`). Приложение миграции при старте не
  выполняет.
- `docs/reference/**`, `docs/audits/**` и замороженный `issues.md` (реестр
  TI-NNN): только чтение. Трекер — сама доска.
- Никаких вызовов `op` из тестов и скриптов проверки.

## Соглашения и подводные камни

- Идентификаторы, комментарии и названия тестов на английском; UI, ошибки,
  `.describe()` и документация на русском. Коммиты, имена веток и
  заголовки/описания PR — на английском.
- Ошибки только через `fail()`/`DomainError`; конверт
  `{ok:false, code, message, retryable}`. Все записи домена через
  `executeOperation`; admin пишет в базу только при остановленном
  приложении.
- CLI всегда печатает JSON; коды выхода 0/1/2/3/4; `operationId`
  обязателен и повторяется без изменений; конверт удаляется только после
  подтверждённого исхода (`src/cli/acknowledge.ts`).
- Границы: `src/shared` без `node:` и DOM; `src/cli/client.ts` не
  импортирует сервер; `src/cli/admin-run.ts` — единственный файл CLI с
  импортами из `src/server`.
- Стили: токены `src/web/tokens.css`, примитивы `src/web/ui`, скин
  `src/web/skin/*.css` через `var(--…)`.
- Ключ хаба агента (`agency_hub_agent_…`, `src/server/hub-agent-keys.ts`):
  проверяется в хабе только по sha256 своим ключом TaskIndex
  (`HUB_INTROSPECT_KEY`, право `introspect:agent_keys`) и работает как
  агент из таблицы владельца `HUB_AGENTS` с её правом; кода нет — 403, без
  ключа — не принимается. Проверка ключа в базу не пишет: аудит — строка
  журнала `hub_agent_call`. Права — `tests/api/hub-agent-keys.test.ts`.
- Новая команда: payload в `src/shared/schemas.ts` → ветка `applyCommand` →
  `WRITE_COMMANDS` в `src/cli/spec.ts` → SKILL.md → тесты. Новый GET:
  `src/server/routes/*.ts`, схема ответа в `src/shared/domain-schemas.ts`,
  запись в `READS` в `src/cli/spec.ts`.
