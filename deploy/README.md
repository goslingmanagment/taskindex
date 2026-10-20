# TaskIndex: локальная проверка и VPS

Один Linux VPS, Docker Compose v2 и Nginx на хосте. Публичный доступ — обычный
HTTPS URL. SQLite находится в локальном Docker named volume; macOS не открывает
тот же файл, который используют Linux-контейнеры. Прод работает на `agency-de`
(`root@152.53.191.242`), адрес — `https://tasks.gosling-agency.ru`.
CI готовит образ; доставку и деплой выполняет запущенный с мака `release.sh`
(раздел «Следующий релиз»).

Параметры действующего развёртывания лежат на сервере в
`/etc/taskindex/taskindex.env`. `.env.example` перечисляет параметры для нового
окружения, не назначает реальные ресурсы. Env-файл хранить вне git; команды с
секретами из 1Password запускать через `op run --env-file`.
Не выводить `docker compose config`, env или ключи в журнал: для проверки есть
`docker compose config --quiet`.

## Локальная проверка Docker

Нужны Docker daemon, Compose с поддержкой `!reset`, Bash и jq. Из корня репозитория:

```sh
bash deploy/local-drill.sh
# Или, если образ уже собран:
TASKINDEX_IMAGE=taskindex:v2-drill bash deploy/local-drill.sh --skip-build
```

Drill создаёт отдельный проект и named volume с уникальными именами. Host-порты
не публикуются. Тестовые пароль и API-ключ не используются вне этого окружения;
ключ создаётся в файле volume с mode 0600 и не печатается. Последовательность:
миграции → владелец/агент/ключ → снимок релиза и `current.json` → held/open →
команда настоящего CLI → restart того же deployment → подтверждённая реплика →
backup → восстановление Litestream по точному TXID → полное сравнение экспортов →
физическое восстановление с новым generation и отдельным prefix → команда → чтение
новой реплики. В кандидат намеренно вносится несовместимая схема; тот же
`rollback.sh`, который вызывает deploy.sh, запускается из снимка релиза и
восстанавливает прежний образ, конфигурацию и финальную копию. Повтор rollback
после открытия записи должен отказать до любых изменений. Копии и volume не
удаляются; сервисы останавливаются. В конце печатаются имена сохранённых
артефактов. Это проверка локального file backend Litestream, не доступности S3.

Все пробы `/health` идут через `deploy/health.mjs` внутри образа (та же проба —
healthcheck compose, `wait_health` в `common.sh`, `deploy.sh`, `rollback.sh`);
программы drill лежат в `deploy/drill/*.mjs` и монтируются в контейнер
read-only, образ ради них не пересобирается.

### Испытание настоящего `deploy.sh`

```sh
bash deploy/drill/deploy-drill.sh            # ~6–8 минут; на macOS сам заворачивается в Linux-контейнер
bash deploy/drill/deploy-drill.sh --only plan,before-stop
```

Harness (TI-017) собирает из текущего чекаута одноразовый git-репозиторий с тремя
релизами (A; B = `compose.yml` с `TASKINDEX_RELEASE_MARKER: B`; C = маркер C),
строит образы как CI (метка `org.opencontainers.image.revision` = commit),
ставит релиз A через `deploy/bootstrap.sh`, создаёт задачу через CLI и прогоняет
настоящий `deploy/deploy.sh` по матрице: `guard` (`TASKINDEX_FAIL_AT` вне
изолированного проекта отвергается до любых действий), `image-missing` и
`image-label` (отказ до `dc stop`), `lock-held`, `plan` (с Docker и без),
`before-stop`, `after-migrate`, `health` (после каждого снова работает A со своей
конфигурацией и образом, `current.json` указывает на снимок A, чекаут возвращён
на ветку), `deploy` (A→B без инъекции: B с маркером, снимок `releases/<B>/` из
пяти файлов с верными sha256), `after-open` (B→C: stderr содержит `Automatic
database rollback is forbidden`, работает C, запись открыта, `current.json`
в `opening`, задачи на месте, чекаут остаётся на C, новая задача принимается).
Алгоритм деплоя в harness не дублируется: он только наблюдает контейнеры,
`current.json`, чекаут и данные. Стенд и volume не удаляются; команда удаления
по точным именам печатается в итоговом JSON.

`deploy.sh` требует Linux, поэтому на macOS harness запускает себя внутри
контейнера `deploy/drill/Dockerfile.tools` (`docker:cli` + bash/jq/curl; первая
сборка ставит пакеты Alpine) с `docker.sock` хоста; чекаут и стенд
(`/tmp/taskindex-deploy-drill/run-<id>/`) монтируются по тем же абсолютным путям,
что и на хосте, иначе bind-mount compose и build context не совпали бы. Реальная
проверка `uname` в `deploy.sh` при этом не подменяется.

## Первая установка на VPS

Подготовить Docker Engine/Compose, Nginx, certbot, git, curl, jq и flock. Порт
3100 привязан только к 127.0.0.1. Определить HTTPS домен (Let's Encrypt не
проверяет имена sslip.io/nip.io с части своих валидаторов — нужна настоящая
A-запись) и место реплики: отдельный S3 prefix либо `file:///data/replica/NAME`
на том же диске плюс копии на мак (раздел «Копии на маке»). UID 1000 контейнеров
должен владеть volume; Dockerfile задаёт владельца `/data` для нового named volume.
Снимок релиза пишется под `umask 077`, поэтому `common.sh` делает
`litestream.yml` читаемым (0644): контейнер Litestream работает от uid 1000, и на
настоящем Linux 0600 даёт `permission denied` (первая установка 2026-09-11);
Docker Desktop на macOS этого не показывает.
Better Auth использует `X-Real-IP`, который Nginx перезаписывает адресом клиента,
для ограничения частоты входа и сессий. Node доступен только через этот proxy
и локальный порт хоста; клиентский `X-Forwarded-For` не определяет его IP.

1. Создать защищённый env-файл по `.env.example`. `BETTER_AUTH_SECRET` — постоянный
   секрет установки; ротация не является частью обычного деплоя. `TASKINDEX_IMAGE`,
   `TASKINDEX_BUILD`, `TASKINDEX_DEPLOYMENT` нужны compose только до первого
   `current.json`; `bootstrap.sh` выставляет их сам.
2. Получить образ релиза из CI (раздел «Гейт релиза и образ из CI»): на VPS
   `git fetch && git checkout <commit>` (чекаут должен быть на том же коммите,
   что собран), перенести артефакт `taskindex-<commit>.tar.gz` и выполнить
   `docker load -i taskindex-<commit>.tar.gz`. `bootstrap.sh` отказывает, если
   метка `org.opencontainers.image.revision` образа не равна коммиту чекаута.
3. Установить одной командой; пароль владельца — через stdin (например, вывод
   `op read`), никогда флагом:

   ```sh
   op read 'op://VAULT/ITEM/owner-password' | op run --env-file=/protected/taskindex.env -- \
     bash deploy/bootstrap.sh --image taskindex:<commit> --owner-email ADDRESS \
       --agent claude-mac --label 'Клод на маке' --scope write --out /data/claude-key.json
   ```

   Скрипт повторяет прежние ручные шаги с guard'ами `deploy.sh`: проверка
   инструментов и env (`dc config --quiet`), отказ при работающем `app`, при уже
   существующем `current.json` и при базе в volume (`--existing-database` снимает
   последний запрет), проверка метки образа, `migrate` (миграции только в
   `drizzle/v2`; `TIMEZONE` читается только здесь), `create-owner`, агент и ключ
   по флагам (ключ — файл 0600 в volume, в stdout только id и путь; перенести в
   1Password доверенным локальным способом, файлы с секретами не коммитить, см.
   «Ключи агентов»), снимок релиза `deploy/.runtime/releases/<deployment>/` и
   `current.json`, `up -d app litestream`, `wait_health held`, подтверждённая
   реплика (`replica_txid == txid`). Запись остаётся закрытой (`writes:held`) до
   шага 5, если не передан `--open-writes`. В конце печатается JSON с `next`.
   Проверить `curl --fail http://127.0.0.1:3100/health`: `ok`, build = commit,
   `schemaVersion`, `dbWritable:true`, `writes:held`.
4. Получить TLS-сертификат через certbot. В `nginx/taskindex.conf` заменить
   `TASKINDEX_DOMAIN`, установить конфигурацию на хост, проверить `nginx -t` и
   применить её. Для первого certbot HTTP challenge сначала доступен только
   HTTP server block; TLS block включать после появления сертификата. Проверить
   обновление сертификата через настроенный timer certbot. Что делает блок 443
   и как это проверить, — в разделе «Nginx: публичная поверхность» ниже.
5. Открыть запись: `op run --env-file=... -- bash deploy/compose.sh exec -T app taskindex-admin open-writes`
   (или сразу `bootstrap.sh --open-writes`). Проверить `/health` с `writes:open`,
   вход по паролю, регистрацию passkey и вход по нему на телефоне. Выполнить
   тестовый агентский цикл в отдельном окружении из
   `docs/acceptance/agent-cycle.md`; тестовые задачи в рабочую базу не писать.

Дальше состояние установки живёт в `deploy/.runtime` (`current.json`, снимки
релизов); все следующие релизы — только через `deploy.sh`, ручной
`docker compose` с env-файлом больше не нужен.

`TASKINDEX_DEPLOYMENT` относится к попытке деплоя, не только к git commit.
`open-writes` сохраняет разрешённый id в базе. Перезапуск того же контейнера
остаётся open; новая попытка с новым id стартует held. `mark-restored` очищает
разрешение. Приложение должно закрывать SSE и завершать короткие запросы при
SIGTERM; Compose даёт ему 20 секунд, затем принудительно завершает. Принудительный
выход не считается успешным drain в `deploy.sh`.

## Ключи агентов

Admin-команды работают с базой напрямую и читают только `DATABASE_PATH`,
`TIMEZONE` (только `migrate`), `TASKINDEX_DEPLOYMENT` (только `open-writes`) и
`LOG_LEVEL`; `BASE_URL` и `BETTER_AUTH_SECRET` им не нужны, поэтому ключ можно
создать до того, как сервер вообще запущен:

```sh
docker compose -f deploy/compose.yml run --rm --no-deps -T app \
  taskindex-admin agent-key create --agent claude-mac --scope write --out /data/claude-key.json
docker compose -f deploy/compose.yml run --rm --no-deps -T app taskindex-admin agent-key list
docker compose -f deploy/compose.yml run --rm --no-deps -T app taskindex-admin agent-key revoke KEY_ID
docker compose -f deploy/compose.yml run --rm --no-deps -T app taskindex-admin agent rename claude-mac --label 'Claude Mac'
```

`agent rename` меняет подпись агента и его подпись на карточках, шагах и
комментариях (снимки `createdByLabel`, `doneByLabel`, `actorLabel`); журналы
событий и операций хранят подпись своего времени. Проверка экспорта сверяет
такие снимки агента по самому агенту, а не по подписи, поэтому копии после
переименования восстанавливаются. Открытые вкладки увидят новую подпись после
перезагрузки страницы.

Ключ имеет вид `ti_<43 символа base64url>`; в базе хранится только SHA-256
(таблица `agent_keys`), файл `--out` создаётся с mode 0600 и не перезаписывается.
`agent-key list` печатает `id`, `agentId`, `scope`, `name`, `createdAt` и
`revokedAt` (`null` у действующих). Гарантия отзыва (`agent-key revoke`,
`agent disable`, TI-001/TI-036): новые запросы с этим ключом получают 401 сразу
(проверка при каждом запросе); уже открытый SSE-поток закрывается не позже чем
через 25 с (доступ перепроверяется перед каждой доставкой и на каждом heartbeat,
`SSE_HEARTBEAT_MS`), поток завершается кадром `event: revoked`, после которого
клиент не переподключается с тем же ключом.

## Журнал и переменные сервера

Сервер читает переменные через `src/server/config.ts` (Zod; неверное значение
останавливает старт с именем поля, без вывода значения): `HOST` (в контейнере
`0.0.0.0`, в dev по умолчанию `127.0.0.1`), `PORT`, `BASE_URL`,
`BETTER_AUTH_SECRET` (не короче 32 символов), `DATABASE_PATH`, `BUILD`,
`TASKINDEX_WRITES`, `TASKINDEX_DEPLOYMENT`, `LOG_LEVEL`. `TIMEZONE` сервер не
читает: она нужна только `taskindex-admin migrate` при первой инициализации,
действующий пояс хранится в `settings`.

`LOG_LEVEL` принимает `debug|info|warn|error` (по умолчанию `info`). Журнал —
по одной JSON-строке на событие: первыми идут `level` и `time`, затем `event`
(`request`, `internal_error`, `post_commit_error`, …), `requestId` (значение
заголовка `x-request-id` клиента или сгенерированный UUID; тот же id сервер
возвращает в ответе), `method`, `path`, `actor`, `operationId`. `debug` и `info`
уходят в stdout, `warn` и `error` — в stderr; `docker compose logs app` показывает
оба потока. При необработанной ошибке клиент получает 500 с кодом `internal`
(без текста исключения), а в журнал попадает `internal_error` с `requestId`, по
которому запрос ищется в логе; тело запроса, заголовки и ключи в журнал не
попадают.

## Nginx: публичная поверхность

Блок 443 в `nginx/taskindex.conf` (решение владельца 2026-09-10, TI-056):

- `location = /health` отвечает только с `127.0.0.1` и `::1` (`allow`/`deny all`).
  Все потребители `/health` внутри периметра: `deploy.sh`, `rollback.sh`, drill и
  healthcheck compose ходят на `127.0.0.1:3100` мимо Nginx. Внешние мониторы
  доступности используют `GET /`, а не `/health`. Содержимое ответа не менялось.
- HSTS `max-age=31536000` без `includeSubDomains` и без `preload`: пока владелец
  не подтвердил, что на поддоменах нет HTTP-сервисов, поддомены не трогаем.
  Заголовок ставит только терминатор TLS; приложение HSTS не шлёт.
- `http2 on;` требует nginx ≥ 1.25.1 (Debian 13, Ubuntu 24.10+). На Debian 12
  (1.22) и Ubuntu 24.04 (1.24) удалить эту строку и написать `listen 443 ssl http2;`.
  Версию смотреть `nginx -v` при установке.
- `server_tokens off`, `ssl_session_cache`/`ssl_session_timeout`/`ssl_session_tickets off`,
  gzip для css/js/json/svg; для `/api/events/stream` gzip выключен явно, иначе
  модуль gzip буферизует SSE и игнорирует `no-transform`. Внутри `location` нет
  `add_header`, чтобы не терять наследование HSTS. Security-заголовки
  (`X-Frame-Options`, `nosniff`, CSP report-only) и `Cache-Control` для статики
  ставит приложение, не Nginx.

Проверка после `nginx -s reload` (D — домен):

```sh
curl -sI --http2 https://D/ | head -1                                # HTTP/2 200
curl -sI https://D/ | grep -i strict-transport                       # max-age=31536000
curl -s -o /dev/null -w '%{http_code}\n' https://D/health            # 403
curl -s http://127.0.0.1:3100/health                                 # на VPS: ok:true
curl -sI https://D/ | grep -i '^server:'                             # server: nginx, без версии
curl -sI -H 'Accept-Encoding: gzip' https://D/assets/<js> | grep -i content-encoding  # gzip
```

Синтаксис проверен 2026-09-10 в `nginx:stable-alpine` (1.30.4) с самоподписанным
сертификатом: `nginx -t` успешен; снаружи `/health` → 403, `/` → HTTP/2 с HSTS и
`server: nginx`; изнутри контейнера `/health` проходит к upstream.

## Гейт релиза и образ из CI

Релиз проходит через `.github/workflows/ci.yml` (решение владельца 2026-09-10,
TI-016/TI-068): job `check` на Node из `.node-version` выполняет `npm ci` и
`npm run check` (typecheck, oxlint, oxfmt, сборка, vitest); параллельно job
`e2e (functional-1)` ставит Chromium и гоняет смоук `npm run e2e`; артефакты
тестов уходят в `test-results-e2e-<sha>`. Jobs `e2e (functional-2)`, `e2e (visual)`
и `e2e (webkit)` — пропускаемые заглушки под прежние имена обязательных проверок
ruleset. Job `image` запускается после зелёного `check`
(параллельно с e2e) и только на `push` в `main` или тег `v*`: собирает `linux/amd64` образ
из того же `GITHUB_SHA` с `--build-arg BUILD=<sha>` и меткой
`org.opencontainers.image.revision=<sha>`, проверяет метку и публикует
`docker save | gzip` как артефакт workflow `taskindex-image-<sha>`
(`taskindex-<sha>.tar.gz` + `image-id.txt`). Реестра (GHCR) нет, автодеплоя из CI
нет: доставкой образа на VPS управляет `release.sh` (раздел «Следующий релиз»).

Артефакт образа живёт 7 дней. `release.sh` сначала ищет `taskindex:<sha>` на VPS и
артефакт не трогает, если образ там уже есть, поэтому откат на образ, который ещё
лежит на сервере (релиз и предыдущий к нему, см. очистку образов ниже), работает и
позже. Если образа на VPS нет, а артефакт истёк, образ нужно пересобрать: перезапустить
в прогоне этого коммита только job `image` (`gh run rerun <run-id> --job <id job image>`,
id даёт `gh run view <run-id> --json jobs`, его же печатает `release.sh`; GitHub позволяет
перезапуск в течение 30 дней), а не весь прогон с check и e2e; аварийно `deploy.sh --build-here`.
`release.sh` берёт самый новый неистёкший артефакт прогона.

CI запускается на PR, push в `main` и теги `v*`. В Draft jobs `check` и `e2e`
пропускаются; переход в Ready запускает проверки, возврат в Draft отменяет
прежний PR-прогон. Пропущенный Draft не подтверждает готовность релиза.
При переменной репозитория `CI_POOL=pc` все jobs,
включая `image`, идут на раннеры на ПК владельца, иначе и при любом перезапуске (в том числе
только job `image`) — на GitHub-hosted `ubuntu-24.04`. На ПК job `check` выполняет те же части
`npm run check` параллельно (`scripts/ci-parallel-check.mjs`).

Аварийный путь без CI — `deploy.sh --build-here` (сборка на VPS с
предупреждением; гейт при этом пропущен, использовать только когда CI недоступен).

## Следующий релиз

Одна команда с мака (TI-094, решение владельца 2026-09-15):

```sh
bash deploy/release.sh <sha>          # по умолчанию origin/main
bash deploy/release.sh <sha> --plan   # только план сервера, ничего не выкатывает
```

`release.sh` требует, чтобы коммит был в `origin/main`, ждёт зелёный push-прогон
workflow `ci` для него (`gh run watch --exit-status`), берёт у GitHub подписанную ссылку на артефакт
`taskindex-image-<sha>`, и VPS скачивает архив сам (`curl` в `/var/tmp`, `docker
load`; если `taskindex:<sha>` уже загружен, шаг пропускается), проверяет метку
`org.opencontainers.image.revision`, пушит коммит в голый репозиторий
`/opt/taskindex.git` (его `origin` чекаута `/opt/taskindex`), снимает копию
`pull-backup.sh`, на VPS переводит чекаут на `<sha>` и запускает `deploy.sh
--plan`, затем `deploy.sh` с переменными из `/etc/taskindex/taskindex.env`, после
чего снимает вторую копию и печатает `current.json`. Секреты на мак не читаются;
нужны `git`, `gh` со входом, `curl` и SSH до VPS. Переменные: `TASKINDEX_HOST`,
`TASKINDEX_REMOTE_REPO`, `TASKINDEX_REMOTE_BARE`, `TASKINDEX_REMOTE_ENV`,
`TASKINDEX_CI_WORKFLOW`.

Тот же порядок руками, если скрипт недоступен. `deploy.sh` сам не делает push,
merge или SSH; на этом VPS нет `op`, переменные сервера лежат в
`/etc/taskindex/taskindex.env` (root-only, вне git):

```sh
# на маке: коммит в голый репозиторий VPS и подписанная ссылка на артефакт
git push root@152.53.191.242:/opt/taskindex.git <sha>:refs/heads/main
# на VPS: скачать taskindex-image-<sha> по ссылке в /var/tmp, распаковать, docker load
docker load -i /var/tmp/taskindex-<sha>.tar.gz
cd /opt/taskindex && git fetch && git checkout --detach <sha>
set -a && . /etc/taskindex/taskindex.env && set +a
bash deploy/deploy.sh --plan --image taskindex:<sha> <sha>
bash deploy/deploy.sh --image taskindex:<sha> <sha>
```

`--image` принимает архив `docker save` (загружается `docker load`), ссылку на
реестр или локальный тег; без `--image` должен существовать `taskindex:<sha>`.
До остановки чего-либо `deploy.sh` проверяет, что метка
`org.opencontainers.image.revision` образа равна целевому коммиту, и отказывает
при несовпадении или отсутствии образа. `--plan` печатает JSON плана (repo,
`previousRef`, `target`, образ и его метка, будущий `deployment`, `runtimeDir`,
состояние lock, текущий `current.json`, снимок работающего релиза, путь копии,
фазы, `willChangeCheckout: true`, состояние Docker и работающего контейнера,
preflight: Linux, чистота чекаута, недостающие инструменты) и выходит, ничего не
создавая: ни `deploy/.runtime`, ни lock-файла, ни смены чекаута; работает и на
Mac без Docker (`docker: "unavailable"`).

Сам релиз: flock против второго деплоя, проверка образа, снимок конфигурации
кандидата, проба работающего релиза (`writes:open`) из образа кандидата по сети
compose, `git checkout --detach <sha>` (**побочный эффект**: чекаут VPS
переходит на коммит релиза; при отказе до открытия записи `deploy.sh` возвращает
его на прежнюю ветку или коммит, при отказе после открытия — оставляет на
кандидате), остановка app с проверкой кода выхода, подтверждённая точка реплики,
остановка Litestream, автономная SQLite backup API копия и manifest предыдущего
образа/конфигурации/схемы/generation/seq/TXID (`deploy/.runtime/last-backup.json`
и копия рядом с backup в volume), миграция, старт held, `wait_health`,
подтверждение реплики, open-writes, `wait_health open`. Перед вызовом
открывающей команды считается пересечённой граница: потерянный ответ не
позволяет считать запись закрытой и автоматически возвращать старую базу.

После `wait_health open` и записи `current.json` скрипт убирает устаревшие
образы `taskindex:<sha>`: остаются образ нового релиза, образ предыдущего (это
его rollback) и образы работающих контейнеров, остальные удаляются, кеш сборки
старше недели чистится (`prune_superseded_images` в `common.sh`). Ошибка на
этом шаге печатается и не считается ошибкой релиза; внутри изолированного
compose-проекта (drill) шаг пропускается. Причина: каждый релиз загружает ещё
один образ ~1 ГБ, и 2026-09-18 двадцать таких образов делили диск VPS с Agency
Hub, когда тот перевалил 90 %.

### Снимки релизов и `current.json`

Каждый релиз (bootstrap, deploy, откат) записывает снимок своей конфигурации в
`deploy/.runtime/releases/<deployment>/`: `compose.yml`, `litestream.yml`,
`common.sh`, `rollback.sh` и `release.json` (`deployment`, `commit`, `image`,
`imageId`, `createdAt`, `source`, sha256 каждого файла). Секретов в снимке нет —
значения приходят из `op run`. `current.json` содержит `image`, `imageId`,
`build`, `deployment`, `replicaUrl`, `status` (`candidate` → `opening` → `open`,
`recovering` при откате) и `release` — путь к снимку; `dc()` в `common.sh`
использует compose-файл из этого снимка (`TASKINDEX_COMPOSE_FILE`), поэтому
`bash deploy/compose.sh ...` и `deploy.sh` всегда работают с конфигурацией именно
работающего релиза, а не с тем, что сейчас в чекауте. Сборка (`build:`) вынесена в
`deploy/compose.build.yml` и в снимок не входит.

Откат берёт конфигурацию из снимка предыдущего релиза (`previousRelease` в
`last-backup.json`): `on_failure` вызывает `rollback.sh` из этого каталога, а тот
проверяет sha256 файлов по `release.json`, экспортирует `TASKINDEX_COMPOSE_FILE`
снимка и в конце записывает `current.json` с `release` предыдущего релиза. Если
снимок отсутствует, откат отказывает до опасных действий, а `compose.sh`
отказывается подставлять чекаут вместо него. Первый релиз после появления
снимков (в `current.json` нет `release`): `deploy.sh` снимает копию
`deploy/` чекаута **до** `git checkout` как конфигурацию работающего релиза с
`source: "checkout-before-deploy"` и печатает предупреждение; сделать такой релиз
без изменений `compose.yml`/`litestream.yml`. Установка через `bootstrap.sh` этот
режим не использует.

Состояние и manifests находятся в `deploy/.runtime`, копии — `/data/backups`.
Скрипты не удаляют их. Пару «старый образ + копия + снимок» хранить минимум
неделю. Прямой вызов Compose с устаревшим env-файлом может вернуть прежний образ
или prefix; использовать `deploy/compose.sh`.

Если миграция или проверка кандидата не удалась до открытия записи, deploy.sh
вызывает `rollback.sh` из снимка: остановка app и Litestream, проверка остальных
контейнеров на volume, карантин старых файлов, финальная копия + совместимый
образ + его конфигурация, новый generation, новый соседний prefix репликации,
held health и восстановление новой подтверждённой точки реплики. Только после
всех проверок открывается запись. Неподдержанный backend, неоднозначный URL или
провал проверки оставляет сервисы остановленными и возвращает ошибку; старые
копии остаются. Отказ до остановки (`before-stop`) ничего не трогает; отказ
между остановкой и миграцией перезапускает прежний релиз без отката базы. После
open-writes автоматический rollback запрещён; граница записывается перед вызовом
команды, так что потерянный ответ не разрешает возврат базы. Для репетиции
предусмотрены точки `TASKINDEX_FAIL_AT=before-stop|after-migrate|health|after-open`;
`deploy.sh` принимает переменную только внутри изолированного
`TASKINDEX_COMPOSE_PROJECT` (harness `deploy/drill/deploy-drill.sh`). Перед
рабочим переключением остаётся обязательный drill на выбранном S3 backend: успех
локального file backend его не заменяет.

## Копии на маке (решение владельца 2026-09-11)

Внешнего хранилища и получателя heartbeat нет: реплика Litestream лежит на том же
диске (`LITESTREAM_REPLICA_URL=file:///data/replica/taskindex`, точечное
восстановление и учения работают как прежде), а off-site копию снимает мак:

```sh
bash deploy/pull-backup.sh            # → ~/Backups/taskindex/<UTC>/{taskindex.db,export.json}
```

Скрипт делает согласованную копию через SQLite backup API внутри работающего
контейнера и `taskindex-admin export`, проверяет размер и JSON, хранит последние
30 датированных копий (`TASKINDEX_BACKUP_KEEP`). Другие папки каталога (`logs/`,
`releases/`, ручные) в счёт не входят и не удаляются. `release.sh` снимает две
копии за релиз, поэтому 30 копий покрывают меньше 30 дней, если релизов много.
Запускать по расписанию с мака (launchd, раз в сутки) или руками перед
рискованными операциями. `LITESTREAM_HEARTBEAT_URL` при этом пустой — heartbeat
выключен (проверено на 0.5.12), `AWS_*` не нужны. Восстановление из копии —
раздел «Восстановление»: `quarantine-and-install <копия>` плюс `mark-restored`.

Расписание на маке: `~/Library/LaunchAgents/ru.gosling-agency.taskindex-backup.plist`,
каждый день в 04:30, логи в `~/Backups/taskindex/logs/`. Задание запускает копию
скрипта `~/Backups/taskindex/pull-backup.sh`, а не файл репозитория. После
изменения `deploy/pull-backup.sh` и слияния в `main` обновить копию из основного
чекаута; путь в plist не меняется, перезагружать задание не нужно:

```sh
install -m 700 deploy/pull-backup.sh ~/Backups/taskindex/pull-backup.sh
```

## Мониторинг репликации и RPO

При здоровой репликации кадры WAL уходят в реплику каждые `sync-interval`
(по умолчанию 1 с), поэтому ожидаемая потеря данных при внезапной гибели VPS
измеряется секундами. Локальный `/health` приложения о реплике ничего не знает
и остаётся зелёным при истёкших ключах S3, закрытом bucket или сетевой ошибке.

Dead-man switch (TI-002, решение владельца 2026-09-10): `deploy/litestream.yml`
содержит `heartbeat-url: ${LITESTREAM_HEARTBEAT_URL}` и `heartbeat-interval: 1m`.
Litestream отправляет `GET` на этот URL не чаще раза в минуту и только когда все
базы успешно синхронизированы с репликой; получатель — чек healthchecks.io,
который оповещает владельца, если пинг не пришёл вовремя. Compose требует
переменную (`:?`), поэтому без URL сервис не стартует.

Единственный оставшийся шаг владельца: завести чек на healthchecks.io с периодом
1 минута и grace 3 минуты, назначить канал оповещения (Telegram или почта),
положить ping URL в 1Password и сослаться на него в env-файле
(`LITESTREAM_HEARTBEAT_URL=op://VAULT/ITEM/ping-url`). URL — секрет: знающий его
может подделывать пинги. Время обнаружения: период 1 мин × 3 пропуска, то есть
отказ репликации или гибель всего VPS виден не позже чем через 4–5 минут.

Что покрывает сигнал: недоступность реплики (права, ключи, bucket, сеть),
остановку контейнера Litestream и исчезновение VPS целиком. Что не покрывает:
запись при этом не закрывается автоматически — это отдельное продуктовое
решение, heartbeat только сигнализирует. Идущие в холостую минуты без записей
в базу пинги не прерывают: измерено на стенде (см. ниже), `idle:true`.

Локальный стенд: `bash deploy/local-drill.sh --heartbeat` поднимает приёмник
`deploy/drill/heartbeat-receiver.mjs` (сервис `heartbeat` в `compose.local.yml`,
без портов на хост) и проверяет три утверждения: пинг приходит при здоровой
реплике; при `chmod 000` каталога реплики `/health` остаётся зелёным, но пинги
прекращаются; после `chmod 755` пинг приходит снова. Отдельно измеряется, идут
ли пинги при 2 минутах без записей (app на паузе). Ожидаемая строка:
`heartbeat: {"healthy":true,"broken":false,"recovered":true,"idle":true}`;
`--heartbeat` удлиняет drill примерно на 8 минут. Результат 2026-09-10 на
Litestream 0.5.12: все три проверки прошли, `idle:true`; фактическая
периодичность пингов 60–75 с (внутренний тик Litestream 15 с). Это проверка
локальной file-реплики, а не реального S3 и не реального получателя.

При алерте: `docker compose -f deploy/compose.yml logs litestream`, затем
`docker compose -f deploy/compose.yml exec -T litestream litestream sync -wait -json -socket /data/litestream.sock /data/taskindex.db`
(`replica_txid` должен совпадать с `txid`; это и есть последняя подтверждённая
точка реплики), проверка ключей S3 и bucket. Восстановление из реплики — раздел
«Восстановление» ниже; репетиция restore из реального S3 на пустом стенде
остаётся отдельной задачей владельца.

## Восстановление

Для физической замены прекратить admin-записи, остановить **app и Litestream**,
проверить `docker compose ps -a` и отсутствие оставшихся контейнеров/admin-процессов
с подключениями к тому же volume. Использовать образ из manifest копии и
конфигурацию из снимка `previousRelease` (`deploy/.runtime/releases/<deployment>/`),
а не из текущего чекаута.

1. Восстановить нужный TXID в отдельный путь, например средствами Litestream
   `restore -txid HEX -o /data/backups/recovered.db /data/taskindex.db`. Не использовать
   `-force` поверх рабочей базы. Проверить `PRAGMA integrity_check` и
   `PRAGMA foreign_key_check`. Произвольная отметка HTTP-экспорта не задаёт точный
   restore point; предварительно подтвердить TXID и возможность его восстановления.
2. Сохранить прежнюю базу вместе с её `-wal`, `-shm`, sidecar `<база>.generation`
   и локальным tracking Litestream отдельно. Помощник `node deploy/database.mjs quarantine-and-install /data/backups/recovered.db`
   делает это только при `TASKINDEX_OFFLINE_RESTORE=confirmed-no-open-connections`.
   Это явное подтверждение проверенного offline-состояния оператором, не проверка
   открытых файлов самим помощником. Он не удаляет файлы и не запускает сервисы.
3. Запустить `taskindex-admin mark-restored` **предыдущим совместимым образом**.
   Для `docker compose run` заранее выставить matching TASKINDEX_IMAGE/BUILD.
   Создать новый TASKINDEX_DEPLOYMENT. Для новой ветки истории репликации указать
   **новый пустой S3 prefix**, сохранив старый prefix и его историю. Не включать
   `auto-recover` и не удалять старую удалённую реплику ради сброса tracking.
4. Поднять app и Litestream с новым prefix и writes:held. Проверить generation,
   схему/build, выполнить sync -wait и **восстановить новую подтверждённую точку
   в третий временный путь**, проверив её generation. Только после этого open-writes.
   Сохранить новый replica URL в защищённом env-файле и manifest установки, иначе
   следующий ручной Compose может вернуть старый prefix.

Перед переключением и затем раз в квартал повторять полный drill: остановить
app, подтвердить реплику, остановить Litestream, снять backup и точный TXID,
возобновить работу; на двух временных копиях сравнить полный admin export до
mark-restored (исключить только exportedAt), затем проверить вход, команду, SSE,
новое generation и отдельную тестовую реплику. Ключи/сессии есть в физической копии,
но отсутствуют в JSON export: после `admin import` их и владельца создают заново.

JSON import — только offline admin-команда. Без `--replace` целевая база должна
быть пустой. Указание `--replace` разрешает заменить данные; наличие файла само по
себе не является таким разрешением.

## Curl-проверка контракта на тестовом окружении

Подставить токен через `op` в TASKINDEX_TOKEN. Получить `GET /api/context`, взять
generation, отправить `POST /api/commands` с фиксированным operationId и
`task.create`, повторить тот же конверт. Должна быть одна задача и один результат
операции. Прочитать `GET /api/events?generation=G&since=0`; открыть SSE с тем же
курсором. Отправить task.update с устаревшей baseRevision по конфликтующему полю:
ожидается 409/current; отправить независимое изменение — допускается слияние.
С ключом read запись получает 403; без доступа чтение получает 401.

Основания конфигурации: [Litestream Docker](https://litestream.io/guides/docker/),
[control socket, retention и shutdown](https://litestream.io/reference/config/),
[подтверждённый sync](https://litestream.io/reference/sync/),
[точки восстановления](https://litestream.io/reference/restore/),
[tracking при восстановлении](https://litestream.io/docs/troubleshooting/#operations-that-invalidate-tracking-state).
Версия образа закреплена на 0.5.12; обновление и изменение процедуры — отдельная проверка.
