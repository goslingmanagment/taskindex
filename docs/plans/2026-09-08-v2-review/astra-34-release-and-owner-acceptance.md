# 34. Рабочая приёмка после исправлений

**Статус: запланировано; реализация по этому файлу не начата.**

Дата: 2026-09-08. Приоритет: **Перед рабочим переключением**. Категория: Оставшаяся продуктовая и эксплуатационная приёмка.

Покрытие: `BL-ACCEPTANCE`. Источники: [BACKLOG.md](/Users/dmitriy/code/taskindex/BACKLOG.md).

Код и контекст: [BACKLOG.md](/Users/dmitriy/code/taskindex/BACKLOG.md), [tests/e2e/agent-cycle.md](/Users/dmitriy/code/taskindex/tests/e2e/agent-cycle.md), [deploy/README.md](/Users/dmitriy/code/taskindex/deploy/README.md).

## Причина и наблюдаемое поведение

Локальные проверки не заменяют приёмку владельцем, фактический цикл Claude Code/Codex, реальный телефон и выбранные VPS/S3/TLS. Домен, инфраструктурные параметры и рабочее переключение остаются отдельными решениями.

## Что изменится и зачем

Подготовить один конкретный кандидат выпуска и комплект доказательств, затем выполнить согласованное рабочее переключение на выбранную инфраструктуру.

## Шаги реализации

1. Собрать кандидата после обязательных исправлений, зафиксировать commit/image/config и перечень оставшихся известных ограничений. Не коммитить и не развёртывать только по факту создания этого плана.
2. Дать владельцу локально проверить сохранённый вид доски, Activity на понятных действиях, историю/комментарии в сворачиваемых блоках и выбранное оформление. Палитры принимать по реальным сценам.
3. Пройти агентский цикл в Claude Code и Codex с разными тестовыми credentials: discover/read, create/sync, повтор unknown, конфликт, комментарий, история/digest, отзыв ключа. Проверить выбранную политику прав.
4. Выполнить физическую телефонную приёмку passkey и drag, зафиксировать ОС/браузер и результаты. Не подменять её Chromium emulation.
5. Подготовить полный reviewable deployment package: домен/VPS, TLS/Nginx, S3 backend/prefix, timezone, секреты через 1Password, backup-monitor receiver, restore/rollback runbook. Недостающие инфраструктурные значения запросить только когда они нужны для этого шага.
6. До реальной мутации получить отдельное поручение на выбранный сервер/выпуск. После него выполнить preflight, restore/drill на выбранном backend, запуск, health/CLI/backup check и предусмотренное открытие записи.
7. Сохранить результат и незакрытые пункты приёмки. Первая рабочая база по принятому решению без импорта прежних задач и без автоматического demo seed.

## Проверки

- [ ] Кандидат прошёл обязательный gate; реальная среда соответствует проверенному image и release config.
- [ ] Есть фактические результаты owner UI, двух агентских клиентов, физического телефона и восстановления из выбранного S3.
- [ ] После открытия записи подтверждены health, доступ, SSE/revocation, внешний backup signal и сохранение новой тестовой операции.

## Критерий готовности

Рабочая приёмка закрыта доказательствами всех обязательных пунктов; неподтверждённые проверки остаются открытыми, а не отмечаются выполненными по локальному аналогу.

## Зависимости и границы

Предварительно: [01. Отзыв доступа к уже открытому SSE](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-01-sse-access-revocation.md); [02. Постоянный контроль прогресса резервирования](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-02-backup-progress-monitoring.md); [03. Согласование snapshot и событий без отката состояния](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-03-snapshot-sse-ordering.md); [04. Подтверждение CLI-операций перед удалением outbox](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-04-cli-operation-acknowledgement.md); [05. Типизированные и проверяемые ответы web-клиента](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-05-web-response-contracts.md); [06. Обязательное сохранение web-операции до отправки](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-06-browser-storage-write-boundary.md); [07. Редактор и зависимые операции используют подтверждённую revision](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-07-confirmed-editor-revisions.md); [08. Курсор операций, включающий отказы и команды без изменений](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-08-operation-feed-cursor.md); [09. Сохранение окончательных доменных отказов](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-09-persist-domain-rejections.md); [10. Разделение ID проекта и служебных фильтров](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-10-project-id-filter-separation.md); [11. Устранение коллизии маршрута задачи by-origin](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-11-task-lookup-route-separation.md); [13. Неизменность применённых SQL-миграций](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-13-migration-checksums.md); [14. Совместимость таблиц, событий, результатов и клиентов](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-14-domain-contract-evolution.md); [15. Неизменяемая конфигурация выпуска для отката](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-15-immutable-release-rollback.md); [16. Обязательная проверка конкретного выпуска](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-16-release-validation-gate.md); [17. Испытания deploy.sh и его аварийных ветвей](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-17-deploy-entrypoint-failure-tests.md); [18. WebKit и приёмка на настоящем телефоне](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-18-browser-and-phone-acceptance.md); [27. Граница самостоятельных правок агента и решений владельца](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-27-agent-owner-authority-policy.md); [28. Постоянный Node 24 для проекта](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-28-permanent-node-runtime.md); [33. Сверка документации с реализованными контрактами](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-33-contract-documentation-reconciliation.md).

Этот файл — план, а не разрешение на commit, изменение VPS, отправку сообщений или перенос данных. Подготовка пакета выполняется до финального согласования рабочего действия; повторное согласование уже явно порученного действия не требуется.

Общие правила выполнения и соответствие исходным находкам: [индекс Astra](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/ASTRA-INDEX.md).
