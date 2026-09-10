# 23. Общий жизненный цикл намерения в формах

**Статус: запланировано; реализация по этому файлу не начата.**

Дата: 2026-09-08. Приоритет: **P3**. Категория: Улучшение сопровождаемости.

Покрытие: `Astra:Q-06`. Источники: [04-code-quality.md](/Users/dmitriy/code/taskindex/docs/audits/2026-09-08-multiside-review/04-code-quality.md).

Код и контекст: [src/web/app/dialogs.tsx](/Users/dmitriy/code/taskindex/src/web/app/dialogs.tsx), [src/web/app/editor.tsx](/Users/dmitriy/code/taskindex/src/web/app/editor.tsx), [src/web/app/store.ts](/Users/dmitriy/code/taskindex/src/web/app/store.ts).

## Причина и наблюдаемое поведение

QuickCreate, InlineCreate, ProjectDialog и TaskDiscussion повторяют управление draft/entityId/operationId/busy/unknown/ack с различиями очистки после ошибок. Правка правила повторов требует нескольких согласованных изменений и рискует потерять намерение.

## Что изменится и зачем

Общие гарантии сохранения и повторов задаются одним небольшим controller/hook; предметные поля, markup и разрешение конфликтов остаются в конкретной форме.

## Шаги реализации

1. Составить таблицу состояний intent: editing, persisted, sending, unknown, success, definitive rejection. Зафиксировать, когда допустимо создать новый operationId и когда можно очистить draft.
2. Выделить controller, который управляет стабильными ID, persisted envelope, flight, сохранением текста и подтверждённой очисткой. Не переносить туда JSX и правила task/project.
3. Ввести конкретные draft types для создания/редактирования. Не представлять ещё не созданную задачу фиктивным полным Task с revision=0.
4. Переносить формы по одной, начиная с двух простых create-путей. Сверять terminal error/reset/close/reopen с таблицей, оставляя сложный conflict UI в редакторе.
5. Согласовать controller с запретом отправки без storage и с confirmed base. Не создавать второй outbox или собственную конкурирующую queue.
6. После переноса удалить только действительно неиспользуемое дублирование; именовать намерение, draft и server entity различимо.

## Проверки

- [ ] Двойной submit, HTTP success, definitive rejection, unknown, close/reopen, reload и смена generation сохраняют установленный lifecycle.
- [ ] Одна общая проверка инварианта ID/persist плюс небольшой интеграционный сценарий каждой формы.
- [ ] Текст не очищается до подтверждения, а повтор unknown отправляет исходный envelope.

## Критерий готовности

Общие правила больше не расходятся между формами; предметные конфликты не скрыты универсальной абстракцией.

## Зависимости и границы

Предварительно: [04. Подтверждение CLI-операций перед удалением outbox](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-04-cli-operation-acknowledgement.md); [06. Обязательное сохранение web-операции до отправки](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-06-browser-storage-write-boundary.md); [07. Редактор и зависимые операции используют подтверждённую revision](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-07-confirmed-editor-revisions.md); [22. Проверка формата сохранённых черновиков и outbox](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-22-persisted-drafts-and-outbox-schemas.md).

Начинать рефакторинг до исправления семантики означает закрепить ошибку в общем hook. Не объединять разные сущности только из-за внешне похожих полей.

Общие правила выполнения и соответствие исходным находкам: [индекс Astra](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/ASTRA-INDEX.md).
