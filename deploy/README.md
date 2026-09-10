# TaskIndex: локальная проверка и VPS

Один Linux VPS, Docker Compose v2 и Nginx на хосте. Публичный доступ — обычный
HTTPS URL. SQLite находится в локальном Docker named volume; macOS не открывает
тот же файл, который используют Linux-контейнеры. Никакие скрипты здесь не
отправляют код на VPS автоматически.

Не заданы владельцем: VPS, домен, S3 bucket/prefix, endpoint/region и ссылки на
секреты в 1Password. `.env.example` перечисляет параметры, не назначает реальные
ресурсы. Env-файл хранить вне git; запускать команды через `op run --env-file`.
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
миграции → владелец/агент/ключ → held/open → команда настоящего CLI → restart
того же deployment → подтверждённая реплика → backup → восстановление Litestream
по точному TXID → полное сравнение экспортов → физическое восстановление с новым
generation и отдельным prefix → команда → чтение новой реплики. В кандидат намеренно
вносится несовместимая схема; тот же `rollback.sh`, который вызывает deploy.sh,
восстанавливает прежний образ и финальную копию. Повтор rollback после открытия
записи должен отказать до любых изменений. Копии и volume
не удаляются; сервисы останавливаются. В конце печатаются имена сохранённых
артефактов. Это проверка локального file backend Litestream, не доступности S3.

## Первая установка на VPS

Подготовить Docker Engine/Compose, Nginx, certbot, git, curl, jq и flock. Порт
3100 привязан только к 127.0.0.1. Определить HTTPS домен и создать отдельный
S3 prefix только для этой базы. UID 1000 контейнеров должен владеть volume;
Dockerfile задаёт владельца `/data` для нового named volume.
Better Auth использует `X-Real-IP`, который Nginx перезаписывает адресом клиента,
для ограничения частоты входа и сессий. Node доступен только через этот proxy
и локальный порт хоста; клиентский `X-Forwarded-For` не определяет его IP.

1. Создать защищённый env-файл по `.env.example`. `BETTER_AUTH_SECRET` — постоянный
   секрет установки; ротация не является частью обычного деплоя. Указать
   `TASKINDEX_IMAGE=taskindex:<commit>`, `TASKINDEX_BUILD=<commit>` и уникальный
   `TASKINDEX_DEPLOYMENT=<attempt-id>`.
2. Выполнить `docker compose -f deploy/compose.yml build app`, затем
   `docker compose -f deploy/compose.yml run --rm --no-deps app taskindex-admin migrate`
   под этим окружением. Миграции лежат только в `drizzle/v2`.
3. Передать пароль владельца через stdin, например вывод `op read` в
   `docker compose -f deploy/compose.yml run --rm --no-deps -T app taskindex-admin create-owner --email ADDRESS`.
   Пароль никогда не передаётся флагом. Через admin создать агента и ключ:
   `agent create --id claude-mac --label 'Клод на маке'`, затем
   `agent-key create --agent claude-mac --scope write --out /data/claude-key.json`.
   Новый ключ сохраняется в файл 0600; в stdout только id и путь. Перенести его
   в 1Password доверенным локальным способом; файлы с секретами не коммитить.
4. `docker compose -f deploy/compose.yml up -d app litestream`. Проверить
   `curl --fail http://127.0.0.1:3100/health`: `ok`, нужные build/schemaVersion,
   `dbWritable:true`, `writes:held`. Проверить реплику командой
   `docker compose -f deploy/compose.yml exec -T litestream litestream sync -wait -json -socket /data/litestream.sock /data/taskindex.db`:
   `replica_txid` должен присутствовать и совпадать с `txid`.
5. Получить TLS-сертификат через certbot. В `nginx/taskindex.conf` заменить
   `TASKINDEX_DOMAIN`, установить конфигурацию на хост, проверить `nginx -t` и
   применить её. Для первого certbot HTTP challenge сначала доступен только
   HTTP server block; TLS block включать после появления сертификата. Проверить
   обновление сертификата через настроенный timer certbot. Что делает блок 443
   и как это проверить, — в разделе «Nginx: публичная поверхность» ниже.
6. Открыть запись командой `docker compose -f deploy/compose.yml exec -T app taskindex-admin open-writes`.
   Проверить `/health` с `writes:open`, вход по паролю, регистрацию passkey и вход
   по нему на телефоне. Выполнить тестовый агентский цикл в отдельном окружении
   из `tests/e2e/agent-cycle.md`; тестовые задачи в рабочую базу не писать.

`TASKINDEX_DEPLOYMENT` относится к попытке деплоя, не только к git commit.
`open-writes` сохраняет разрешённый id в базе. Перезапуск того же контейнера
остаётся open; новая попытка с новым id стартует held. `mark-restored` очищает
разрешение. Приложение должно закрывать SSE и завершать короткие запросы при
SIGTERM; Compose даёт ему 20 секунд, затем принудительно завершает. Принудительный
выход не считается успешным drain в `deploy.sh`.

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

## Следующий релиз

Запускать на VPS из чистого checkout. Скрипт не делает push, merge или SSH:

```sh
op run --env-file=/protected/taskindex.env -- bash deploy/deploy.sh COMMIT
```

Он закрепляет commit и образ, блокирует второй деплой через flock, собирает до
остановки сервиса, завершает app, подтверждает финальную точку реплики, останавливает
Litestream, снимает автономную SQLite backup API копию и manifest предыдущего
образа/схемы/generation/seq/TXID, мигрирует и стартует held. После правильного health
и подтверждения реплики вызывает open-writes. Перед вызовом открывающей команды
считается пересечённой граница: потерянный ответ не позволяет считать запись
закрытой и автоматически возвращать старую базу.

Состояние и manifests находятся в `deploy/.runtime`, копии — `/data/backups`.
Скрипты не удаляют их. Пару «старый образ + копия» хранить минимум неделю.
Для дальнейшего управления использовать `bash deploy/compose.sh ...`: обёртка
загружает image/build/deployment/replicaUrl из `deploy/.runtime/current.json` поверх
статических параметров env-файла. `deploy.sh` использует то же состояние, поэтому
следующий релиз сохраняет новый prefix репликации после отката. Секретов в этом
JSON нет. Прямой вызов Compose с устаревшим env-файлом может вернуть прежний образ
или prefix; его следует использовать только при первоначальной установке.

Если миграция или проверка кандидата не удалась до открытия записи, deploy.sh
вызывает `rollback.sh`: остановка app и Litestream, проверка остальных контейнеров
на volume, карантин старых файлов, финальная копия + совместимый образ, новый
generation, новый соседний prefix репликации, held health и восстановление новой
подтверждённой точки реплики. Только после всех проверок открывается запись.
Неподдержанный backend, неоднозначный URL или провал проверки оставляет сервисы
остановленными и возвращает ошибку; старые копии остаются. После open-writes
автоматический rollback запрещён; граница записывается перед вызовом команды,
так что потерянный ответ не разрешает возврат базы. Для репетиции предусмотрены
`TASKINDEX_FAIL_AT=after-migrate` и `TASKINDEX_FAIL_AT=health`; применять только в
выделенном тестовом окружении. Перед рабочим переключением остаётся обязательный
drill на выбранном S3 backend: успех локального file backend его не заменяет.

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
с подключениями к тому же volume. Использовать образ из manifest копии.

1. Восстановить нужный TXID в отдельный путь, например средствами Litestream
   `restore -txid HEX -o /data/backups/recovered.db /data/taskindex.db`. Не использовать
   `-force` поверх рабочей базы. Проверить `PRAGMA integrity_check` и
   `PRAGMA foreign_key_check`. Произвольная отметка HTTP-экспорта не задаёт точный
   restore point; предварительно подтвердить TXID и возможность его восстановления.
2. Сохранить прежнюю базу вместе с её `-wal`, `-shm` и локальным tracking Litestream
   отдельно. Помощник `node deploy/database.mjs quarantine-and-install /data/backups/recovered.db`
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
