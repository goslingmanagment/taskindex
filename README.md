# TaskIndex v2

Все находки ревью, решения и критерии закрытия собраны в
[issues.md](/Users/dmitriy/code/5-management/taskindex/issues.md). В реестре есть ссылки на
исходные отчёты Astra/Fable и подробные планы, включая тёмную тему и скины.

Личная доска задач с одинаковыми операциями для владельца и ИИ-агентов.
Обычная HTTPS-ссылка, вход по паролю или passkey; агенты работают через CLI и API
при закрытом браузере.

В основной папке репозитория на ветке `main` находится новая реализация.
Решения и границы объёма записаны в
[плане](docs/plans/2026-09-08-taskindex-v2.md), результаты независимого ревью —
[в отчёте](docs/plans/2026-09-08-taskindex-v2-review.md).
Временные ветки и worktree удалены. Развёртывание на рабочем VPS выполняется отдельно.

## Стек и код

React 19, TypeScript, Vite, Tailwind 4 и используемые компоненты Base UI/shadcn.
Hono, Zod 4, Drizzle и better-sqlite3 на Node 26; Better Auth с passkey и ключами
агентов. SQLite работает с WAL и synchronous=FULL. На VPS — один процесс Node,
Docker Compose, Nginx и Litestream.

- `src/shared` — схемы, команды, правила, Focus и поиск.
- `src/server` — транзакции, API, авторизация, события и SSE.
- `src/web` — интерфейс, единый store, очередь операций и локальные черновики.
- `src/cli` — обычный CLI и локальный административный инструмент.
- `drizzle/v2` — явные миграции новой базы.
- `skills/taskindex/SKILL.md` — правила работы агента с CLI.
- `deploy` — контейнер, Nginx, резервирование и процедуры восстановления.

Изменение данных, событие и сохранённый ответ операции фиксируются одной
транзакцией. Идентификатор операции позволяет узнать результат после разрыва
соединения и безопасно повторить запрос. Клиент применяет весь пакет событий
целиком. Комментарии отделены от заметки; история и отмена доступны через API
и в интерфейсе. Повторная синхронизация источника учитывает ручные решения.

## Локальный запуск

Нужны Node **26.7.0** и npm. Версия закреплена в `.node-version` и `.nvmrc`;
`package.json` задаёт границу `>=26.0.0 <27`, `.npmrc` включает
`engine-strict`, поэтому `npm ci` под другой мажорной версией останавливается
с `EBADENGINE`. В новом терминале из корня репозитория:

```sh
fnm use        # или: nvm use — оба читают .node-version
node --version # v26.7.0; имя каталога менеджера версий само по себе ничего не подтверждает
npm ci
```

`npm run check`, `npm test`, `npm run dev`, `npm run e2e` и `npm run sandbox`
сначала выполняют `scripts/preflight.mjs`: под другой мажорной версией
(например, Node 24) команда завершается кодом 1 с русским сообщением до
загрузки нативного `better-sqlite3`.
Для браузерных тестов дополнительно нужен Chromium Playwright, для проверки
развёртывания — Docker. Инструкция для агентов-разработчиков: `CLAUDE.md`
(`AGENTS.md` ссылается на него).

### Одноразовое окружение

Для любых проверок CLI и API, без записи в чекаут:

```sh
eval "$(npm run -s sandbox)"     # временная база, владелец, агенты claude (write) и codex (tasks)
npm run cli -- digest
npm run -s sandbox -- --token codex   # строка export для второй сессии
npm run sandbox -- --stop        # остановить сервер и удалить каталог (--keep оставляет)
```

Sandbox печатает только ключи своей временной базы; пароль владельца для входа
в браузере лежит в `owner.json` каталога sandbox. `--writes held --deployment ID`
воспроизводит закрытую запись, `--json` печатает описание окружения.

### Окружение владельца

```sh
npm run setup:dev
```

`setup:dev` создаёт `.env` с новым локальным секретом, если файла ещё нет, и
применяет миграции. Новая пустая база находится в `data/dev.db`; существующий
`.env` сохраняется. Это долгоживущее окружение для ручной работы в браузере;
для проверок используйте sandbox. Чтобы создать владельца, передайте пароль в
stdin команды или ссылкой `--password-op op://…` (читается через `op read`):

```sh
op read 'op://VAULT/TaskIndex local/password' | npm run admin -- create-owner --email owner@example.test
npm run dev
```

Замените ссылку `op://` своей. Пароль не передаётся аргументом процесса и не
печатается инструментом. Открывайте **http://localhost:5173** — имя хоста должно
совпадать с `BASE_URL`, иначе проверки входа и Origin отклонят запрос.
После входа можно зарегистрировать passkey. Для восстановления доступа:
`npm run admin -- reset-owner-password` с новым паролем через stdin.
`TIMEZONE` влияет только на первую миграцию (`admin migrate`); дальше часовой
пояс хранится в базе.

В режиме разработки Vite отдаёт интерфейс и проксирует API к Node на 3001.
`npm run build` создаёт `dist/web`, `dist/server` и `dist/cli`. Для запуска собранной
версии задайте соответствующий `BASE_URL` и используйте `npm start`.

Следующие миграции создаются через `npm run db:generate`: baseline и журнал
Drizzle хранятся в `drizzle/v2/meta`. SQL проверяется до применения; версия
схемы выводится из цепочки миграций, а сервер сверяет контрольные суммы уже
применённых файлов, поэтому применённые миграции не редактируются. Обычный
запуск приложения миграции не выполняет.

## Агенты

Агент это ключ в базе (`taskindex-admin agent create`, `agent-key create`), CLI
`taskindex` и скилл `skills/taskindex/`: `SKILL.md` задаёт поведение (правило
записи «показать и дождаться „да“», что куда, «что горит», шпаргалка),
`reference.md` — технику (источники, курсоры, восстановление, коды).

```sh
npm run admin -- agent create --id codex-local --label 'Codex'
npm run admin -- agent-key create --agent codex-local --scope write --out /protected/taskindex-key.json
npm run cli -- help                 # обзор: команды чтения, записи, служебные, коды выхода
npm run cli -- help task            # действия группы
npm run cli -- help task create     # одна команда: usage, флаги с типами, пример
npm run cli -- me                   # актор ключа: id, label, scope
```

Ключ сохраняется в новый файл с правами 0600; в выводе только его идентификатор
и путь. Перенесите ключ в 1Password. Клиент получает `TASKINDEX_URL` и
`TASKINDEX_TOKEN` из окружения. Для ограниченного агента можно выдать scope
`tasks` или `read`; ротация ключа сохраняет идентичность агента. Справка
строится из спецификации команд (`src/cli/spec.ts`) и схем payload:
`taskindex help <group> [<action>]` или `<команда> --help` печатают JSON с
`usage`, `flags`, `example`, `exitCodes`, `errorCodes`. Вывод всегда JSON.

Установка на мак владельца, из чекаута с нужной версией:

```sh
bash scripts/agent/install-mac.sh
printf 'TASKINDEX_URL=https://tasks.gosling-agency.ru\nTASKINDEX_TOKEN=%s\n' \
  "$(op read 'op://Private/<элемент ключа>/credential')" > ~/.config/taskindex/claude-mac.env
chmod 600 ~/.config/taskindex/*.env
TASKINDEX_AGENT=claude-mac taskindex me
```

Скрипт собирает пакет, ставит его глобально (`npm i -g` из `npm pack`), пишет
обёртку `~/.local/bin/taskindex` и симлинки скилла в `~/.claude/skills/taskindex`
(Claude Code) и `~/.agents/skills/taskindex` (Codex читает этот каталог по своей
документации; оба инструмента идут по симлинку). Обёртка выбирает ключ по среде
запуска: `OPENCLAW_SERVICE_MARKER` (шлюз OpenClaw, любой его runtime) →
`openclaw`, `CLAUDECODE` → `claude-mac`, `CODEX_THREAD_ID` → `codex-mac`, иначе
нужен `TASKINDEX_AGENT`; заданные явно `TASKINDEX_URL` и `TASKINDEX_TOKEN`
(sandbox из `npm run sandbox`) имеют приоритет. Ключи лежат только в
`~/.config/taskindex/<agent>.env` (каталог 0700, файлы 0600), мастер-копия в
1Password; `op` при вызовах не нужен. Бобр (OpenClaw): тот же каталог скилла
через `openclaw skills install`, ключ `openclaw.env` (права `tasks`) обёртка
берёт сама по маркеру шлюза. Обновление после
релиза: повторить `install-mac.sh` из чекаута релизного коммита.

Windows-ПК владельца (`winpc`): `pwsh -File scripts/agent/install-win.ps1
-Tarball <taskindex-2.0.0.tgz>` (пакет собирается на маке `npm run build && npm
pack`, нужен Node 26 из `winget install OpenJS.NodeJS`) ставит пакет в
`~\.local\lib\taskindex-cli`, обёртки в `~\.local\bin` (`taskindex` для
Git Bash, через который ходит Claude Code; `taskindex.cmd` и `taskindex.ps1`
для Codex и pwsh), копии скилла в `~\.claude\skills` и `~\.agents\skills`
и добавляет каталог обёрток в PATH пользователя. Агенты там `claude-win`,
`codex-win`, `openclaw-win`; ключи в `~\.config\taskindex\<agent>.env`.

CLI сохраняет конверт до отправки в
`$XDG_STATE_HOME/taskindex/servers/<сервер>/agents/<агент>/ops` (агент
определяется по ключу через `GET /api/me`, поэтому Claude Code и Codex под одним
пользователем не пересылают конверты друг друга) и удаляет его только после
подтверждённого исхода своей операции. При неизвестном исходе используйте
`operation get` и `operation resume` с прежним идентификатором;
`operation list` показывает свою очередь и повреждённые файлы. Рядом лежит
`cursor.json` — позиция чтения этого агента: `digest|activity|inbox|events
--since last` читают от неё, `--commit` (или `cursor commit SEQ`) двигают её
только после полного обхода; в файле две позиции одного поколения — `seq` по
событиям и `operationSeq` по журналу операций (`activity --since last`,
`digest --since-op`, где видны отказы и операции без изменений). Входящие для
агента — `taskindex inbox`: комментарии владельца с текстом и задачей. Поля, которые владелец правил руками, прямая команда меняет
только с `--confirm-owner-fields` (след поручения; `focus` ставит только
владелец). `--dry-run` показывает эффект, но не заменяет поручение владельца.
Сервис не запускает агентов по расписанию и не пишет в Telegram, финансы или
другие внешние системы.

## Стили

Три слоя, каждый со своим правилом (TI-025, [план 08](docs/plans/2026-09-08-v2-review/08-styling-skin-and-dark-theme.md)).

| Слой | Где | Правило |
|---|---|---|
| Токены | `src/web/tokens.css` | единственное место с литералами цветов; имена семантические (`--muted-foreground`, `--surface-raised`), а не по компонентам |
| Примитивы | `src/web/ui/*`, `src/web/vendor/shadcn-base.css`, Tailwind, `tw-animate-css` | руками не редактируются, обновляются генератором и читают только токены |
| Скин | `@layer skin` в `src/web/styles.css` | композиция экранов; только `var(--…)`, без `!important` и без литералов цвета |

Порядок каскада объявлен один раз в `src/web/styles.css`
(`@layer theme, base, components, utilities, skin`), поэтому скин выигрывает у
утилит по слою, а не по `!important`. Единственное исключение —
`prefers-reduced-motion` в слое `base`.

В примитив скин заходит только через объявленный контракт: `[data-slot='…']`
(`data-slot="button"`, `"dialog-title"`, `"tabs-trigger"`, `"checkbox"` —
список виден в `src/web/ui/*.tsx`) или `data-sidebar`; селекторы вида
`.wrapper button` запрещены, потому что внутренняя разметка примитива меняется
при обновлении shadcn и Base UI. Собственная разметка приложения получает свой
класс и одноуровневый селектор.

Скин разрезан по экранам: один файл `src/web/skin/<экран>.css` на экран
(`base`, `sidebar`, `board`, `editor`, `activity`, `dialogs`, `auth`), каждый
подключается строкой `@import './skin/<экран>.css' layer(skin);` в `styles.css`.
Новый экран — новый файл и новая строка импорта; цвета только токенами, при
нехватке роли токен добавляется в `tokens.css`.

Гейт скина — `npm run check:skin` (`scripts/check-skin.mjs`), он входит в
`npm run check` и запускается отдельно, пока правится CSS: ни одного литерала
цвета вне `tokens.css`, ни одного `!important`, ни одного селектора внутрь
примитива мимо `data-slot`/`data-sidebar`, контраст пар токенов по WCAG 2.2 в
светлой и тёмной теме. Обновление примитива: `npx shadcn@latest add <компонент>`,
затем проверить, что `data-slot`, на которые опирается скин, не изменились, и
прогнать e2e-проекты `static` и `dark`.

Тёмная тема и скины проверяются не только в Chromium: движок WebKit ставится
отдельно (`npx playwright install webkit`), физическая приёмка на телефоне
описана в [docs/acceptance/phone.md](docs/acceptance/phone.md) (TI-018, TI-034).

## Проверки

```sh
npm run check
npm run build
npx playwright install chromium
npx playwright install webkit
npm run e2e
node scripts/gate.mjs
bash deploy/local-drill.sh
bash deploy/drill/deploy-drill.sh
```

`check` проверяет активное дерево v2: типы, lint, формат, скрипты развёртывания
(`npm run lint:shell`: `bash -n` и, если установлен, `shellcheck -S warning` по
`deploy/*.sh`) и unit/API/property/store/CLI тесты. `scripts/gate.mjs` — локальный
гейт релиза теми же командами, что jobs `check` и `e2e` в CI (по очереди), с отчётом
`test-results/gate.json`. Приёмка агентского цикла: `npm run agent-cycle` поверх sandbox
выполняет автоматизируемые шаги, ручные описаны в
[docs/acceptance/agent-cycle.md](docs/acceptance/agent-cycle.md). E2E запускает изолированные настоящие SQLite и Better Auth в `/tmp`
и пишет артефакты в `test-results/e2e-artifacts/`; эталон в
`docs/reference/v2-validation/` обновляется только отдельной командой
`npm run e2e:publish-reference`.

Проекты Playwright (`tests/e2e/playwright.config.ts`), у каждого своя чистая
база и своя пара портов:

| Проект | Что проверяет | Порты (web/API) |
|---|---|---|
| `setup` | вход владельца по паролю на каждой базе, сессия в `storageState` | все |
| `functional` | основной набор спек | 4173 / 4001 |
| `visual` | восемь эталонных снимков на замороженных часах | 4174 / 4002 |
| `static` | production-сборка через `src/server/index.ts` | 4373 |
| `dark` | те же сцены при `prefers-color-scheme: dark` | 4175 / 4003 |
| `webkit` | критический путь на `devices['Desktop Safari']` | 4176 / 4004 |
| `webkit-dark` | доска, редактор и лента WebKit в тёмной теме | 4177 / 4005 |

Порты в таблице — слот 0. `TASKINDEX_E2E_SLOT=N` (0–11) сдвигает все порты фикстур на
N×450, так что прогоны в разных слотах идут на одной машине одновременно; в CI раннер ПК
`winpc-taskindex-N` работает в слоте N, GitHub-hosted и локальный запуск — в слоте 0.
`TASKINDEX_E2E_PROJECTS` (проекты как в `--project`) поднимает серверы только этих
проектов, и `setup` входит только на их базах; так идёт каждый e2e-job в CI, без
переменной поднимаются все. Новый проект вписать в `PROJECT_SERVER`
(`tests/e2e/helpers.ts`).

Проекты не делят состояние: `setup` — зависимость остальных, порядок спек и
порядок проектов ни на что не влияет, любую спеку можно запустить одну
(`npm run e2e -- tests/e2e/regressions.spec.ts`) или проект целиком
(`npm run e2e -- --project webkit`). Проект `visual` — единственный, который
снимает эталон: у него заморожены и часы сервера, и часы браузера, поэтому два
прогона подряд дают одинаковый `screenshots-sha256.json`. Последняя команда создаёт отдельный Docker
project/volume и локальную реплику, проверяет восстановление и сохраняет
артефакты. `deploy/drill/deploy-drill.sh` идёт дальше: ставит релиз через
`deploy/bootstrap.sh` и прогоняет поверх него настоящий `deploy.sh` (~6–8 минут,
на macOS сам заворачивается в Linux-контейнер). Ни одна из них не подключается к
рабочему VPS или S3. `bash deploy/deploy.sh --plan …` печатает JSON плана и
ничего не меняет. Подробнее — [процедуры развёртывания](deploy/README.md).

Исходники первого приложения, его D1/Sites-конфигурация и тестовый загрузчик
удалены из рабочего дерева. Проверки прежнего поведения перенесены в Vitest.
Снимки исходного интерфейса и harness, извлекающий исходники из коммита
`4b780e4`, находятся в [docs/reference](docs/reference/ui-2026-09-08/README.md).

## Данные и переключение

Импорта прежних задач при переходе нет: рабочая v2 начинает с пустой базы.
Старая `.wrangler/state` вместе с незакоммиченными макетами и состоянием обеих
рабочих копий сохранена вне репозитория в проверенном архиве
`~/Backups/taskindex/before-main-consolidation-20260908-171413.tar.gz`.
Архив содержит локальные данные и секрет разработки; его права — 0600.
Старые runtime-каталоги и макеты удалены из проекта.
JSON export/import относится к резервированию v2; ключи и сессии в JSON не входят.
Физическая копия SQLite включает их. После физического восстановления обязателен
`mark-restored` и новый префикс репликации.

Для рабочего запуска нужны домен, VPS, S3-хранилище и секреты. Деплой начинает
новую попытку с закрытой записью, проверяет health и реплику, затем открывает
запись. После этой границы возврат старой базы требует отдельного решения,
поскольку может потерять уже принятые изменения. Перезапуск контейнера занимает
время; непрерывная доступность не обещается.

## Происхождение

Исходный интерфейс скопирован 2026-09-08 из `../os-tools/gosling-space/`, commit
`37799eea730f74323707bd0dee0b8d489a007d26`. Визуальный эталон v2 снят с TaskIndex
commit `4b780e4` на искусственных данных. Эталон воспроизводится из этого коммита
без старого кода в рабочей папке. Локальная v2 перенесена в `main` 2026-09-08.
