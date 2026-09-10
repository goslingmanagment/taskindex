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
   обновление сертификата через настроенный timer certbot.
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
