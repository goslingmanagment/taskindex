# Доказательства ревью Fable: скрипты, замеры, транскрипты

Скрипты, которыми агенты ревью и сверки воспроизводили находки. Перенесены из сессионного scratchpad 2026-09-08, чтобы владелец и исполнители планов могли повторить проверки. Импорты в скриптах указывают на модули репозитория абсолютными путями `/Users/dmitriy/code/taskindex/...`; при запуске из другого места пути нужно поправить. Все скрипты работают на `:memory:` или временных файлах SQLite и не трогают `data/`.

Запуск: Node 24.20.0, из корня репозитория.

```bash
node --import ./node_modules/tsx/dist/loader.mjs docs/plans/2026-09-08-v2-review/probes/repro/agent-undo-owner.mts
```

## `repro/` (отчёт `reports/review-3-bugs.md`)

| Скрипт | Находка | Ожидаемый вывод |
|---|---|---|
| `agent-undo-owner.mts` | B-01 агент `tasks` отменяет операцию владельца; B-02 агент ставит `focus` | `undo of owner archive -> 200`, `archived: false`; `focus:true task lands in group: selected` |
| `perf.mts` | B-03 линейный рост стоимости команды и ленты операций | 3,3 → 35,7 мс на команду при 0 → 4k событий; `/api/operations` 95 мс |
| `store-foreign-pending.mts` | B-04 операция прежнего поколения висит без удаления | `pending after 2nd reload: 1`, `finish is private` |
| `outbox-stray.mts`, `outbox-stray2.mts` | B-05 посторонний или битый файл в outbox ломает `list()` | `ArgumentError`, `SyntaxError` |
| `name-conflict-current.mts` | B-06 `current` при дубле имени проекта указывает на отклонённую запись | `current.id = p-second (existing is p-first)` |
| `drafts-scope.mts` | B-07 рост scope черновиков без Web Locks | `scopes=1 draftKeys=3` … `scopes=5 draftKeys=15` |
| `hono-use.mts` | Снятая гипотеза о пересечении лимитов тела | оба middleware матчат только свой путь |
| `health-write.mts`, `health-write2.mts` | Снятая гипотеза «`/health` пишет в базу» | `log` и `checkpointed` не растут, `data_version` не меняется |

## Корень `probes/` (отчёты `review-1-stack.md`, `review-2-architecture.md`, `review-5-ai-ready.md`)

| Скрипт | Что измеряет |
|---|---|
| `bench-events.ts` | стоимость `executeOperation` при 320 / 2 020 / 5 020 событиях (14 / 32 / 65 мс) |
| `bench-readstate.ts` | `readState` и `readEvents` отдельно |
| `wal-probe.mjs`, `sqlite-probe.mjs`, `bs3-probe.mjs` | `node:sqlite` против better-sqlite3: экспорты, WAL, холостой UPDATE |
| `openapi-probe.mts` | размер и состав `/api/openapi.json` (970 600 байт, 0 `operationId`) |

## `compare/` (сверка с ревью Astra, отчёты `reports/compare-*.md`)

| Файл | Что проверяет |
|---|---|
| `shared-outbox.mts` | A1: `operation resume` второго агента исполняет чужой конверт при общем `XDG_STATE_HOME` |
| `extra-probes.mts` | Расширения находок Astra: дубль id шага чеклиста без записи операции; асимметрия `since`/`until`; самовосстановление после старого snapshot; `by-origin` ломает только одиночный GET |
| `a01-rejected-variant.mts` | Astra A-01 без гонки: после отклонённого `move` редактор застревает на оптимистичной ревизии |
| `health-wal-probe.mts`, `health-write3.mts` | Повторный замер WAL на `/health`: 0 байт на холостой UPDATE |
| `astra-bench-rerun.json` | Повтор бенчмарка Astra: 253,7 мс на команду при 50k событий, lookup 1 106 мс |
| `astra-arch-probes-rerun.json` | Повтор проб Astra A-01 и A-03 |
| `quality-probes.out.jsonl` | Повтор пробы Astra Q-04, вывод побайтно совпал |

Копии скриптов Astra не переносились: оригиналы лежат в `docs/audits/2026-09-08-multiside-review/`.

## `transcripts/`

| Файл | Содержимое |
|---|---|
| `loop-a.txt` … `loop-e.txt` | Живой агентский цикл из `review-5-ai-ready.md`: около 70 вызовов CLI двумя ключами против временного сервера на `:3999` |
| `server.log` | JSON-лог сервера за этот цикл (`requestId`, `operationId`, `command`, `actor`, `code`, `durationMs`) |
| `check-static.log`, `vitest.log`, `e2e.log` | Базовые проверки под Node 24.20.0: tsc, oxlint, oxfmt, vitest 75/75, Playwright 18/18 |
| `epipe.txt` | A10: stack trace при `tasks --all \| head -c 50` |

Ключи в транскриптах и скриптах тестовые (`key-A`, `key-B`, ключи временной базы), рабочих секретов нет.
