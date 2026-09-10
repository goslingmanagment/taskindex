# 19. Сохранение точных типов команд до обработчика

**Статус: запланировано; реализация по этому файлу не начата.**

Дата: 2026-09-08. Приоритет: **P2 по Q-01; P3 по A-05**. Категория: Дублирующаяся находка о качестве кода.

Покрытие: `Astra:Q-01`, `Astra:A-05`. Источники: [04-code-quality.md](/Users/dmitriy/code/taskindex/docs/audits/2026-09-08-multiside-review/04-code-quality.md); [02-architecture.md](/Users/dmitriy/code/taskindex/docs/audits/2026-09-08-multiside-review/02-architecture.md).

Код и контекст: [src/shared/commands.ts:230](/Users/dmitriy/code/taskindex/src/shared/commands.ts:230), [src/shared/schemas.ts](/Users/dmitriy/code/taskindex/src/shared/schemas.ts), [src/shared/model.ts](/Users/dmitriy/code/taskindex/src/shared/model.ts).

## Причина и наблюдаемое поведение

После проверки discriminated union обработчик стирает payload до Record<string, unknown> и восстанавливает поля кастами. Ветка checklist по startsWith имеет неявный остаточный вариант. Новая команда может компилироваться без полного корректного обработчика.

## Что изменится и зачем

Добавление команды требует согласованной схемы и исчерпывающего обработчика; проверенные поля доходят до reducer без повторного угадывания типа.

## Шаги реализации

1. Вывести Command и payload types из существующего набора схем там, где это устраняет ручной дублирующий union, не создавая циклических imports.
2. Выбрать один из простых вариантов: switch по command с assertNever или typed handler map с satisfies для полного набора ключей.
3. Разбить обработчики только по предметной ответственности: projects, tasks, checklist, comments, undo. Shared helpers должны принимать конкретные типы, а не прежний универсальный Record.
4. Убрать startsWith как способ маршрутизации команд; каждая checklist-команда получает собственный различимый payload.
5. Сохранить чистоту reducer и одинаковый путь server/optimistic preview. Рефакторинг не меняет ID generation, field diff, ownerFields и semantics conflict.
6. Удалять casts по мере восстановления связи типов. Не заменять их широкими overload/any или подавлением ошибки typecheck.

## Проверки

- [ ] Compile-time проверка: новая команда без обработчика вызывает ошибку.
- [ ] Существующие unit/API/property tests дают те же state/events/errors на фиксированных входах.
- [ ] Проверить редкие checklist reorder/remove, undo batch и comment operations, а не только task.create.

## Критерий готовности

Нет стирания проверенного union на входе dispatch; исчерпывающесть обеспечена компилятором; изменения поведения отсутствуют либо вынесены в отдельные исправления.

## Зависимости и границы

Жёстких зависимостей от других планов нет; работать от актуального snapshot исходников.

Не начинать универсальный command framework с динамической регистрацией. Для текущего набора достаточно типизированного switch/map. Разницу приоритетов двух ревьюеров сохраняем, одну задачу дважды не считаем.

Общие правила выполнения и соответствие исходным находкам: [индекс Astra](/Users/dmitriy/code/taskindex/docs/plans/2026-09-08-v2-review/ASTRA-INDEX.md).
