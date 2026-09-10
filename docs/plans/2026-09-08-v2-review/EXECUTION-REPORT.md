# Исполнение реестра TaskIndex v2: отчёт от 2026-09-11

Ветка `v2-fixes`, базовый снимок `63fb04a` (незакоммиченное дерево `main` на 2026-09-10), 102 коммита, `main` не тронут, в GitHub не пушилось, деплоя не было. Единственный источник статусов остаётся `issues.md`; здесь сводка.

## Итог по реестру

| Статус | Карточек | Что это |
|---|---|---|
| ИСПРАВЛЕНО | 71 | коммит в `v2-fixes`, регрессионный тест, результат исходного сценария и дата в абзаце «Закрытие» карточки |
| ОТЛОЖЕНО | 6 | TI-018, TI-023, TI-063, TI-070 (UI/UX передан Astra по решению владельца 2026-09-11), TI-034 (реальная инфраструктура), TI-077 (нет решения) |
| СНЯТО | 1 | TI-075, как и было |

Гейты на вершине `v2-fixes`: `npm run check` (typecheck, oxlint, unused-exports, format, lint:shell, build, check:skin, vitest 58 файлов / 345 тестов) зелёный; полный e2e (проекты `functional`, `static`, `dark`, 34 сценария) зелёный; `npm run build` зелёный; `deploy/local-drill.sh` и harness настоящего `deploy.sh` (`deploy/drill/deploy-drill.sh`, матрица из 10 сценариев `TASKINDEX_FAIL_AT`) зелёные в Docker. Итоговые строки последнего прогона в разделе «Финальные проверки».

## Как велась работа

- Четыре области по владению файлами, а не по темам: server (`src/shared`, `src/server`, `drizzle`, `tests/api|unit|property`, `package.json`), cli (`src/cli`, `tests/cli`, `skills`, `scripts`, документация), web (`src/web`, `tests/web`, `tests/e2e`), deploy (`deploy`, `.github`). Каждый исполнитель в своём worktree на ветке от `v2-fixes`, слияние только fast-forward под файловой блокировкой; e2e под второй блокировкой (порты 4001/4173 фиксированы). Первые раунды на Fable, с раунда 3 механика на Opus по решению владельца.
- Порядок: волна 1 (TI-058 первым, затем P1 и «до переключения»: TI-001/036/055, TI-035/039, TI-004, TI-027, TI-002, TI-056/057, TI-054/013, TI-020, TI-052/028/053), волна 2 (контракты и функциональные дефекты: планы 03, 04, 06, 07, 11), волна 3 (планы 01, 08, 09, 10, 13, рефакторинги, зависимости).
- Для каждого бага регрессионный тест писался до исправления и падал на исходном коде; суть падения записана в карточке.
- Планы получили датированные строки-примечания там, где код с ними разошёлся (все 13 планов); README планов не менялся.

## Что закрыто, по подсистемам

**Доступ и изоляция.** Своя таблица `agent_keys` без записи в базу при проверке ключа, плагин `@better-auth/api-key` удалён, `/api/auth/api-key/*` → 404; отзыв ключа и отключение агента закрывают открытый SSE не позже `SSE_HEARTBEAT_MS` (`event: revoked`), кэша проверки нет. Outbox CLI изолирован по серверу и агенту, чужой конверт не пересылается, битый файл не ломает чтения. Агент не отменяет операции владельца и не ставит `focus`; поля владельца требуют `confirmOwnerFields: true` (в CLI `--confirm-owner-fields`) со следом в результате операции. (TI-001, 004, 027, 035, 036, 039, 055)

**Контракт API.** `issues` с `path` и русским текстом в ошибках валидации, компактный OpenAPI по ключу (129 КБ вместо 970, 19 `operationId`, компоненты), `LIMITS` как единственный источник пределов, union команд из реестра схем с `assertNever`, схемы ответов в `src/shared`, `/api/me` с `generation`/`seq`, `schemaVersion` в снимке, курсор журнала операций `operationSeq` (включает отказы и no-op), доменные отказы сохраняются как операции, служебные слова зарезервированы, `/api/tasks/lookup/by-origin`, `digest.comments` и CLI `inbox`, одна `canonicalJson`. Клиент валидирует снимок, события и ответы, проверяет `operationId`/`generation`, карантинит битые черновики и конверты. (TI-005, 008, 009, 010, 011, 019, 022, 040, 046, 048, 049, 060, 061)

**Стоимость чтений.** История через индексы с overlay текущего пакета, точечные чтения, запись по эффектам, keyset-курсор `v: 2` вместо отпечатка списка (обход не срывается при параллельной записи), SSE-бэклог порциями с пределом и `event: reset`, кэш проекции по `data_version`; `result` операции без дубля событий. Бенчмарк `npm run bench`, строки в `bench-baseline.json`: `task.update` при 320…10 020 событиях 12→30 мс стало 3→2,6 мс; `GET /api/operations/{id}` 64 → 0,2 мс; `/api/digest` 198 → 4,6 мс; `/api/snapshot` 132 → 15 мс; поиск операции при 50 000 операций 861 → 0,12 мс; `task.update` при 5 000 задач 859 → 45 мс. Drizzle остаётся по цифрам. (TI-012, 037, 064, 073)

**Клиент.** Без `localStorage` команды не отправляются (баннер), запаздывающий снимок не откатывает события, база редактора из подтверждённого состояния, pending прежнего поколения убирается явно, scope черновиков без Web Locks не накапливается, «Назад» читает только URL, `EventSource` пересоздаётся с backoff и останавливается при отзыве, актор из `/api/me`. Русские ошибки и доступные имена, история словами, фильтр по автору, склонение количества. (TI-003, 006, 007, 030, 031, 032, 038, 041, 042, 043, 074, 076)

**Оформление.** Вендорная копия CSS shadcn, одна палитра в `tokens.css`, `@layer skin` без `!important`, скин разрезан по экранам, литералы цвета → токены, `scripts/check-skin.mjs` в гейте (hex только в `tokens.css`, контраст WCAG, бюджет CSS), тёмная тема (система/светлая/тёмная), предпочтение оформления в аккаунте владельца (`appearance.update`, `GET /api/appearance`, CLI `appearance get|set`), реестр скинов `classic`/`focus`. (TI-025, 026, 065)

**Стол Focus.** Ядро плана 13: `focusKey`/`focusLeftAt`, `focusPosition`, `done`/`archive` снимают фокус, undo возвращает, инварианты, селектор `focusDesk` (`current`, `next`, `waiting`, `recent`, `counts`), `/api/focus`, `digest.current/next`, CLI `focus` печатает стол. Раскладка вида в интерфейсе передана Astra. (TI-029, 078)

**Сервер, конфигурация, миграции.** Конфиг на Zod, `LOG_LEVEL`, структурные логи с `requestId`, граница окончательности ошибок по известности результата, `HOST` loopback вне production, пути от модуля, security-заголовки и `Cache-Control` в приложении, версия схемы из цепочки миграций, контрольные суммы применённого SQL, правило миграции данных с фикстурой прежней версии, сайдкар поколения, разрез `app.ts`/`admin.ts`/`db.ts` (правило 400 строк в тесте), `run.ts` CLI разрезан. (TI-013, 014, 020, 054, 057, 059, 062, 067)

**Деплой и релиз.** Heartbeat Litestream как dead-man switch с проверкой в drill, nginx (`/health` только с loopback, HSTS, http2, gzip без SSE), снимок релиза и откат из него, `deploy/health.mjs` вместо inline-проб, `deploy.sh --plan` и `--image` с проверкой метки, `bootstrap.sh`, harness настоящего `deploy.sh`, CI-workflow (гейт и образ как артефакт, без GHCR и автодеплоя), `scripts/gate.mjs`, `lint:shell`. (TI-002, 015, 016, 017, 056, 068, 072)

**Готовность для агентов и документация.** `CLAUDE.md` и `AGENTS.md`, preflight Node 24, `.npmrc engine-strict`, sandbox одной командой, исполняемый агентский цикл (`npm run agent-cycle`: `{ok:true, passed:[1,2,4,6,7], manual:[3]}`), справка CLI из спецификации, `me`, `openapi`, курсор `--since last`/`cursor commit`, `--all` с перезапуском, EPIPE тихо, `--follow` без пустых страниц, SKILL.md, таблица отклонений в плане v2, `docs/acceptance/{agent-cycle,phone,test-debt}.md`, `.gitattributes`. (TI-028, 033, 044, 045, 047, 050, 051, 052, 053)

**Качество и зависимости.** `tsconfig` строже, oxlint по плану 10 (`suspicious` как `warn`), `ignoreRejection`, `unused-exports` в гейте (0 мёртвых), независимый оракул property-тестов, проект `static` в e2e, общие e2e-хелперы, `date-fns`/`shadcn`/`overrides.undici` сняты, условный polling Vite, чанки вендоров, замер бандла и решение оставить Zod classic. (TI-018 частично, 021, 024, 058, 066, 069, 070 частично, 071)

## Тесты

Добавлено 49 файлов тестов (см. `git diff --stat 63fb04a..v2-fixes -- tests`): api (`agent-keys-migration`, `appearance`, `contract`, `errors`, `generation-sidecar`, `headers`, `history-access`, `migration-compat`, `openapi`, `operations-journal`, `pagination`, `paths`, `permissions`, `sse-hub`), cli (`acknowledgement`, `canonical-envelope`, `cursor`, `docs`, `follow`, `help`, `outbox-isolation`, `preflight`, `process`, `reads`, `sandbox`, `state`), deploy (`deploy-plan`), e2e (`artifacts`, `dark`, `localization`, `static`, `web-client`), property (`projection`, `write-state`), unit (`canonical-json`, `config`, `ignore-rejection`, `limits`, `manifest`, `server-shape`), web (`auth-errors`, `editor-base`, `history`, `labels`, `pending`, `strings`, `sync`, `url`, `use-mobile`). Реестр регрессий по находкам обеих сторон: `docs/acceptance/test-debt.md`. Миграции: `0001_agent_keys`, `0002_operation_seq`, `0003_appearance`, `0004_focus_desk` с фикстурой `tests/fixtures/export-schema-2.json`.

## Отложено и почему

- **TI-034 (рабочая приёмка)**: нужны VPS, домен и TLS, S3-реплика, чек healthchecks.io, телефон. Всё локально проверяемое сделано (гейты, drill, harness, `bootstrap.sh`, `--plan`, CI по `actionlint`, чек-листы приёмки). Шаги владельца по `astra-34` перечислены в карточке.
- **TI-002 (закрыто с оговоркой)**: конфигурация, стенд и runbook готовы; остаётся завести чек healthchecks.io (период 1 мин, grace 3 мин) и положить URL в env через `op`.
- **TI-077**: удаление/архивирование проекта — продуктовое решение, которого нет ни в реестре, ни в планах.
- **UI/UX → Astra (решение владельца 2026-09-11)**: TI-018 (WebKit-проект; спека была написана и откачена, причина в `test-debt.md`; физический чек-лист в `phone.md`), TI-023, TI-063, TI-070 остаток (проекты `setup`/`visual`, чистая база), а также части закрытых карточек: вид «Стол» и счётчик в сайдбаре (TI-078/029), CSS скина «Фокус» и фаза B плана 08 (TI-025/026), декомпозиция `shell.tsx`/`editor.tsx` и ленивые чанки (TI-059/024), веб-часть перечитывания списка при смене `seq` (TI-037). Список с состоянием: `docs/acceptance/test-debt.md`, раздел «Передано Astra 2026-09-11».

## Известные хвосты (не блокируют)

- `revokeAgentKey`/`disableAgent` из admin CLI работают в другом процессе, поэтому граница закрытия SSE именно heartbeat (25 с); `hub.closeFor` в процессе сервера не подключён (нет вызывающего).
- План 01 доп. шаг 13: отношение времени `task.update` 5 000/1 000 задач 5,0 при цели ≤ 2 — остаток линеен и целиком в клоне состояния, которое §7 плана оставляет; порог уточнён в плане.
- Ключи фокуса, назначенные миграцией `0004`, не выражены событиями (вариант (б) правила миграции данных); `validateExport` терпит их для задач, которых журнал не касался.
- 316 предупреждений oxlint (`no-nested-ternary`, `max-lines-per-function`, `catch-error-name` и т. п.) — список работ планов 07/10, правила поднимаются до `error` по мере очистки; `categories.suspicious` включена как `warn`.
- CI-workflow проверен только `actionlint`; живого прогона на раннере не было, версии actions не проверены.
- `snapshotSchema` и OpenAPI: `schemaVersion`, `operationSeq`, `appearance` обязательны; старый CLI/клиент до этих коммитов их не шлёт и не ждёт — совместимость только вперёд, живых агентов ещё нет.
- Машинная часть TI-028: на Mac владельца нет менеджера версий Node; `CLAUDE.md` пока упоминает временный `/private/tmp/taskindex-v2-tools`.
- Первый коммит области server (`f2781d0`) прогнал `oxfmt` по всему дереву; содержимое 110 файлов документации возвращено (`bdcc4ed`), скрипт `format` ограничен путями кода.
- Оставшиеся четыре стенда drill от 2026-09-08 в Docker (`taskindex-drill-20260908*`) не трогались; стенды этой сессии удалены.

## Финальные проверки

Прогон 2026-09-11 на вершине `v2-fixes` (Node 24.20.0, Docker 29):

- `npm run check`: typecheck, oxlint (0 ошибок, предупреждения см. хвосты), unused-exports 0, format:check, lint:shell (shellcheck), `vite build` + `tsdown`, check-skin (бюджет CSS 116 453 Б при пределе 118 800), vitest 58 файлов / 345 тестов — зелёный.
- `npm run e2e` (`TASKINDEX_E2E_ARTIFACT_DIR` во временную папку): 34 passed (projects `functional`, `static`, `dark`), 53,8 с.
- `npm run build`: зелёный, 8 JS-чанков и 1 CSS в `dist/web/assets`, `dist/server`, `dist/cli`.
- `bash deploy/local-drill.sh`: `{"ok":true,"stage":"new-replica-verified",…}` (образ `taskindex:v2-drill`, изолированный volume и file-реплика, откат и восстановление в новое поколение).
- `bash deploy/drill/deploy-drill.sh` (настоящий `deploy.sh` внутри Linux-контейнера, три коммита A/B/C, `bootstrap.sh` для A): `ok: true`, 10 строк матрицы — `guard` exit 1, `image-missing` exit 1, `image-label` exit 1, `lock-held` exit 1, `plan` exit 0, `before-stop` exit 1, `after-migrate` exit 1, `health` exit 1, `deploy` exit 0, `after-open` exit 1 (1 = отказ ожидаем и проверен, 0 = штатный путь).
- Стенды и volume этой сессии удалены после прогона; четыре стенда от 2026-09-08 (`taskindex-drill-20260908*`) не трогались.
- `git worktree list` после уборки: только основной чекаут и `taskindex-v2-fixes`; ветка `v2-fixes` готова к ревью, `main` без изменений.
