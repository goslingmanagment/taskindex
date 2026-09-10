# Готовность к работе через ИИ-агентов: CLAUDE.md и AGENTS.md, проверка Node, sandbox, скилл, исполняемый агентский цикл, дрейф документации

Статус: предложение, 2026-09-08. Источник: сводное ревью v2 (см. `README.md` в этой папке).
Приоритет: P0 для шагов 1-4 (`CLAUDE.md`/`AGENTS.md`, `preflight`, `sandbox.mjs`): без них агент-разработчик с нулевым контекстом стартует под Node 26 и пишет `.env` и `data/dev.db` в основной чекаут. P1 для остального. Оценка: M, 2.5-3 дня: 0.5 дня инструкция и preflight, 1 день sandbox и агентский цикл, 0.5 дня скилл и тест «скилл против справки», 0.5 дня дрейф документации, пометки сгенерированных файлов и `noUnusedLocals`. Зависимости: `03-cli-outbox-and-ergonomics.md` (спецификация команд для теста скилла, `me`, `cursor`, `inbox`, путь outbox), `02-agent-permissions-and-sync-semantics.md` (политика undo и focus для SKILL.md), `04-api-contract-and-schemas.md` (чек-лист «как добавить команду», `issues`), `06-server-structure-config-logging.md` (`LOG_LEVEL`, `SCHEMA_VERSION`, миграции), `10-code-quality-and-tests.md` (артефакты e2e в `test-results/`).

## 1. Проблема

Все ссылки проверены по текущему дереву 2026-09-08.

### 1.1 B1: нет инструкции для агента-разработчика, ловушка Node 26

- `ls CLAUDE.md AGENTS.md .claude .codex .github` → ни одного файла или каталога.
- Версии Node: `.nvmrc` = `24`, `.node-version` = `24.20.0`, `package.json:6` `engines: ">=24.11.0 <25"`, `deploy/Dockerfile:1,11` `node:24.20.0-bookworm`, `README.md:36` «Нужны Node **24.20.0**». Три разных пина в трёх местах. Системный `node --version` на этом Mac → `v26.7.0`; рабочий Node 24.20.0 лежит только в `/private/tmp/taskindex-v2-tools/node-v24.20.0-darwin-arm64/bin` (`BACKLOG.md:19-27`). Ничто не останавливает `npm test` под 26: падение приходит из `better-sqlite3` при загрузке нативного модуля без слов о версии.
- Глобальные правила владельца (`~/.claude/CLAUDE.md`: любые правки только в git worktree, основной чекаут только чтение и ops, коммит по слову владельца, сабагенты на Fable, лаконичные ответы) в репозитории не продублированы; Codex их не видит.
- `npm run setup:dev` (`scripts/setup-dev.mjs:7-20`) создаёт `.env` в корне чекаута и мигрирует `./data/dev.db`; в основном чекауте `.env` и `data/dev.db` уже существуют (mtime 16:31 и 16:47 2026-09-08), поэтому агент, «настроивший окружение», работает с личной базой владельца.

### 1.2 B2: нет одноразового окружения одной командой

Для проверки CLI ревью готовности собирало цепочку вручную (`reports/review-5-ai-ready.md`, раздел (g)): `admin migrate` → `create-owner` (пароль через stdin) → `agent create` ×2 → `agent-key create --out` → сервер с `DATABASE_PATH/PORT/BASE_URL/BETTER_AUTH_SECRET`. `tests/e2e/server.ts:11-31` поднимает временную базу с владельцем, но без агентов и ключей и вместе с Vite. Функции для всего этого есть: `initialize`, `createOwner`, `createAgent`, `createAgentKey` (`src/server/admin.ts:27,34,105,143`), `createApp` и `createAuth`.

### 1.3 A13: скилл без установки, окружения, примеров ответов и политики undo

`skills/taskindex/SKILL.md` (63 строки) точен по всем упомянутым командам (сверено ревью качества §8 и готовности A13), но: frontmatter только `name`/`description`; способа установки ни для Claude Code, ни для Codex (план §3 обещает симлинк в `~/.claude/skills`, `BACKLOG.md:82-83` требует «установить скилл в обе среды», `README.md:82` отсылает к скиллу); нет строки с `op run`/`op read` для `TASKINDEX_TOKEN`; нет примеров ответов (`task get → --base-revision`, `conflict`, `resume`); нет `tasks --today` (потому что его нет в CLI, план 03); нет политики undo (план 02); нет кодов ошибок CLI (`invalid_arguments`, `client_error`, `network_error`, `invalid_response`; ревью качества §5).

### 1.4 `tests/e2e/agent-cycle.md` не исполняем

Файл (38 строк, семь шагов) лежит в каталоге тестов, но это прозаический чек-лист; `README.md`, `BACKLOG.md:82` и `deploy/README.md:74` называют его приёмкой. Автоматизировано частично: шаг 5 (потеря ответа после commit) в `tests/cli/agent-cycle.test.ts:52-110`, шаг 6 (503 при `held`) в `tests/cli/cli.test.ts:146-181`, часть шага 4 (`tasks` не отменяет `project.update`) в `tests/api/commands.test.ts:250-300`. Шаги 1-3 и 7 ручные.

### 1.5 B6: дрейф документации

| Что | Где написано | Что в коде | Правка |
|---|---|---|---|
| `LOG_LEVEL` | `deploy/.env.example:7`, `deploy/compose.yml:15`, план §12 (строка «Переменные: … `LOG_LEVEL`») | `grep -rn LOG_LEVEL src` → 0 | план 06 решает: читать или убрать; здесь пометка в плане и `.env.example` «пока не используется» |
| `--json` | `run.ts:63,91`, план §10 «`--json` (по умолчанию, если stdout не терминал)» | никогда не читается, вывод всегда JSON (`run.ts:194`) | план 03 удаляет флаг; здесь текст плана §10 |
| `events --since N` | `HELP` `run.ts:48` без `--generation` | `run.ts:223-230` требует `--generation` при `N > 0` | план 03 генерирует справку; здесь SKILL.md и план §10 |
| Пины Node | README 24.20.0, `engines >=24.11.0 <25`, `.nvmrc` `24`, `.node-version` 24.20.0 | `nvm use` по `.nvmrc` даст последний 24.x | `.nvmrc` → `24.20.0`; README: «24.20.0 закреплён; `engines` задаёт нижнюю границу 24.11 из-за tsdown» |
| `--password-op op://…` | `admin-run.ts:41-42,67-83` | README:49-58 описывает только stdin | добавить в README одну строку |
| `TIMEZONE` | `deploy/.env.example:6`, `compose.yml:14`, `setup-dev.mjs:15`, README как переменная сервера | читает только `admin-run.ts:94` при `migrate`; сервер берёт `settings.timezone` (`app.ts:187`), записанный один раз (`db.ts:91-92`) | README и `.env.example`: «влияет только на первую миграцию; далее хранится в базе» |
| `tests/e2e/agent-cycle.md` как приёмка | `BACKLOG.md:82`, `deploy/README.md:74` | прозаический чек-лист | переезд в `docs/acceptance/agent-cycle.md` и `scripts/agent-cycle.mts`, ссылки обновить |
| Установка скилла | план §3 «симлинк в ~/.claude/skills», `BACKLOG.md:83`, `README.md:82` | инструкции нет | раздел «Установка» в SKILL.md и README |
| `BUILD` и `BUILD_ID` | `src/server/index.ts:22` | два имени одной переменной | план 06 (`server/config.ts`); здесь только упоминание в CLAUDE.md, что истина `BUILD` |
| Артефакты e2e | `tests/e2e/workspace.spec.ts:10-11` | пишутся в `docs/reference/v2-validation` по умолчанию | план 10; здесь do-not-touch и `TASKINDEX_E2E_ARTIFACT_DIR` в CLAUDE.md |

### 1.6 B8: сгенерированные файлы не помечены

`drizzle/v2/meta/0000_snapshot.json` и `_journal.json` создаются `npm run db:generate` (`drizzle-kit`), README в `drizzle/v2` нет. `docs/reference/v2-validation/screenshots-sha256.json` и `environment.json` пишутся e2e (`workspace.spec.ts:13-30`, `:348-351`). `docs/audits/**` это артефакты аудитов (логи, JSON, скрипты проб). `.gitattributes` отсутствует.

### 1.7 B7: неиспользуемый код не сигнализируется

`tsconfig.json:2-22` без `noUnusedLocals` и `noUnusedParameters`; `.oxlintrc.json:12-14` только категория `correctness`. `serverId` в `src/cli/outbox.ts:143-146` не используется (план 03 начинает его использовать). Категории oxlint и остальные правила в плане 10.

### 1.8 B9: язык

`.describe()`, сообщения сервера, UI, документация на русском; Zod-ошибки CLI на английском (`run.ts:456`). Модели читают русский свободно; проблема только в смешении. Устраняется `z.config(z.locales.ru())` в CLI (план 03) и на сервере (план 04).

### 1.9 Побочный эффект ревью: e2e перезаписал `docs/reference/v2-validation/`

`tests/e2e/workspace.spec.ts:10-11`: `artifacts = process.env.TASKINDEX_E2E_ARTIFACT_DIR ?? 'docs/reference/v2-validation'`; `:13-30` пишет `screenshots-sha256.json`, `:348-351` пишет `environment.json`, `:247,440-475` пишут PNG. Ревью по багам запустило `npm run e2e` в 20:15 2026-09-08 (`scratchpad/e2e.log`, mtime 20:15:44); текущие файлы в каталоге датированы 20:40-20:41, `environment.json.capturedAt` = `2026-09-08T17:40:55.778Z` (20:40 по Москве), то есть после этого был ещё как минимум один прогон. Каталог `docs/reference/` целиком не отслеживается git (`git status` → `?? docs/reference/`), поэтому перезапись не видна в диффе, а прежние снимки от 17:15 невосстановимы. Исправление умолчания (`test-results/`, публикация в `docs/` только флагом) в плане 10; здесь каталог входит в список do-not-touch и `CLAUDE.md` требует `TASKINDEX_E2E_ARTIFACT_DIR=test-results/e2e` до мерджа плана 10.

## 2. Цель и критерии приёмки

1. `CLAUDE.md` в корне с содержанием раздела 3.1; `AGENTS.md` это символическая ссылка на `CLAUDE.md` (Codex читает `AGENTS.md`). Проверка: `cat AGENTS.md` печатает то же; `git ls-files -s AGENTS.md` показывает режим `120000`.
2. `node scripts/preflight.mjs` под Node 26 завершается кодом 1 за доли секунды с русским сообщением о требуемой версии и способе переключения; под 24.20.0 молчит и возвращает 0. Подключён как `precheck`, `pretest`, `predev`, `pree2e`; `.npmrc` содержит `engine-strict=true`, так что `npm ci` под Node 26 останавливается с `EBADENGINE`. Тест: `tests/unit/preflight.test.ts` запускает скрипт дочерним процессом с подменённым `process.versions.node` через `NODE_OPTIONS`? Нет: версия не подменяется; тест вызывает экспортированную функцию `checkNode('26.7.0', engines)` → `{ok:false, message}` и `checkNode('24.20.0')` → `{ok:true}`.
3. `eval "$(npm run -s sandbox)" && npm run cli -- digest` из чистого worktree без `.env` печатает digest с кодом 0; `npm run sandbox -- --stop` останавливает сервер и удаляет каталог; в основном чекауте после этого `git status` не показывает новых файлов, `data/` и `.env` не тронуты.
4. `npm run agent-cycle` поверх sandbox выполняет автоматизируемые шаги 1, 2, 4, 6 (и 5 ссылкой на vitest) и печатает отчёт JSON `{step, ok, operationIds, details}`; ручные шаги 3 и 7 описаны в `docs/acceptance/agent-cycle.md` с пометкой «автоматизировано» у остальных.
5. SKILL.md содержит разделы «Установка», «Окружение», «Примеры» (пять примеров с ожидаемым JSON), «Отмена и focus» (политика плана 02), «Восстановление» (409, `status: unknown`, `generation_changed`), «Коды ошибок» (серверные и CLI); тест `tests/cli/skill.test.ts` проверяет, что каждая команда `taskindex <group> [<action>]` и каждый флаг `--x` из SKILL.md есть в справке CLI.
6. Дрейф из 1.5 устранён в документах этого плана (README, `.env.example`, план §10/§12/§3, `deploy/README.md`, `BACKLOG.md`); `.nvmrc` = `24.20.0`.
7. `drizzle/v2/README.md` создан; `.gitattributes` помечает `drizzle/v2/meta/**`, `docs/reference/**/*-sha256.json`, `docs/reference/**/environment.json`, `docs/audits/**` как `linguist-generated`; `CLAUDE.md` перечисляет их в do-not-touch.
8. `tsconfig.json` содержит `noUnusedLocals: true`, `noUnusedParameters: true`; `npm run check` зелёный.
9. Порядок работ по чек-листу (f) записан в разделе 3.6 с привязкой к планам.

## 3. Решение

### 3.1 `CLAUDE.md` (полное содержание)

```markdown
# TaskIndex v2: инструкция для агентов-разработчиков

Личная доска задач одного владельца. Основные операторы продукта: ИИ-агенты
(Claude Code, Codex) через CLI `taskindex` и HTTP API с ключами агентов
(scope `read` | `tasks` | `write`). Владелец работает в браузере и проверяет
работу агентов. Этот файл для агентов, которые меняют код; правила для
агентов-операторов лежат в `skills/taskindex/SKILL.md`.

Истина по объёму и решениям: `docs/plans/2026-09-08-taskindex-v2.md`.
Планы работ после ревью: `docs/plans/2026-09-08-v2-review/README.md`.
Отложенное: `BACKLOG.md`. Деплой и восстановление: `deploy/README.md`.

## Окружение

- Node строго 24.20.0 (`.node-version`, `.nvmrc`). Сначала `node --version`.
  На этом Mac системный `node` это 26.x, с ним `better-sqlite3` не загружается.
  Переключение: `fnm use` или `nvm use` в корне репозитория; до настройки
  постоянного Node 24 (см. BACKLOG) рабочая копия лежит в
  `/private/tmp/taskindex-v2-tools/node-v24.20.0-darwin-arm64/bin`
  (`export PATH=<этот путь>:$PATH`). `npm run check`, `npm test`, `npm run dev`
  и `npm run e2e` сами проверяют версию (`scripts/preflight.mjs`).
- `npm ci`, не `npm install`. `.npmrc` включает `engine-strict`.
- Одноразовое окружение для любых проверок CLI и API:
  `eval "$(npm run -s sandbox)"` печатает и экспортирует `TASKINDEX_URL`,
  `TASKINDEX_TOKEN` (агент `claude`, scope `write`), `XDG_STATE_HOME`,
  `TASKINDEX_SANDBOX`. Второй ключ: `npm run -s sandbox -- --token codex`
  (scope `tasks`). Остановка и удаление: `npm run sandbox -- --stop`.
  Никогда не направлять CLI на рабочий сервер во время разработки.
- `npm run setup:dev` создаёт `.env` и `data/dev.db` в текущем чекауте. Это
  долгоживущее окружение владельца для ручной разработки в браузере, не для
  проверок. В основном чекауте `.env` и `data/dev.db` уже существуют: не
  запускать `setup:dev` там.

## Правило worktree

Любые правки кода только в отдельном `git worktree` на своей ветке
(`git worktree add ../taskindex-<тема> -b <тема>`). Основной чекаут
`~/code/taskindex` только для чтения, ops и релизных операций (deploy-скрипты
требуют main-чекаут). Поверх `main` без ветки не работать. После мерджа или
отказа: `git worktree remove` и удаление ветки. В конце сессии с worktree:
`git worktree list`. Коммит и push только по слову владельца.

## Не трогать

- `data/` (личная база `dev.db` владельца), `.env`, `deploy/.runtime/`
  (состояние деплоя на VPS), `dist/`, `tsconfig.tsbuildinfo`, `test-results/`,
  `playwright-report/`.
- Применённые миграции `drizzle/v2/*.sql` не редактируются (новая схема это
  новая миграция). `drizzle/v2/meta/*` генерируется `npm run db:generate`,
  руками не правится (`drizzle/v2/README.md`).
- `docs/reference/**` (визуальный эталон и артефакты проверки с sha256) и
  `docs/audits/**` (артефакты аудитов): только чтение. До мерджа плана 10
  `npm run e2e` по умолчанию пишет скриншоты в `docs/reference/v2-validation/`:
  запускать e2e только с `TASKINDEX_E2E_ARTIFACT_DIR=test-results/e2e`.
- Архив прежних данных `~/Backups/taskindex/…` (см. README).

## Проверки

- `npm run check` = `tsc --noEmit`, `oxlint`, `oxfmt --check`, `vitest run`
  (около 2 с). Запускать перед каждым сообщением о готовности; вывод ошибок
  и тестов приводить целиком.
- `npm run e2e` (Playwright, нужен `npx playwright install chromium`; поднимает
  `tests/e2e/server.ts` на портах 4173 и 4001, изолированная SQLite в `/tmp`).
- `bash deploy/local-drill.sh` (нужен Docker) репетирует деплой, откат и
  восстановление локально; к VPS и S3 не подключается.
- `npm run build` проверяет сборку `dist/web`, `dist/server`, `dist/cli`.

## Карта кода

- `src/shared`: `schemas.ts` (payload команд, `commandPayloadSchemas`,
  union конвертов), `domain-schemas.ts` (сущности, события, ответы),
  `commands.ts` (`applyCommand`, `applyEvent`, undo, sync, инварианты),
  `queries.ts` (Focus, поиск, фильтры), `model.ts` (типы из `z.infer`,
  `SCHEMA_VERSION`), `errors.ts` (`DomainError`, `fail`), `limits.ts`.
  Не импортирует ни `node:`, ни DOM.
- `src/server`: `app.ts` (маршруты, SSE, `context`, `digest`),
  `operations.ts` (одна транзакция на операцию), `db.ts` (миграции, чтение,
  запись), `auth.ts` (Better Auth, ключи агентов), `admin.ts` (владелец,
  агенты, export/import, `mark-restored`, `open-writes`), `schema.ts`
  (Drizzle), `index.ts` (env, `serve`, статика, SIGTERM).
- `src/cli`: `run.ts` (диспетчер), `spec.ts` (команды и флаги, из них
  строится справка), `client.ts` (повторы, коды выхода), `outbox.ts` и
  `state.ts` (конверты по серверу и агенту, курсор), `admin-run.ts`
  (`taskindex-admin`, прямой доступ к базе).
- `src/web/app`: `store.ts` (единый store, очередь операций),
  `sync.ts` (SSE), `drafts.ts`, `api.ts`, `url.ts`, компоненты `shell`,
  `board`, `card`, `editor`, `dialogs`, `activity`, `sidebar`; `src/web/ui`:
  примитивы shadcn/Base UI.
- `tests/{unit,api,property,web,cli}` (vitest), `tests/e2e` (Playwright),
  `scripts/` (`dev`, `setup-dev`, `preflight`, `sandbox`, `agent-cycle`),
  `deploy/` (Dockerfile, compose, nginx, litestream, deploy/rollback/drill).

## Как добавить команду

Полный чек-лист: `docs/plans/2026-09-08-v2-review/04-api-contract-and-schemas.md`,
раздел 3.8. Кратко: payload в `src/shared/schemas.ts` (union и имена команд
собираются сами) → ветка в `applyCommand` с правами и правилами undo/sync →
подпись в `labels` (`tsc` не пройдёт без неё) → запись в `src/cli/spec.ts` →
SKILL.md → тесты `tests/api/commands.test.ts`, `tests/api/permissions.test.ts`,
`tests/property`, `tests/cli` → строка в плане §5 → `npm run check`.

## Как добавить миграцию

Правка `src/server/schema.ts` → `npm run db:generate` → прочитать SQL в
`drizzle/v2/<n>_<имя>.sql` → поднять `SCHEMA_VERSION` в `src/shared/model.ts`
(тест `tests/api/migrations.test.ts` требует соответствия журналу, см. план 06)
→ прогнать миграцию на копии старой базы (`cp data/dev.db /tmp/x.db`,
`DATABASE_PATH=/tmp/x.db npm run db:migrate`) → `npm run check`. Уже
применённые миграции не редактируются. Приложение миграции при старте не
выполняет: образ требует точного совпадения `SCHEMA_VERSION` с базой.

## Как добавить GET-маршрут

`createRoute` в `src/server/app.ts` (после плана 06: `src/server/routes/*`) с
`operationId`, `summary`, `tags` и `.describe()` на каждом query-параметре;
схема ответа в `src/shared/domain-schemas.ts` с `.meta({ id })`; пагинация
через `page()`; запись в `src/cli/spec.ts` `READS` (тест `tests/cli/help.test.ts`
сверяет параметры с `/api/openapi.json`); SKILL.md при необходимости.

## Соглашения

- Идентификаторы, комментарии и названия тестов на английском; UI, ошибки,
  `.describe()`, документация на русском. Zod-ошибки локализованы
  `z.config(z.locales.ru())` и в CLI, и на сервере.
- Ошибки только через `fail()`/`DomainError`/`errorBody()`; конверт
  `{ok:false, code, message, retryable, issues?}`.
- CLI всегда печатает JSON; коды выхода 0/1/2/3/4; `operationId` обязателен и
  повторяется без изменений; конверт не переписывается.
- Все записи домена только через `executeOperation`; admin пишет в базу
  только при остановленном приложении.
- Тесты не мокают модули: реальные SQLite `:memory:`, Hono `app.request`,
  Better Auth; DI через `AppOptions`, `CliOptions`, `WorkspaceStore`.
- Переменная сборки `BUILD` (не `BUILD_ID`).

## Деплой

Только с VPS из чистого основного чекаута:
`op run --env-file=/protected/taskindex.env -- bash deploy/deploy.sh COMMIT`.
Секреты только через `op`. После `open-writes` автоматический откат запрещён;
восстановление по `deploy/README.md`. Агент деплой не запускает без явного
поручения владельца.

## Стиль ответов владельцу

Лаконично, результат первой фразой, без вводных и итоговых резюме; не
пересказывать то, что владелец видит сам. Просит подробно: подробно. Ошибки и
вывод тестов приводить целиком. Сабагенты наследуют модель сессии (Fable);
масштаб большого фан-аута озвучивать до запуска.
```

`AGENTS.md`: `ln -s CLAUDE.md AGENTS.md` (относительная ссылка, чтобы работала в любом worktree и в WSL2 на `winpc`). Альтернатива «копия» отвергнута: два файла расходятся; альтернатива «`AGENTS.md` как основной файл» равнозначна, выбран `CLAUDE.md` как основной, потому что Claude Code это основной инструмент владельца.

### 3.2 `scripts/preflight.mjs` и `.npmrc`

```js
#!/usr/bin/env node
// Проверка версии Node до тестов, dev и сборки: better-sqlite3 падает под другой
// мажорной версией без внятного сообщения.
import { readFileSync } from 'node:fs';
export function checkNode(version, engines) {
  const [major, minor] = version.split('.').map(Number);
  const [, lowMajor, lowMinor, highMajor] = /^>=(\d+)\.(\d+)\.\d+ <(\d+)$/.exec(engines) ?? [];
  const ok = major >= Number(lowMajor) && (major > Number(lowMajor) || minor >= Number(lowMinor)) && major < Number(highMajor);
  if (ok) return { ok: true };
  return {
    ok: false,
    message: [
      `TaskIndex требует Node ${engines}; запущен v${version}.`,
      'С другой мажорной версией не загружается нативный better-sqlite3.',
      'Переключитесь: `fnm use` / `nvm use` (файл .node-version) или см. CLAUDE.md, раздел «Окружение».',
    ].join('\n'),
  };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const pinned = readFileSync(new URL('../.node-version', import.meta.url), 'utf8').trim();
  const result = checkNode(process.versions.node, pkg.engines.node);
  if (!result.ok) { process.stderr.write(`${result.message}\n`); process.exit(1); }
  if (process.versions.node !== pinned) process.stderr.write(`Внимание: закреплён Node ${pinned}, запущен ${process.version}.\n`);
}
```

`package.json`: `"preflight": "node scripts/preflight.mjs"`, `"precheck"`, `"pretest"`, `"predev"`, `"pree2e"` = `npm run -s preflight`. `.npmrc`: `engine-strict=true`. Путь `/private/tmp/...` в скрипт не зашивается (машинно-специфичен), он в `CLAUDE.md`.

### 3.3 `scripts/sandbox.mts`

Запуск `node --import tsx scripts/sandbox.mts` (скрипт `"sandbox"`), импортирует `src/server/{db,admin,auth,app}.ts` напрямую, как `tests/e2e/server.ts`.

Поведение по умолчанию (`start`):
1. `mkdtemp(join(tmpdir(), 'taskindex-sandbox-'))`; внутри `sandbox.db`, `state/` (для `XDG_STATE_HOME`), `keys/`, `owner.json` (0600: email `owner@sandbox.test`, случайный пароль для входа в браузере), `sandbox.json` (pid, порт, каталог, агенты).
2. `openDatabase` → `initialize(db, { timezone: 'Europe/Moscow' })` → `createOwner` → `createAgent` `claude` («Клод, sandbox») и `codex` («Кодекс, sandbox») → `createAgentKey` (`claude`: `write`, `codex`: `tasks`; переопределение `--agents name:scope,name:scope`); ключи в `keys/<agent>.json` 0600.
3. Свободный порт (`net.createServer().listen(0)`); дочерний процесс `node --import tsx src/server/index.ts` с `PORT`, `BASE_URL=http://127.0.0.1:<port>`, `DATABASE_PATH`, `BETTER_AUTH_SECRET=<random 64 hex>`, `BUILD=sandbox`, `NODE_ENV` не задан (dev-режим, `trustedOrigins` включает localhost:5173), `detached: true`, `stdio` в `server.log`; `unref()`.
4. Ожидание `GET /health` `ok: true` до 15 с; иначе печать `server.log` в stderr и код 1.
5. stdout: shell-строки для `eval`:
   ```sh
   export TASKINDEX_URL=http://127.0.0.1:41234
   export TASKINDEX_TOKEN=<ключ агента claude>
   export XDG_STATE_HOME=/tmp/taskindex-sandbox-XXXX/state
   export TASKINDEX_SANDBOX=/tmp/taskindex-sandbox-XXXX
   ```
   Токен одноразовой базы печатается намеренно: это единственный способ передать его в `eval`; в `CLAUDE.md` сказано, что sandbox-ключи не секрет, но и не для рабочего сервера.
6. `--token <agent>` печатает только строку `export TASKINDEX_TOKEN=…` для другого агента (для второй сессии, например Codex); `--stop [--keep]` читает `$TASKINDEX_SANDBOX/sandbox.json` (или последний каталог по маске), шлёт SIGTERM, ждёт до 10 с, удаляет каталог (с `--keep` оставляет); `--writes held --deployment <id>` для сценария шага 6 агентского цикла; `--json` печатает `sandbox.json` вместо `export`-строк.
7. Скрипт никогда не читает `.env` и не пишет ничего вне `mkdtemp`.

Тест `tests/cli/sandbox.test.ts`: запуск `sandbox.mts --json` дочерним процессом, разбор JSON, `fetch(url + '/health')` → `ok`, `runCli(['me'])` с ключом → `scope: 'write'`, затем `--stop` и проверка отсутствия каталога. Помечен `it.skipIf(process.env.CI)`? Нет: тест лёгкий (одна база в памяти диска, один процесс), выполняется всегда, таймаут 30 с.

### 3.4 `scripts/agent-cycle.mts` и `docs/acceptance/agent-cycle.md`

Скрипт поверх работающего sandbox (`TASKINDEX_SANDBOX` обязателен), два агента через `runCli` с разными `XDG_STATE_HOME`, владелец через Better Auth (`POST /api/auth/sign-in/email` с паролем из `owner.json`, cookie, заголовок `Origin`). Соответствие шагам `tests/e2e/agent-cycle.md`:

| Шаг | Что делает скрипт | Статус |
|---|---|---|
| 1 | оба агента `context`, `digest`; A `project create`; B находит проект в `context`; оба `task sync` с одним origin и версией; проверка: одна задача, `createdBy` первого, у второго `skipped: all, reason: stale` или `existing`; sync без версии: создание, затем `freshness_unknown` без события (`seq` не растёт) | автоматизировано |
| 2 | владелец по cookie `task.save` (проект, статус `done`); A `task sync` новой версии: `status`/`projectId` в `skipped`, `note` в `applied`; оба агента `comment add` параллельно с `task.save` владельца: три операции, `commentCount` 2, заметка сохранена | автоматизировано |
| 3 | черновик в браузере во время правки агента | вручную (`docs/acceptance`), частично e2e `workspace.spec.ts` |
| 4 | A `batch` из трёх `task.create`; `activity` показывает одну операцию; владелец `undo --operation`; затем A меняет поле одной задачи, владелец повторяет undo другой операции, затрагивающей то же поле → `conflict`; B (`tasks`) `undo` операции с `project.update` → 403; после плана 02: B `undo` операции A → 403 | автоматизировано |
| 5 | потеря ответа после commit | остаётся в `tests/cli/agent-cycle.test.ts:52-110` (требует перехвата транспорта); скрипт печатает ссылку |
| 6 | перезапуск sandbox с `--writes held --deployment d2`; A `task create` → четыре попытки, 503, конверт сохранён, код 1; `taskindex-admin open-writes` через `admin-run` с `DATABASE_PATH` sandbox; `operation resume` → ровно одно изменение; перезапуск того же `deployment` → `writes: open`; новый `deployment` → `held` | автоматизировано |
| 7 | перезагрузка вкладки с неподтверждённой отправкой; `mark-restored` и старые конверты | вручную; часть про `mark-restored` автоматизируется: `admin markRestored` на sandbox-базе, затем `operation resume` старого конверта → `generation_changed`, конверт остаётся |

Вывод: JSON-строки `{step, ok, operationIds, details}` и итог `{ok, passed, failed, manual: [3, 7]}`; код выхода 0 при всех автоматизированных `ok`. `docs/acceptance/agent-cycle.md`: прежний текст семи шагов с пометками «автоматизировано: `npm run agent-cycle`, шаг N» и инструкцией для ручных шагов 3 и 7 (что открыть, что нажать, что увидеть), плюс шаблон отчёта (кто, URL, build, generation, operationId). `tests/e2e/agent-cycle.md` удаляется; ссылки `BACKLOG.md:82`, `deploy/README.md:74`, README обновляются.

### 3.5 SKILL.md: что добавить (A13)

Существующий текст сохраняется (он точен); добавляются разделы:

- **Установка.** Claude Code: `ln -s "$(pwd)/skills/taskindex" ~/.claude/skills/taskindex` из корня репозитория (или копия каталога). Codex: способ подключения зависит от версии Codex CLI и здесь не утверждается; переносимый вариант: `AGENTS.md` репозитория ссылается на `skills/taskindex/SKILL.md`, и текст скилла вставляется в поручение. Проверка установки: `taskindex help` доступен, `taskindex me` печатает актора.
- **Окружение.** `TASKINDEX_URL=https://<домен>`; `TASKINDEX_TOKEN` только через 1Password: `op run --env-file=~/.config/taskindex/agent.env -- taskindex digest`, где в файле `TASKINDEX_TOKEN=op://Vault/TaskIndex agent claude/credential`; либо `export TASKINDEX_TOKEN=$(op read 'op://…')` в начале сессии. Токен не попадает в аргументы, файлы поручения и сообщения. Для проверок: sandbox из `CLAUDE.md`.
- **Пять примеров с ожидаемым JSON** (сокращённые реальные ответы из транскрипта ревью готовности): (1) `task create --area agency --title … --due …` → `{"ok":true,"operationId":…,"results":[{"record":{"id":…,"revision":1,"createdBy":"agent:…"}}]}`; (2) `task get ID` → `revision`, затем `task update ID --base-revision N --note …`; (3) `task sync --origin … --fields …` → `applied`/`skipped`/`unchanged`; (4) конфликт: `task update` с устаревшей `--base-revision` → `{"ok":false,"code":"conflict","current":{…},"conflicts":[{"fields":["note"]}]}`, что делать; (5) `status: unknown` → `operation get ID` → `operation resume ID`.
- **Отмена и focus** (после плана 02): «Агент отменяет только свои операции; операции владельца и других агентов не отменяются (403). Ошибку другого актора исправляй прямой командой с актуальной `--base-revision` или сообщи комментарием. `focus` ставит только владелец: в командах его не передавай, в `sync` оно пропускается.»
- **Восстановление.** `409 conflict` на курсоре страниц: CLI повторяет обход сам (план 03); `generation_changed`: `taskindex cursor reset`, свежий `context`, переоценка действия; `status: unknown`: как сегодня.
- **Коды ошибок.** Серверные (`invalid`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `operation_mismatch`, `generation_changed`, `not_undoable`, `unavailable`) и CLI (`invalid_arguments`, `client_error`, `network_error`, `invalid_response`) с одной фразой на каждый; поле `issues[].path`/`hint`.
- **Новые команды** из плана 03: `me`, `tasks --today true`, `tasks --has-follow-up true`, `digest --since last`, `cursor commit`, `inbox`, `help <group> <action>`; удалены `--json`, `task focus`.

Тест `tests/cli/skill.test.ts`: читает `skills/taskindex/SKILL.md`, извлекает из inline-кода и блоков `sh` все вхождения `taskindex <group>( <action>)?` и `--[a-z-]+`, сверяет с `renderHelp()` из `src/cli/help.ts` (план 03): каждая пара group/action есть в `READS`/`WRITES`/служебных (`help`, `me`, `cursor`, `operation`), каждый флаг есть в глобальных или во флагах хотя бы одной команды. До мерджа плана 03 тест сверяет с `HELP.reads/writes/flags` из `run.ts` по подстроке.

### 3.6 Порядок работ по чек-листу (f) ревью готовности

| # | Пункт | План | Волна |
|---|---|---|---|
| 1 | `CLAUDE.md`, `AGENTS.md`, `preflight`, `.npmrc` | 12 (шаги 1-2) | 1 |
| 2 | `sandbox.mts`, `agent-cycle.mts`, `docs/acceptance` | 12 (шаги 3-4) | 1 |
| 3 | Разделение состояния CLI по серверу и агенту, тест с двумя токенами | 03 (шаги 1-6) | 1 |
| 4 | Справка из схем, `me`, `--today`, русские ошибки, EPIPE | 03 (шаги 7-9) | 2 |
| 5 | `issues`, OpenAPI с компонентами и `security`, публичный документ, `taskindex openapi` | 04 (шаги 6-7), 03 | 2 |
| 6 | Курсор `--since last`, `digest.comments`, `inbox` | 03 (шаги 10-12), 04 (раздел 7) | 2 |
| 7 | Исчерпывающесть: union из схем, `labels`, `assertNever`, `SCHEMA_VERSION` ↔ журнал | 04 (шаг 3), 10 (R1), 06 (B4/V6) | 2 |
| 8 | Скилл, README, справка без `--json`, `LOG_LEVEL`, `--generation` | 12 (шаги 5-6), 03, 06 | 2 |
| 9 | Разрез `app.ts`, `noUnusedLocals`, пометки сгенерированных файлов | 06, 12 (шаги 7-8) | 3 (пометки и `noUnusedLocals` в 1) |
| 10 | `deploy.sh --plan`, `bootstrap.sh`, фильтр по актору в UI | 11, 07 | 3 |

## 4. Шаги

Работа в отдельном worktree. Шаги 1-4 это P0-часть.

1. **`CLAUDE.md`** с содержанием 3.1; `ln -s CLAUDE.md AGENTS.md`; проверить `git add` сохраняет режим `120000`. Сверить каждое утверждение файла с кодом на момент записи (порты в `tests/e2e/server.ts:19,32,39`, скрипты `package.json:8-24`, пути каталогов). Разделы, зависящие от планов 03/04/06 (`spec.ts`, `state.ts`, `limits.ts`, `errorBody`, `routes/*`), пометить «после плана NN», пока те не смержены; обновить при мердже.

2. **`scripts/preflight.mjs`**, `.npmrc`, скрипты `pre*` в `package.json`; `.nvmrc` → `24.20.0`. Тест `tests/unit/preflight.test.ts` для `checkNode`. Ручная проверка: `PATH=/usr/local/bin:$PATH npm test` под Node 26 → сообщение и код 1 без трассы `better-sqlite3`.

3. **`scripts/sandbox.mts`** (3.3) и скрипт `"sandbox"`; тест `tests/cli/sandbox.test.ts`. Проверка вручную из чистого worktree: `eval "$(npm run -s sandbox)" && npm run cli -- digest && npm run cli -- me && npm run sandbox -- --stop`; `git status` без новых файлов; `ls -la data .env` в основном чекауте с прежними mtime.

4. **`scripts/agent-cycle.mts`** (3.4), скрипт `"agent-cycle"`, `docs/acceptance/agent-cycle.md`, удаление `tests/e2e/agent-cycle.md`, ссылки в `BACKLOG.md:82`, `deploy/README.md:74`, `README.md`. Проверка: `npm run agent-cycle` на sandbox → все автоматизированные шаги `ok`; после плана 02 добавить проверку «B не отменяет A».

   2026-09-10: шаги 1-3 реализованы (TI-052, TI-028, TI-053). Отличия от текста: `CLAUDE.md` содержит раздел «Реестр находок и планы» (доп. шаг 12 и решение владельца) и помечает `spec.ts`, `state.ts`-курсор, `config.ts`, `routes/*` как «после плана NN»; артефакты e2e уже в `test-results/` (TI-058), поэтому предупреждение про `docs/reference` переписано; тест preflight лежит в `tests/cli/preflight.test.ts` (каталог `tests/unit` принадлежит владельцу сервера) и дополнительно запускает скрипт под другим мажорным Node, если он есть на машине; `tests/cli/sandbox.test.ts` проверяет `--json`, `/health`, настоящую запись через `runCli`, `--token`, `--stop`; `presandbox` тоже вызывает preflight; `.nvmrc` = `24.20.0`. Машинная часть TI-028 (постоянный Node 24 в новом терминале) остаётся действием владельца: на Mac и системный `node`, и Homebrew `node@24` дают 26.7.0, менеджер версий не установлен; README и `CLAUDE.md` описывают `fnm use`/`nvm use` по `.node-version`.
   2026-09-10: шаг 4 реализован частично: `scripts/agent-cycle.mts` (`npm run agent-cycle`) автоматизирует шаги 1, 2, 4 и часть 7 (`mark-restored` → `generation_changed`; конверт снимается как окончательный отказ по TI-004, а не «остаётся»); шаг 6 (held → open-writes → перезапуск того же deployment) остаётся ручным, потому что sandbox не перезапускает сервер с той же базой; `docs/acceptance/agent-cycle.md` создан, `tests/e2e/agent-cycle.md` и ссылка в `deploy/README.md:75` принадлежат владельцу `tests/e2e`/`deploy` (запрос ему). Шаг 6 (дрейф) и доп. шаг 11 (таблица сверки): раздел «Отклонения от плана» добавлен в конец плана v2; `.env.example`/`deploy/README.md` (`LOG_LEVEL`, `TIMEZONE`, ссылка на приёмку) — запрос владельцу `deploy`. Лёгкая версия теста «скилл против справки» и проверок документации: `tests/cli/docs.test.ts` (вместо `tests/unit/docs.test.ts` и `tests/cli/skill.test.ts`).
5. **SKILL.md** (3.5) и `tests/cli/skill.test.ts`. До плана 03 тест работает по `HELP`; после мерджа 03 переключить на `renderHelp()`.

6. **Дрейф документации** (1.5): README (Node, `--password-op`, `TIMEZONE`, установка скилла, sandbox, `help <group>`), `deploy/.env.example:6-7` (комментарии к `TIMEZONE` и `LOG_LEVEL`), `docs/plans/2026-09-08-taskindex-v2.md` §3 (структура: `scripts/`, `docs/acceptance/`), §10 (`--json` удалён, вывод всегда JSON; путь outbox `servers/<server>/agents/<agent>/ops`; `--since last`; `me`; `inbox`), §12 (`LOG_LEVEL` до решения плана 06 «не используется»), `deploy/README.md:74`. Каждое исправление одной строкой в разделе «Отклонения от плана» в конце плана v2 (создать раздел, если нет), чтобы план оставался истиной по объёму.

7. **Пометки сгенерированных файлов** (B8): `drizzle/v2/README.md` (что такое `0000_taskindex.sql`, что `meta/*` генерируется `npm run db:generate` и не редактируется, что применённые SQL не меняются, ссылка на раздел «Как добавить миграцию» в `CLAUDE.md`); `.gitattributes`:
   ```
   drizzle/v2/meta/** linguist-generated=true
   docs/reference/**/*-sha256.json linguist-generated=true
   docs/reference/**/environment.json linguist-generated=true
   docs/audits/** linguist-generated=true
   ```

   2026-09-10: `.gitattributes` добавлен в корень (область B, четыре шаблона как выше, с комментарием о производителе каждого набора); `drizzle/v2/README.md` уже есть (область A, `drizzle/**`). Тест `tests/cli/docs.test.ts` проверяет наличие всех четырёх шаблонов.

8. **`tsconfig.json`**: `noUnusedLocals: true`, `noUnusedParameters: true`; прогнать `tsc`; исправить находки (ожидаются деструктуризации `_cursor/_limit/_generation` в `app.ts:578-583`, `:707-712`, `:721`, `:965` и `{ generation: _generation, ...event }` в `operations.ts:173`: если TS их отметит, заменить на явный `omit`-хелпер в `shared`; неиспользуемые импорты типов, если есть). `serverId` в `outbox.ts` используется планом 03; до его мерджа экспорт не считается неиспользуемым локалом (`noUnusedLocals` не проверяет экспорты), правок не требует.

9. **Проверка.** `npm run check`, `npm run e2e` с `TASKINDEX_E2E_ARTIFACT_DIR=test-results/e2e`, `npm run build`; запуск `CLAUDE.md` «глазами» свежего агента: открыть новую сессию Claude Code в worktree и попросить выполнить «поднять sandbox и создать задачу через CLI» без иных инструкций; сессия должна дойти до `ok: true` без вопросов об окружении.

## 5. Тесты

| Критерий | Файл | Сценарий | Ожидание |
|---|---|---|---|
| 1 | ручная проверка | `cat AGENTS.md`, `git ls-files -s AGENTS.md` | содержимое `CLAUDE.md`, режим `120000` |
| 2 | `tests/unit/preflight.test.ts` | `checkNode('26.7.0', '>=24.11.0 <25')`, `checkNode('24.10.0', …)`, `checkNode('24.20.0', …)` | первые два `ok: false` с русским `message`, третий `ok: true` |
| 2 | ручная проверка под Node 26 | `npm test` | код 1, сообщение preflight, без трассы `better-sqlite3`; `npm ci` → `EBADENGINE` |
| 3 | `tests/cli/sandbox.test.ts` | `sandbox.mts --json`, `/health`, `runCli(['me'])`, `--stop` | `ok`, `scope: 'write'`, каталог удалён |
| 3 | ручная проверка | `eval "$(npm run -s sandbox)" && npm run cli -- digest` из чистого worktree | код 0; `git status` без новых файлов |
| 4 | ручная проверка | `npm run agent-cycle` на sandbox | шаги 1, 2, 4, 6 `ok`; итог `manual: [3, 7]` |
| 5 | `tests/cli/skill.test.ts` | разбор SKILL.md | каждая команда и флаг присутствуют в справке |
| 6 | `tests/unit/docs.test.ts` (source-scan) | `README.md` не содержит `--json`; `.nvmrc` равен `.node-version`; `deploy/README.md` и `BACKLOG.md` не ссылаются на `tests/e2e/agent-cycle.md` | проходит |
| 7 | ручная проверка | `git check-attr linguist-generated drizzle/v2/meta/_journal.json` | `set` |
| 8 | `npm run check` | | зелёный с `noUnusedLocals` |

## 6. Риски и откат

- **Символическая ссылка `AGENTS.md`** на Windows-чекауте без `core.symlinks` превращается в текстовый файл с именем цели. У владельца macOS и WSL2 (`winpc`), где ссылки работают; при проблеме заменить на копию с проверкой равенства в `tests/unit/docs.test.ts`.
- **`engine-strict=true`** остановит `npm ci` и в Docker при смене базового образа на другой мажор; это желаемое поведение (`Dockerfile` пиннут на 24.20.0).
- **`pretest`/`precheck`** добавляют около 30 мс к каждому запуску; `npm run test -- --watch` также вызывает preflight один раз.
- **Токен sandbox в stdout.** Печатается только ключ одноразовой базы в `/tmp`; `sandbox.json` и `keys/` создаются 0600; `--stop` удаляет их. В `CLAUDE.md` явно сказано не использовать sandbox-ключи с рабочим сервером.
- **`agent-cycle.mts` зависит от планов 02 и 03** в части ожиданий (403 на чужой undo, новый каталог outbox). До их мерджа соответствующие проверки помечены `pending` и не влияют на код выхода.
- **`noUnusedLocals`** может отметить код, который планы 03/06/10 меняют параллельно; конфликты мерджа тривиальны (удаление строк).
- Откат: все изменения это документы, скрипты и конфиг; `git revert` без миграций.

## 7. Вне объёма

- `LOG_LEVEL` (читать или удалить), `BUILD_ID`, `server/config.ts`, `SCHEMA_VERSION` ↔ журнал миграций: `06-server-structure-config-logging.md`.
- Артефакты e2e по умолчанию в `test-results/` и публикация в `docs/reference` флагом: `10-code-quality-and-tests.md`; категории oxlint и остальные правила линта: там же.
- Постоянный Node 24 на этом Mac (`fnm`/`nvm` вместо `/private/tmp`): `BACKLOG.md:19-27`, действие владельца вне репозитория; `CLAUDE.md` описывает оба пути.
- `deploy.sh --plan`, `deploy/bootstrap.sh` (B10): `11-deploy-and-ops.md`.
- Разрез `app.ts` (B5): `06-server-structure-config-logging.md`.
- Тексты правил `/api/context` и матрица прав: `02-agent-permissions-and-sync-semantics.md`; чек-лист «как добавить команду»: `04-api-contract-and-schemas.md`, раздел 3.8.
- Фильтр по актору в UI «Активности» (паритет в сторону владельца): `07-web-client-fixes-and-structure.md`.

## Покрытые находки

| ID | Отчёт | Кратко | Где в плане |
|---|---|---|---|
| B1 | AI-готовность | нет `CLAUDE.md`/`AGENTS.md`, ловушка Node 26 | 1.1, 3.1, 3.2, шаги 1-2 |
| B2 | AI-готовность | нет одноразового окружения одной командой; `setup-dev` пишет в чекаут | 1.2, 3.3, шаг 3 |
| A13 | AI-готовность | скилл без установки, окружения, примеров, политики undo; `agent-cycle.md` не исполняем | 1.3, 1.4, 3.4, 3.5, шаги 4-5 |
| B6 | AI-готовность | дрейф документации (`LOG_LEVEL`, `--json`, `--generation`, пины Node, `--password-op`, `TIMEZONE`, чек-лист как приёмка) | 1.5, шаг 6 |
| B8 | AI-готовность | сгенерированные файлы не помечены | 1.6, шаг 7 |
| B7 | AI-готовность | `noUnusedLocals`, неиспользуемый `serverId` | 1.7, шаг 8 (использование `serverId` в плане 03) |
| B9 | AI-готовность | смешение языков в ошибках | 1.8 (реализация в планах 03 и 04) |
| (f) чек-лист | AI-готовность | порядок работ | 3.6 |
| §9, §10 качества | качество | `agent-cycle.md` в `tests/`, три пина Node, `--password-op` не в README, e2e пишет в `docs/` | 1.4, 1.5, 1.9, шаги 4, 6 |
| Ж6 | архитектура | мёртвые `TIMEZONE` (только migrate) и `LOG_LEVEL` | 1.5, шаг 6 (документирование; решение в плане 06) |
| план §10 `--json` | архитектура (d), стек | документация обещает `--json` по TTY | шаг 6 |
| побочный эффект ревью | сводка | e2e перезаписал `docs/reference/v2-validation/` | 1.9, do-not-touch в 3.1 |
| Astra BL-NODE | astra / TI-028 | постоянный Node 24; ранний preflight до загрузки нативного модуля | 3.2, шаги 1-2; шаг 10 |
| Astra BL-DOCS | astra / TI-033 | дрейф документации; таблица «утверждение → код → поведение → документ» | 1.5, шаг 6; шаг 11 |
| Astra BL-AUTHORITY (текст скилла) | astra / TI-027 | политику undo и focus описывать после решения владельца | 3.5; шаг 13 |
| Astra B-04, FB:B-09, Astra B-01 (правила скилла) | astra / TI-008, TI-037, TI-001 | ограничение `digest`/`--since`; повтор при 409 на курсоре; поток после отзыва ключа | шаг 13 |
| Astra BL-LOCALIZATION, BL-PLURALS, BL-HISTORY | astra / TI-030, TI-031, TI-032 | UX-пункты BACKLOG: русские ошибки и подписи, склонения, читаемая история | только ссылка; B9 частично в планах 03 и 04 |
| Сверка (реестр) | `issues.md`, `ASTRA-INDEX.md` | реестр находок как точка входа для агентов | шаг 12 |

## Сверка с ревью Astra (2026-09-08)

Кратко: трека готовности к ИИ-агентам у Astra нет (`ASTRA-VS-FABLE.md` §2 и `reports/compare-quality-method.md`, раздел (e)): общий outbox, справка, форма OpenAPI, `CLAUDE.md`, sandbox, `--today`, `me`, курсор, `inbox`, EPIPE остаются только нашими, и Astra не назвала это пробелом. Пересечения: `astra-28-permanent-node-runtime.md` (BL-NODE, реестр TI-028) совпадает с B1 (preflight 3.2 и раздел «Окружение» в `CLAUDE.md`) и добавляет правила «один менеджер версий, один пин, сначала свежая проверка, не пересобирать нативный модуль под Node 26»; `astra-33-contract-documentation-reconciliation.md` (BL-DOCS, TI-033) совпадает с B6 (1.5, шаг 6) и добавляет таблицу сверки и правило «права tasks/write описывать после решения плана 27, до этого помечать как открытый вопрос»; `astra-30/31/32` (TI-030, TI-031, TI-032) это UX-пункты BACKLOG, здесь только ссылка (B9 с русской локалью Zod частично закрывает TI-030). После сверки существуют единый реестр `issues.md` (77 карточек) в корне репозитория и `ASTRA-INDEX.md`; `CLAUDE.md` должен направлять агентов туда. `ASTRA-VS-FABLE.md` §5 про sandbox («выдаёт только локальные тестовые credentials, не печатает рабочие секреты») совпадает с 3.3. Из `reports/compare-bugs.md` (раздел (e)) в SKILL.md добавляются ограничение `digest` (Astra B-04) и правило повтора при 409 на курсоре (B-09).

### Добавлено по итогам сверки
| Пункт | Источник Astra | Реестр | План Astra | Что делаем здесь / где делается |
|---|---|---|---|---|
| Один менеджер версий и один пин; свежая проверка до починки; preflight до загрузки нативного модуля | BL-NODE | TI-028 | `astra-28`, шаги 1-3, 6 | 3.2 уже preflight; шаг 10 ниже |
| Таблица сверки «утверждение → код/тест → фактическое поведение → документ»; исторические отчёты не переписываются | BL-DOCS | TI-033 | `astra-33`, шаги 1-2, 6 | 1.5, шаг 6; шаг 11 ниже |
| Права агентов описывать после решения, до этого помечать открытым вопросом | BL-DOCS, BL-AUTHORITY | TI-033, TI-027 | `astra-33`, шаг 3; `astra-27` | шаг 13 ниже |
| Реестр как точка входа; обязательный namespace при совпадающих коротких ID (`Astra:B-01` и `FB:B-01` разные находки) | `ASTRA-INDEX.md`, `issues.md` | все | нет | шаг 12 ниже |
| Правила скилла из сверки: ограничение `digest`/`--since`, повтор при 409 на курсоре, поток после отзыва ключа | B-04, FB:B-09, B-01 | TI-008, TI-037, TI-001 | `astra-08`, `astra-01` | шаг 13 ниже |
| Sandbox печатает только локальные тестовые credentials | `ASTRA-VS-FABLE.md` §5 | TI-053 | нет | 3.3 уже; без изменений |
| Рабочая приёмка после исправлений | BL-ACCEPTANCE | TI-034 | `astra-34-release-and-owner-acceptance.md` | 3.4 (`agent-cycle.mts`, `docs/acceptance`) это исполняемая часть; релизная приёмка в плане 11 |
| UX-пункты BACKLOG | BL-LOCALIZATION, BL-PLURALS, BL-HISTORY | TI-030, TI-031, TI-032 | `astra-30`, `astra-31`, `astra-32` | только ссылка |

### Расхождения и решение
- Права в скилле. 3.5 формулирует политику A (агент отменяет только свои операции, `focus` только владелец) как факт; `astra-33` шаг 3 требует описывать права после решения плана 27 и до этого помечать открытым вопросом. Решение: текст 3.5 остаётся, но с пометкой «по решению владельца (план 02, раздел 3.2)» до записи решения (шаг 13); `tests/cli/skill.test.ts` это не затрагивает.
- Node. `astra-28`: не ставить несколько менеджеров параллельно, сначала свежая проверка; `CLAUDE.md` в 3.1 называет и `fnm`/`nvm`, и путь `/private/tmp/...`. Решение: до выбора владельцем (BACKLOG, TI-028) оба пути остаются с пометкой «временно»; после выбора `CLAUDE.md` называет один менеджер и путь `/private/tmp` удаляется (шаг 10).
- У Astra нет `CLAUDE.md`, `AGENTS.md`, sandbox, исполняемого агентского цикла и теста «скилл против справки»; противоречия нет, трек только наш.
- OpenAPI и `taskindex openapi`: совместимо с `ASTRA-VS-FABLE.md` §4.4 («сделать полезным для агента»); решение в плане 04.

### Дополнительные шаги
10. Node (`astra-28`). После того как владелец закрепит постоянный Node 24 на машине (BACKLOG, TI-028; действие вне репозитория): раздел «Окружение» в `CLAUDE.md` называет только выбранный менеджер, упоминание `/private/tmp/taskindex-v2-tools/...` удаляется; `tests/unit/docs.test.ts` проверяет, что `CLAUDE.md` не содержит `/private/tmp`; `scripts/preflight.mjs` без изменений (это шаг 3 `astra-28`). Шаги 1-2 и 5-6 `astra-28` (свежая проверка `command -v`/`realpath`, один менеджер, `npm ci` только под 24, без пересборки под 26, согласование с Docker) это действия на машине владельца и записываются в BACKLOG, не в код.
11. Таблица сверки документации (`astra-33`, шаг 1) в разделе «Отклонения от плана» файла `docs/plans/2026-09-08-taskindex-v2.md` (создаётся шагом 6): колонки «утверждение → код/тест → фактическое поведение → документ → статус (принято / реализовано / открыто / запланировано, план NN)». Заполнить строками из 1.5 и пунктами `astra-33`: порядок с архивными соседями, выключенный rate limit ключей, проверка привязки ключа, `approved_deployment`, fingerprint страниц, фактический SQLite backup, уже реализованный `event: operations`. Исторические отчёты (`docs/audits/**`, `reports/`) не переписываются (`astra-33`, шаг 2). `tests/unit/docs.test.ts` дополняется: каждый путь файла из таблицы существует.
12. `CLAUDE.md`, новый раздел «Реестр находок и планы» после абзаца «Истина по объёму…» в 3.1: `issues.md` в корне репозитория это источник статуса и приоритета (карточки TI-NNN, 77 записей); планы этого ревью: `docs/plans/2026-09-08-v2-review/README.md` (планы 01-12) и `ASTRA-INDEX.md` (`astra-01`…`astra-34`); правило: перед исправлением прочитать карточку, после исправления обновить её статус с revision и тестом; namespace обязателен (`Astra:B-01` и `FB:B-01` разные находки); новая находка сначала становится карточкой. `docs/audits/**` остаётся в списке «Не трогать».
13. SKILL.md (3.5), дополнения: (а) «`digest` и `--since` показывают только операции с событиями; отказы и no-op других акторов до появления курсора операций (план 04) читайте `activity` без `--since`» (Astra B-04); (б) «при `409 conflict` на курсоре страниц CLI повторяет обход сам; при ручном обходе по `nextCursor` начните с первой страницы; полный согласованный список даёт `/api/snapshot`» (B-09; план 01, дополнительный шаг 16); (в) «отзыв ключа завершает `events/stream` событием `revoked`; не переподключайтесь в цикле, запросите новый ключ у владельца» (Astra B-01; план 05, дополнительный шаг 11); (г) раздел «Отмена и focus» начинается словами «по решению владельца (план 02, раздел 3.2)» до записи решения (`astra-33`, шаг 3). `tests/cli/skill.test.ts` не меняется: это проза без новых команд и флагов.
    2026-09-10: (а)–(в) записаны в SKILL.md (раздел «Чтение»); (г) — раздел «Отмена и focus» начинается словами «по решению владельца (план 02, „Решение владельца“)», потому что решение уже записано и реализовано (TI-027). Разделы 3.5 добавлены: установка и окружение, справка `help`, примеры ответов (шесть, включая ошибку аргументов с `issues`), коды ошибок сервера и CLI, новые команды `me`, `cursor`, `--since last`, `--commit`, `tasks --today/--has-follow-up`, `--confirm-owner-fields`; `inbox` появится после `digest.comments` (план 04). Тест «скилл против справки» живёт в `tests/cli/docs.test.ts` (не `skill.test.ts`): команды и флаги SKILL.md и README сверяются с `READS`/`WRITES`/`SERVICE` из `spec.ts`, плюс обязательные упоминания новых команд.
14. `scripts/agent-cycle.mts` (3.4). После плана 04 (дополнительный шаг 11) шаг 4 цикла дополнительно проверяет, что `digest --since <seq до отказа>` содержит отклонённый undo (Astra B-04 как проверка цикла). После плана 05 (дополнительный шаг 10) шаг 6 дополнительно открывает `/api/events/stream` ключом B через `fetch`, отзывает ключ B через `admin-run`, создаёт задачу от A и проверяет, что поток B завершается `event: revoked` (Astra B-01). Обе проверки помечены `pending` до мерджа соответствующих планов и не влияют на код выхода.

## Решение владельца (2026-09-10, делегировано Fable)

- `CLAUDE.md` указывает на `issues.md` как единственный реестр статусов, на `README.md` этой папки и на `ASTRA-INDEX.md`; перед реализацией подсистемы выбирается один план из двух наборов.
- Шкала приоритетов везде одна, шкала реестра: P1 до рабочего запуска, P2 функциональные дефекты и существенные риски, P3 улучшения.
