# TaskIndex: инструкция для агентов-разработчиков

Личная доска задач одного владельца. Операторы продукта: ИИ-агенты через CLI
`taskindex` и HTTP API с ключами агентов (scope `read` | `tasks` | `write`);
владелец работает в браузере. Этот файл для агентов, которые меняют код;
правила агента-оператора: `skills/taskindex/SKILL.md`. Стек, карта кода,
запуск, стили и проверки — `README.md`; деплой и восстановление —
`deploy/README.md`.

## Окружение и проверки

- Node 26.7.0 (`.node-version`; `fnm use` / `nvm use`), `npm ci`. CLI и API
  проверять только в одноразовом sandbox: `eval "$(npm run -s sandbox)"`.
  `setup:dev` в основном чекауте не запускать: там живёт база владельца.
- Локально — typecheck, lint и тесты затронутого. Полный `npm run check`
  (typecheck, lint, unused-exports, format:check, lint:shell, build,
  check:skin, test) и e2e гоняет CI на Ready PR, push в `main` и теги `v*`.
- `npm run e2e` — Playwright на фиксированных портах; два прогона
  одновременно — только в разных слотах (`TASKINDEX_E2E_SLOT=N`). Новый
  проект Playwright вписать в `PROJECT_SERVER` (`tests/e2e/helpers.ts`) и в
  матрицу e2e в `ci.yml`.
- `CI_POOL=pc` отправляет jobs на раннеры ПК владельца
  (`winpc-taskindex-N`); там `check` идёт по частям через
  `scripts/ci-parallel-check.mjs`. При смене версии `@playwright/test`
  поменять `PLAYWRIGHT_VERSION` в `ci-runners/winpc/root-setup.sh` и
  прогнать его на winpc.
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
  `.describe()`, документация и коммиты на русском.
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
  `src/web/skin/*.css` только через `var(--…)`, без `!important`; гейт
  `npm run check:skin`.
- Новая команда: payload в `src/shared/schemas.ts` → ветка `applyCommand` →
  `WRITE_COMMANDS` в `src/cli/spec.ts` → SKILL.md → тесты. Новый GET:
  `src/server/routes/*.ts`, схема ответа в `src/shared/domain-schemas.ts`,
  запись в `READS` в `src/cli/spec.ts`.
