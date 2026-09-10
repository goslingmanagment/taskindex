# 17. Испытания deploy.sh и его аварийных ветвей

**Статус: запланировано; реализация по этому файлу не начата.**

Дата: 2026-09-08. Приоритет: **P2**. Категория: Пробел проверки критического сценария.

Покрытие: `Astra:Q-05`. Источники: [04-code-quality.md](/Users/dmitriy/code/taskindex/docs/audits/2026-09-08-multiside-review/04-code-quality.md).

Код и контекст: [deploy/local-drill.sh](/Users/dmitriy/code/taskindex/deploy/local-drill.sh), [deploy/deploy.sh](/Users/dmitriy/code/taskindex/deploy/deploy.sh), [deploy/rollback.sh](/Users/dmitriy/code/taskindex/deploy/rollback.sh), [deploy/database.mjs](/Users/dmitriy/code/taskindex/deploy/database.mjs).

## Причина и наблюдаемое поведение

Существующий drill проверяет rollback/recovery, вызывая нужные части напрямую. Он не доказывает работу фаз deploy.sh, ERR trap, on_failure и состояния opened. Успешный прямой rollback не исключает неверное решение оркестратора при реальном отказе.

## Что изменится и зачем

Изолированный стенд запускает настоящий entrypoint deploy.sh и проверяет решения при сбоях по обе стороны открытия записи.

## Шаги реализации

1. Подготовить временный Linux/Docker стенд, искусственные данные, отдельные volumes и replica prefix, временный git repo с двумя release commits. Не использовать рабочую БД и production credentials.
2. Запускать тот же deploy.sh, который применяется при выпуске. Fault injection ввести через ограниченный тестовый adapter/контролируемую внешнюю зависимость, а не копию алгоритма в тесте.
3. Сделать сценарии отказа сборки/preflight, миграции, health, перед checkpoint/open-writes и после открытия записи. Для каждого заранее описать ожидаемый manifest, running image, writes state и судьбу новых данных.
4. Проверить ERR trap и exit code, сохранение первоначальной ошибки, повторный запуск после прерывания и неизвестный результат команды open-writes.
5. Добавить bash -n и выбранный shell-анализатор для deploy scripts, а также проверку deploy/database.mjs. Текущий npm check не считать автоматическим покрытием этих файлов.
6. Сохранять компактный отчёт и команду безопасного повторения. Удаление тестовых volumes выполнять только по их точным идентификаторам и согласно правилам рабочей среды.

## Проверки

- [ ] До open-writes отказ возвращает согласованный предыдущий выпуск; после открытия записи новые данные не теряются.
- [ ] Неизвестный outcome не превращается в уверенное предположение «запись ещё закрыта».
- [ ] Повторный запуск не использует чужой checkpoint/release; остановка контейнера и ошибка compose отражаются в результате.

## Критерий готовности

Есть исполняемая матрица реального entrypoint с фактическими доказательствами branch outcome, а не только прямого helper-вызова.

## Зависимости и границы

Предварительно: [15. Неизменяемая конфигурация выпуска для отката](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-15-immutable-release-rollback.md).

Дублирование production-скрипта в тесте даст ложную уверенность. Не оставлять свободно включаемую fault-injection переменную в рабочем окружении без защиты.

Общие правила выполнения и соответствие исходным находкам: [индекс Astra](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/ASTRA-INDEX.md).
