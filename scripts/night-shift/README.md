# Ночная смена, фаза 1

Спека: [docs/specs/2026-09-25-agent-proposals.md](../../docs/specs/2026-09-25-agent-proposals.md)
(§5.2 этапы 3 и 5, §5.3), план: [docs/plans/2026-09-25-proposals-phase1.md](../../docs/plans/2026-09-25-proposals-phase1.md)
(§1 контракт, §3 эта часть).

Ночью скрипт проверяет доску без нейросети и кладёт предложения в очередь
TaskIndex. Утром второй скрипт берёт до пяти предложений на сегодня и печатает
текст, который крон OpenClaw доставляет владельцу в Телеграм. Сами скрипты
ничего на доске не меняют: ключ умеет только предлагать, записывает Бобр после
«да» владельца.

## Что запускается

| Файл | Что делает |
|---|---|
| `run.sh` | Вход ночного крона. Готовит каталог состояния, запускает `run.mts`; если тот упал до записи отчёта, сам пишет `last-run.json` с `ok: false`. |
| `run.mts` | Прогон: `taskindex snapshot`, `taskindex events --all`, `taskindex proposals --status queued --all`, затем `taskindex proposal create --payload …` на каждый черновик, пока в очереди меньше 15. Пишет отчёт. |
| `audit.mts` | Правила проверки доски, чистые функции. |
| `report.mts` | Формат отчёта и окно чтения. |
| `io.mts` | Вызов CLI через `execFile` (без оболочки) и файлы каталога состояния. |
| `morning.mts` | Вход утреннего крона: читает `last-run.json`, вызывает `taskindex proposal deliver --limit 5`, для изменений задач `taskindex task get`, для названий `taskindex context`, печатает текст или `NO_REPLY`. |

Node 26 исполняет `.mts` напрямую, сборка не нужна: `node scripts/night-shift/run.mts`,
`node scripts/night-shift/morning.mts`. Проверки: `tests/unit/night-shift-*.test.ts`
(правила, отпечатки, золотые тексты утреннего сообщения, запуск `run.sh` без
сервера).

### Правила проверки доски

Архив и «Готово» не трогаются. На задачу не больше одного предложения, первое
совпавшее правило:

1. В названии дата `ДД.ММ` (совпадает со сроком или срока нет), и она прошла:
   `task.archive`, rank 3, «дата в названии прошла N дней назад». Отпечаток
   `audit:dated:<id>:<срок|none>:<revision>`.
2. Срок прошёл: `task.update` со сроком «сегодня + 7», rank 2, «срок прошёл
   ДД.ММ». P3 тоже. Отпечаток `audit:overdue:<id>:<срок>:<revision>`.
3. «Очередь» (`todo`), не P3, без срока и без будущей даты в названии, по
   журналу событий 14 дней и больше без движения: `task.archive`, rank 3,
   «N дней без движения». Движение: события задачи и её шагов, не
   `updatedAt`. Отпечаток `audit:stale:<id>:<seq последнего события>`.

Отказ владельца держится, пока задача не изменилась: отпечаток тот же, сервер
отвечает `existing: true`. «Сегодня» и часовой пояс берутся из снимка
(`today`, `timezone`), по умолчанию `Europe/Moscow`.

## Ключ

Агент `night-shift` («Ночная смена»), scope `propose`: все чтения, из записей
только `proposal create` и `proposal deliver`. Файл ключа
`~/.config/taskindex/night-shift.env` (0600), мастер-копия в 1Password.
Скрипты задают `TASKINDEX_AGENT=night-shift` при каждом вызове CLI; без этого
обёртка `~/.local/bin/taskindex` под шлюзом OpenClaw взяла бы ключ Бобра.
Файл ключа читает только обёртка.

`TASKINDEX_BIN` подменяет CLI: путь к исполняемому файлу или к `.js`, который
запускается текущим Node. Проверка в sandbox с настоящим CLI этой ветки:

```sh
eval "$(npm run -s sandbox)"   # ключ sandbox из TASKINDEX_URL и TASKINDEX_TOKEN
npm run build
TASKINDEX_BIN=dist/cli/index.js bash scripts/night-shift/run.sh
TASKINDEX_BIN=dist/cli/index.js node scripts/night-shift/morning.mts
```

`XDG_STATE_HOME` sandbox уводит и отчёт во временный каталог.

## Каталог состояния

`${XDG_STATE_HOME:-~/.local/state}/taskindex/night-shift/`, права 0700.

- `last-run.json` (0600), пишется атомарно: временный файл и переименование.

  ```json
  {
    "startedAt": "2026-09-26T01:30:00.000Z",
    "finishedAt": "2026-09-26T01:30:04.000Z",
    "ok": true,
    "window": { "from": "…", "to": "…" },
    "stages": {
      "board": { "tasks": 43, "drafts": 6, "created": 3, "existing": 3, "skippedByCap": 0 }
    },
    "errors": []
  }
  ```

  `tasks`: задачи снимка вне архива; `drafts`: черновики проверки;
  `created` и `existing`: ответы `proposal create`; `skippedByCap`: черновики,
  не отправленные из-за потолка очереди 15. `window`: от начала последнего
  успешного прогона, не больше 48 часов (в фазе 1 его читают только следующие
  этапы). `errors`: `{ stage, message }`; при падении `run.mts` до отчёта
  `run.sh` пишет `stage: "run"`, `window: null`, `stages: {}`.
- `run.stderr`: stderr последнего прогона `run.mts`.

Коды выхода `run.mts`: 0 прогон чистый, 3 отчёт записан с `ok: false`, другое:
падение. `run.sh` отдаёт 0 или 1. `morning.mts` всегда выходит с 0 и печатает
строку, даже если сломался сам («Утренние предложения не собраны: …»): крон
доставляет stdout, молчание спрятало бы сбой.

Утреннее сообщение начинается строкой «Ночная смена не отработала: причина»,
если отчёта нет, прогон не `ok` или закончился больше 26 часов назад; строка
уходит и без предложений. Нет ни предложений, ни сбоя: ровно `NO_REPLY`, OpenClaw
сообщение не отправляет. Повторный запуск в тот же день печатает тот же текст:
`deliver` идемпотентен.

## Кроны OpenClaw

Ставит ведущий после выпуска, когда ключ `night-shift` заведён на проде.
Оба крона запускают код из основного чекаута `/Users/dmitriy/code/5-management/taskindex`
(он всегда на выпущенном `main`), создаются выключенными.

Ночная смена, 04:30 по Москве, без доставки:

```sh
openclaw cron add \
  --name night-shift \
  --display-name 'Ночная смена (04:30)' \
  --declaration-key night-shift:v1 \
  --description 'Проверка доски TaskIndex без нейросети: предложения в очередь, отчёт last-run.json; без доставки' \
  --cron '30 4 * * *' --tz Europe/Moscow --exact \
  --session isolated \
  --command-argv '["/bin/bash","/Users/dmitriy/code/5-management/taskindex/scripts/night-shift/run.sh"]' \
  --command-cwd /Users/dmitriy/code/5-management/taskindex \
  --timeout-seconds 300 --output-max-bytes 4000 \
  --no-deliver \
  --disabled
```

Утреннее сообщение, 10:00 по Москве, доставка владельцу в Телеграм:

```sh
openclaw cron add \
  --name proposals-morning \
  --display-name 'Предложения TaskIndex (10:00)' \
  --declaration-key proposals-morning:v1 \
  --description 'До 5 предложений TaskIndex на сегодня владельцу; NO_REPLY, если показывать нечего и сбоя нет' \
  --cron '0 10 * * *' --tz Europe/Moscow --exact \
  --session isolated \
  --command-argv '["/Users/dmitriy/.local/bin/node","/Users/dmitriy/code/5-management/taskindex/scripts/night-shift/morning.mts"]' \
  --command-cwd /Users/dmitriy/code/5-management/taskindex \
  --command-env TASKINDEX_AGENT=night-shift \
  --command-env TASKINDEX_BIN=/Users/dmitriy/.local/bin/taskindex \
  --timeout-seconds 120 --output-max-bytes 12000 \
  --announce --channel telegram --to 6065935464 \
  --disabled
```

Дальше по плану §4 п.5: `openclaw cron run <id ночной смены>`, проверить
`last-run.json`; утренний текст посмотреть руками
(`TASKINDEX_AGENT=night-shift node scripts/night-shift/morning.mts`; этот
вызов уже показывает предложения сегодняшним днём, повтор в тот же день даёт
тот же набор); затем `openclaw cron enable <id>` для обоих.
