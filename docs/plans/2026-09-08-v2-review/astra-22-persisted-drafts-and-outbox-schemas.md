# 22. Проверка формата сохранённых черновиков и outbox

**Статус: запланировано; реализация по этому файлу не начата.**

Дата: 2026-09-08. Приоритет: **P3**. Категория: Риск повреждения/эволюции локального формата.

Покрытие: `Astra:Q-04`. Источники: [04-code-quality.md](/Users/dmitriy/code/taskindex/docs/audits/2026-09-08-multiside-review/04-code-quality.md).

Код и контекст: [src/web/app/drafts.ts:34](/Users/dmitriy/code/taskindex/src/web/app/drafts.ts:34), [src/web/app/store.ts:379](/Users/dmitriy/code/taskindex/src/web/app/store.ts:379), [src/cli/outbox.ts:61](/Users/dmitriy/code/taskindex/src/cli/outbox.ts:61), [src/web/app/dialogs.tsx:52](/Users/dmitriy/code/taskindex/src/web/app/dialogs.tsx:52).

## Причина и наблюдаемое поведение

DraftStorage проверяет только formatVersion, queued envelopes — в основном наличие ID/generation, CLI outbox тоже принимает неполную структуру. fields:null может дойти до формы и вызвать ошибку. Текущий writer такую форму не создаёт; это риск повреждения или будущей версии, а не доказанная штатная потеря данных.

## Что изменится и зачем

Локальные данные рассматриваются как внешняя граница: валидные восстанавливаются, известные старые форматы мигрируются, неизвестные сохраняются для восстановления и не отправляются.

## Шаги реализации

1. Определить отдельные versioned schemas для draft каждой формы, web envelope и CLI record. Общая обёртка не должна подменять конкретный тип fields.
2. Валидировать при чтении до помещения в memory cache/React state. Ограничить размеры и проверить ID/revision/generation и discriminant команды.
3. Для known old format реализовать явную миграцию с тестовой fixture. Unknown future format не пытаться автоматически привести кастом.
4. Повреждённые записи изолировать: оставить исходный raw и причину в recovery/quarantine, продолжить загрузку остальных. Не удалять пользовательский текст и не блокировать все read-команды одним файлом.
5. В CLI отделить безопасное перечисление директории от разбора каждого record, фильтровать собственные имена файлов и корректно сообщать о чужих/битых файлах.
6. В UI показать возможность скопировать/экспортировать непрочитанный черновик; автоматическая повторная отправка невалидного envelope запрещена.

## Проверки

- [ ] fields:null, missing payload, неверная revision, чужая formatVersion, truncated JSON и один повреждённый файл рядом с валидными.
- [ ] Known old fixture мигрирует с сохранением текста и operationId; unknown сохраняется raw и не отправляется.
- [ ] Один плохой draft не роняет редактор другого объекта; read CLI остаётся доступным.

## Критерий готовности

Ни одна непроверенная persisted структура не поступает в форму или send; повреждённые данные не исчезают молча.

## Зависимости и границы

Предварительно: [04. Подтверждение CLI-операций перед удалением outbox](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-04-cli-operation-acknowledgement.md); [06. Обязательное сохранение web-операции до отправки](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/astra-06-browser-storage-write-boundary.md).

Quarantine тоже может не записаться при недоступном storage: сохранить исходную запись и показать состояние, не удалять её до подтверждённого резервирования. Миграция формата не равна смене generation.

Общие правила выполнения и соответствие исходным находкам: [индекс Astra](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/ASTRA-INDEX.md).
