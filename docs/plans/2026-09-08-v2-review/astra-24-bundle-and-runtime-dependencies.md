# 24. Зависимости и измеримая загрузка интерфейса

**Статус: запланировано; реализация по этому файлу не начата.**

Дата: 2026-09-08. Приоритет: **P3 для cleanup; P2 для открытой мобильной проверки**. Категория: Оптимизация, требующая измерений.

Покрытие: `Astra:S-07`, `BL-BUNDLE`. Источники: [01-stack.md](/Users/dmitriy/code/taskindex/docs/audits/2026-09-08-multiside-review/01-stack.md); [BACKLOG.md](/Users/dmitriy/code/taskindex/BACKLOG.md).

Код и контекст: [package.json](/Users/dmitriy/code/taskindex/package.json), [vite.config.ts](/Users/dmitriy/code/taskindex/vite.config.ts), [deploy/Dockerfile](/Users/dmitriy/code/taskindex/deploy/Dockerfile), [BACKLOG.md](/Users/dmitriy/code/taskindex/BACKLOG.md).

## Причина и наблюдаемое поведение

date-fns числится runtime-зависимостью без найденного использования. Browser-библиотеки попадают в общий install серверного образа; клиентская сборка содержит крупный chunk: около 1 034,22 kB JS / 299,05 kB gzip в проверенном snapshot. Сам размер не доказывает плохой запуск на телефоне.

## Что изменится и зачем

Убрать подтверждённо лишнее и сократить только измеренный критический путь загрузки, сохранив выбранный стек и простоту выпуска.

## Шаги реализации

1. Повторно проверить imports, build output и transitive usage date-fns перед удалением; менять package и lockfile вместе.
2. Построить отчёт состава bundle из production build, отделить auth/passkey, drag-and-drop, иконки, UI-примитивы и редкие экраны. Не угадывать вклад библиотеки по названию.
3. Измерить cold navigation на целевом телефоне: сеть, время загрузки/parse, готовность доски к вводу, повторный вход и memory. Сохранить стабильные условия baseline.
4. Если выявлен значимый вклад, отложить редкие экраны/тяжёлые диалоги через небольшие lazy boundaries. Предусмотреть loading/error состояния без сброса draft и неожиданных скачков layout.
5. Оценить минимальный runtime install/image: серверные зависимости и native SQLite должны оставаться согласованными. Разделение manifests делать только при доказанном выигрыше, учитывая усложнение обновлений.
6. Повторить те же измерения после изменения и записать gain/cost. Не менять React/Vite/Hono/SQLite ради предупреждения Vite.

## Проверки

- [ ] Чистые npm ci/check/build работают после cleanup; production server стартует с native SQLite.
- [ ] Cold phone сценарий быстрее или проще при равном поведении; после lazy import сохраняются auth, drag и повтор открытия диалога.
- [ ] Если выигрыш незначителен, оставить результаты измерения и не внедрять сложное разделение.

## Критерий готовности

Неиспользуемые зависимости убраны после проверки; решение о splitting основано на фактических метриках и не ухудшает надёжность.

## Зависимости и границы

Предварительно: [18. WebKit и приёмка на настоящем телефоне](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-18-browser-and-phone-acceptance.md).

Удаление transitive-only пакета или разделение node_modules может сломать сборку/адаптеры. Не объявлять задержку доказанной только по gzip-числу. BL-BUNDLE объединён с S-07, отдельной дублирующей задачи нет.

Общие правила выполнения и соответствие исходным находкам: [индекс Astra](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/ASTRA-INDEX.md).
