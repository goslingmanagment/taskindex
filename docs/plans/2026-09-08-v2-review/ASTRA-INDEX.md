# Планы по четырём ревью Astra: TaskIndex v2

**34 подробных плана, каждый в отдельном файле, все в этой папке. Реализация не начата.**

Актуальные статусы и объединённые находки Astra/Fable — в
[issues.md](/Users/dmitriy/code/taskindex/issues.md). Этот индекс сохраняет
навигацию по подробным планам; перед реализацией сверяйте выбранный план с
соответствующей карточкой реестра.

Дополнение: [сравнение исходных ревью Astra и Fable — совпадения, новые находки и расхождения](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/ASTRA-VS-FABLE.md).

Дата: 8 сентября 2026. Основание — [сводное ревью четырёх агентов gpt-6-astra xhigh](/Users/dmitriy/code/taskindex/docs/audits/2026-09-08-multiside-review/REPORT.md), текущее незакоммиченное дерево v2 и [открытый BACKLOG](/Users/dmitriy/code/taskindex/BACKLOG.md). Дополнительно включены отдельные планы тёмной темы и системы скинов по запросу владельца.

Это индекс файлов `astra-*`. Уже находившиеся рядом `README.md`, `08-styling-skin-and-dark-theme.md` и `reports/` относятся к независимому набору другого ревью и сохранены без изменений с нашей стороны. Его короткие ID совпадают по форме с нашими, но обозначают другие находки. Здесь `Astra:B-01` — отзыв SSE-доступа, а не одноимённая находка из соседнего отчёта. Перед реализацией пересекающиеся предложения нужно свести в один выбранный вариант; наличие двух планов не означает разрешение дважды переделать подсистему.

## Что покрыто

- Все **26 исходных ID**: S-01…S-07, A-01…A-05, B-01…B-08, Q-01…Q-06. Две пары дублей объединены: **S-01/A-02** и **Q-01/A-05**. Получается 24 плана по ревью.
- Два новых плана: тёмная тема и скины. В них нет обещания уже утверждённых палитр или редизайна навигации.
- Восемь самостоятельных планов по открытому BACKLOG; его проверка мобильного bundle объединена с S-07. Итого 34.
- Исходные доказательства не перенесены и не отредактированы: [стек](/Users/dmitriy/code/taskindex/docs/audits/2026-09-08-multiside-review/01-stack.md), [архитектура](/Users/dmitriy/code/taskindex/docs/audits/2026-09-08-multiside-review/02-architecture.md), [баги](/Users/dmitriy/code/taskindex/docs/audits/2026-09-08-multiside-review/03-bugs.md), [качество](/Users/dmitriy/code/taskindex/docs/audits/2026-09-08-multiside-review/04-code-quality.md).

В отчёте независимо воспроизведены **9 текущих дефектов: B-01…B-08 и A-01**. S-02 — отдельный пробел эксплуатационной готовности. A-03/A-04 описывают риски будущих изменений. Остальное включает измеренную стоимость запросов, качество и покрытие. Их нельзя складывать в число «34 бага». Права агентов из BACKLOG — открытая политика с подтверждённым поведением, а не уже принятый запрет.

## Сохранённые технические решения

React/Vite, Hono/Zod, SQLite/Drizzle, Better Auth, SSE и текущий набор проверок сохраняются. Ревью не доказало необходимости перехода на другую СУБД/framework/ORM. Основное улучшение — точные запросы, завершённые гарантии доступа/повторов/синхронизации и воспроизводимые проверки. При рефакторинге сохраняются единая транзакция state/events/result, actor/hash idempotency, полевая проверка конфликтов, атомарные batches, durable outbox и граница open-writes.

## Индекс планов

| Файл | Покрытие | Приоритет / тип |
|---|---|---|
| [01. Отзыв доступа к уже открытому SSE](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-01-sse-access-revocation.md) | B-01 | P1 — Подтверждённый дефект |
| [02. Постоянный контроль прогресса резервирования](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-02-backup-progress-monitoring.md) | S-02 | P1 — Пробел эксплуатационной готовности |
| [03. Согласование snapshot и событий без отката состояния](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-03-snapshot-sse-ordering.md) | B-02 | P2 — Подтверждённый дефект |
| [04. Подтверждение CLI-операций перед удалением outbox](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-04-cli-operation-acknowledgement.md) | B-03 | P2 — Подтверждённый дефект |
| [05. Типизированные и проверяемые ответы web-клиента](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-05-web-response-contracts.md) | S-04 | P2 — Архитектурное улучшение границы данных |
| [06. Обязательное сохранение web-операции до отправки](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-06-browser-storage-write-boundary.md) | B-08 | P2 — Подтверждённый дефект |
| [07. Редактор и зависимые операции используют подтверждённую revision](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-07-confirmed-editor-revisions.md) | A-01 | P2 — Подтверждённый дефект |
| [08. Курсор операций, включающий отказы и команды без изменений](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-08-operation-feed-cursor.md) | B-04 | P2 — Подтверждённый дефект с изменением контракта |
| [09. Сохранение окончательных доменных отказов](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-09-persist-domain-rejections.md) | B-05 | P2 — Подтверждённый дефект |
| [10. Разделение ID проекта и служебных фильтров](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-10-project-id-filter-separation.md) | B-06 | P2 — Подтверждённый дефект |
| [11. Устранение коллизии маршрута задачи by-origin](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-11-task-lookup-route-separation.md) | B-07 | P2 — Подтверждённый дефект |
| [12. Стоимость команд, истории и пагинации](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-12-indexed-reads-and-write-cost.md) | S-01, A-02 | P2 — Измеренная проблема масштабирования; один общий корень |
| [13. Неизменность применённых SQL-миграций](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-13-migration-checksums.md) | S-03 | P2 — Риск сопровождения данных |
| [14. Совместимость таблиц, событий, результатов и клиентов](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-14-domain-contract-evolution.md) | A-03 | P2; до первой доменной миграции — Будущий архитектурный риск |
| [15. Неизменяемая конфигурация выпуска для отката](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-15-immutable-release-rollback.md) | A-04 | P2; до изменения deploy-конфигурации — Будущий эксплуатационный риск |
| [16. Обязательная проверка конкретного выпуска](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-16-release-validation-gate.md) | S-06 | P2 — Пробел процесса выпуска |
| [17. Испытания deploy.sh и его аварийных ветвей](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-17-deploy-entrypoint-failure-tests.md) | Q-05 | P2 — Пробел проверки критического сценария |
| [18. WebKit и приёмка на настоящем телефоне](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-18-browser-and-phone-acceptance.md) | S-05 | P2 — Пробел покрытия целевого браузера |
| [19. Сохранение точных типов команд до обработчика](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-19-exhaustive-command-dispatch.md) | Q-01, A-05 | P2 по Q-01; P3 по A-05 — Дублирующаяся находка о качестве кода |
| [20. Диагностируемые ошибки и корреляция запросов](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-20-structured-error-diagnostics.md) | Q-02 | P2 — Пробел качества сопровождения |
| [21. Независимые свойства команд и Undo](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-21-independent-property-model.md) | Q-03 | P2 — Пробел качества тестов |
| [22. Проверка формата сохранённых черновиков и outbox](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-22-persisted-drafts-and-outbox-schemas.md) | Q-04 | P3 — Риск повреждения/эволюции локального формата |
| [23. Общий жизненный цикл намерения в формах](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-23-form-intent-lifecycle.md) | Q-06 | P3 — Улучшение сопровождаемости |
| [24. Зависимости и измеримая загрузка интерфейса](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-24-bundle-and-runtime-dependencies.md) | S-07, BL-BUNDLE | P3 для cleanup; P2 для открытой мобильной проверки — Оптимизация, требующая измерений |
| [25. Полноценная тёмная тема и общая основа оформления](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-25-dark-theme.md) | NEW-DARK | P2, отдельная продуктовая работа — Новый подробный план по запросу владельца |
| [26. Система скинов поверх общей темы](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-26-skins-system.md) | NEW-SKINS | P2, после основы темы — Новый подробный план по запросу владельца |
| [27. Граница самостоятельных правок агента и решений владельца](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-27-agent-owner-authority-policy.md) | BL-AUTHORITY | Решение до рабочей приёмки — Открытая продуктовая политика, не подтверждённое нарушение принятого контракта |
| [28. Постоянный Node 24 для проекта](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-28-permanent-node-runtime.md) | BL-NODE | P2; до воспроизводимой разработки — Подтверждённая проблема локального окружения в BACKLOG |
| [29. Понятный и согласованный счётчик Focus](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-29-focus-counter-semantics.md) | BL-FOCUS | P2 — Открытый UX-контракт с подтверждённым текущим поведением |
| [30. Русские ошибки и доступные имена интерфейса](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-30-russian-ui-and-accessible-labels.md) | BL-LOCALIZATION | P2 — Подтверждённый пробел локализации |
| [31. Единое русское склонение количества задач](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-31-russian-task-counts.md) | BL-PLURALS | P2 — Подтверждённый UI-дефект |
| [32. История изменений на языке пользователя](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-32-human-readable-history.md) | BL-HISTORY | P2 — Подтверждённый UX-дефект |
| [33. Сверка документации с реализованными контрактами](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-33-contract-documentation-reconciliation.md) | BL-DOCS | P2 — Подтверждённый дрейф документации |
| [34. Рабочая приёмка после исправлений](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-34-release-and-owner-acceptance.md) | BL-ACCEPTANCE | Перед рабочим переключением — Оставшаяся продуктовая и эксплуатационная приёмка |

## Предлагаемая очерёдность

1. **Доступ и сохранность.** [01. Отзыв доступа к уже открытому SSE](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-01-sse-access-revocation.md), [02. Постоянный контроль прогресса резервирования](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-02-backup-progress-monitoring.md), [06. Обязательное сохранение web-операции до отправки](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-06-browser-storage-write-boundary.md), [04. Подтверждение CLI-операций перед удалением outbox](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-04-cli-operation-acknowledgement.md). Локальную воспроизводимость из плана 28 можно подготовить параллельно. Продуктовую матрицу прав 27 обсуждать отдельно от технического отзыва credential.
2. **Текущие дефекты.** Snapshot 03 → confirmed editor 07; web boundary 05; отказы 09; ID/filter 10 и route 11. У операции без событий свой cursor 08 — сначала его миграционные предпосылки 13 → 14. Разные виды изменений не выпускать одним непрозрачным refactor.
3. **Выпуск и данные.** Checksums 13 → contract evolution 14; release artifacts 15 → entrypoint tests 17; validation gate 16 и browser matrix 18. Постоянный внешний backup signal 02 требует фактического получателя на этапе инфраструктурной приёмки.
4. **Стоимость и сопровождение.** Indexed reads 12, typed dispatch 19, diagnostics 20, independent properties 21, persisted formats 22 → form lifecycle 23; bundle 24 только по измерениям. Эти улучшения не требуют переписывать стек.
5. **Оформление.** [25. Полноценная тёмная тема и общая основа оформления](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-25-dark-theme.md) создаёт общую основу, Classic Light/Dark и preference contract. После него [26. Система скинов поверх общей темы](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-26-skins-system.md) добавляет реестр вариантов и preview. Зависимость односторонняя, двойной миграции CSS нет.
6. **Открытый UX и приёмка.** Focus 29, локализация 30, склонения 31, история 32; после решения прав — документация 33. Итоговая рабочая приёмка 34 сводит обязательные проверки. Новые скины не объявлены обязательным условием безопасного запуска, если владелец не выберет их в состав выпуска.

Номера файлов — адреса для обсуждения, а не жёсткая календарная последовательность. Зависимости каждого документа указаны в нём. Приоритеты P1/P2/P3 взяты из Astra-ревью; P0 соседнего набора с ними не отождествляется. Для Q-01/A-05 сохранено различие оценок двух ревьюеров.

## Решения, которые план не подменяет

| Вопрос | Предлагаемый вариант | Где |
|---|---|---|
| Самостоятельные права агента и новое поручение владельца | Явная матрица прямых команд/sync/Undo; не чинить только Undo | [27. Граница самостоятельных правок агента и решений владельца](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-27-agent-owner-authority-policy.md) |
| Смысл счётчика Focus | Все уникальные активные задачи раздела, new-agent отдельно при необходимости | [29. Понятный и согласованный счётчик Focus](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-29-focus-counter-semantics.md) |
| Режим темы | Как в системе / Светлая / Тёмная | [25. Полноценная тёмная тема и общая основа оформления](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-25-dark-theme.md) |
| Хранение оформления | Preference аккаунта с API/CLI; локальный cache только для первого paint | [25. Полноценная тёмная тема и общая основа оформления](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-25-dark-theme.md) |
| Первый каталог скинов | Classic и один дополнительный нейтральный вариант; палитры проходят визуальную приёмку | [26. Система скинов поверх общей темы](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-26-skins-system.md) |
| Backup interval и получатель | Внешний health-gated heartbeat; допустимые окна и канал задаются для выбранной инфраструктуры | [02. Постоянный контроль прогресса резервирования](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-02-backup-progress-monitoring.md) |
| Рабочая среда и выпуск | Конкретные домен/VPS/S3/timezone/секреты и immutable кандидат до поручения на deploy | [34. Рабочая приёмка после исправлений](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-34-release-and-owner-acceptance.md) |

Эти решения не мешают сейчас записать полные планы. Перед зависимой реализацией нужно проверить актуальные поручения владельца: уже принятые решения не запрашивать повторно, новые допущения не выдавать за согласованные.

## Общий порядок исполнения отдельного плана

- Сначала перечитать соответствующую находку и проверить, что она ещё существует в выбранном исходном snapshot. Working tree v2 не представлен старым HEAD; commit/hash будущего кандидата фиксировать явно.
- Для исправления бага сохранить минимальный regression, который падает до изменения и проходит после. Для рефакторинга проверять поведенческие инварианты, а не внутреннюю структуру новой реализации.
- Изменять одну причинную цепочку и прогонять проверки, соответствующие изменению. Код: `npm run check` и `npm run build` на поддерживаемом Node 24; browser/deploy/schema изменения добавляют свои конкретные проверки. Документации достаточно проверки ссылок/согласованности, без бессмысленного повторного E2E.
- Не запускать тесты на production DB/credentials. Browser artifacts складывать отдельно от принятых reference screenshots. Не перезаписывать визуальные эталоны обычным запуском теста.
- После исполнения записать: что изменено, проверенный revision, какие сценарии выполнены, что осталось открытым. Наличие файла плана не закрывает исходную находку.
- Эти документы не разрешают сами по себе commit, deploy, изменение VPS или внешние сообщения. Сначала подготовить конкретный результат; производственное действие выполнять по соответствующему поручению владельца.

## Доказательная база и предел проверки этих документов

В исходном аудите на Node 24.20.0 прошли typecheck/lint/format, 75 тестов, production build и 18 Chromium E2E. Координатор повторил девять воспроизведений. Локальный Litestream file-replica drill проверил recovery/rollback, но не фактический S3/VPS и не оркестрацию deploy.sh. [Машинный отчёт аудита](/Users/dmitriy/code/taskindex/docs/audits/2026-09-08-multiside-review/verification.json).

При составлении планов эти тесты не запускались заново: код в рамках этой работы не меняется. Проверка документов включает полноту ID, наличие 34 отдельных файлов, ссылки и ацикличность объявленных зависимостей. Состояние реализации всех новых планов остаётся «запланировано».

Фактическая проверка комплекта: 34 плана и этот индекс; все 26 ID покрыты; 281 локальная ссылка существует, указанные строки не выходят за границы файлов; циклов зависимостей и пробелов в конце строк нет. SHA-256 всех 112 файлов исходников/конфигурации/тестов из контрольного списка аудита совпадают с проверенным snapshot. Приложение, его данные и существующие документы другого ревью эта работа не изменяла.
