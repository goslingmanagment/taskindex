# Миграции `drizzle/v2`

- Версия схемы равна числу `*.sql` в этом каталоге (`schemaVersion()` в `src/server/db.ts`);
  константы нет, новая миграция меняет версию сама.
- Применённый SQL-файл редактировать нельзя. `__taskindex_migrations` хранит `sha256`
  содержимого (байты с `\r\n` → `\n`); при расхождении `taskindex-admin migrate` и запуск
  сервера отказывают до любой записи. Нужна правка — новая миграция.
- Схему меняют только через drizzle-kit: правка `src/server/schema.ts`, затем
  `npm run db:generate` (снапшот в `meta/`, запись в `_journal.json`). Если в одном диффе
  и `DROP`, и `CREATE`, kit спрашивает про переименование интерактивно; без TTY делайте два
  диффа через `drizzle-kit/api` (так собран `0001_agent_keys.sql`).
- Перенос данных дописывается руками между `CREATE` и `DROP` (пример: `0001_agent_keys.sql`);
  снапшот описывает результат, не порядок. `NOT NULL`-колонка без default в SQLite
  добавляется пересборкой таблицы (`__new_<table>` → копия → `DROP` → `RENAME`, пример:
  `0002_operation_seq.sql`), сгенерированный `ALTER TABLE … ADD … NOT NULL` не выполняется.
- Правило миграции данных (TI-014). Миграция, меняющая предметные таблицы или их значения,
  либо (а) выражена событиями системной операции `migration:<name>` (записи в `events` и
  `operations` с `actorId: 'system'`), либо (б) сопровождается правкой `applyEvent`/
  `validateExport`/`upgradeExport` в `src/server/admin.ts`, чтобы replay применял схемные
  значения по умолчанию для новых полей и экспорт прежнего формата импортировался.
  В обоих случаях фикстура экспорта предыдущей версии `tests/fixtures/export-schema-<N>.json`
  (сгенерирована на коде версии N скриптом `export-schema-<N>.seed.mts`) проходит
  `tests/api/migration-compat.test.ts`: `migrate` старой базы → `export` → `validateExport` →
  `import` → `GET /api/operations/{id}` → повтор конверта. Первые применения: `0001_agent_keys`
  (auth-таблицы не экспортируются, тривиально) и `0002_operation_seq` (вариант (б):
  backfill `(created_at, id)` в SQL и та же раскладка в `upgradeExport` для формата 1).
  Версионированные кодеки событий не вводятся до первой реальной нужды.
  2026-09-10: `0003_appearance` (TI-025, TI-026) — вариант (б). Таблица `appearance`
  создаётся пустой, `readState` отвечает значением по умолчанию (`defaultAppearance()`,
  `revision: 1`), так что запись появляется только после первой команды владельца;
  формат экспорта поднят до 3, а `upgradeExport` добавляет это же значение экспортам
  форматов 1 и 2. Фикстура остаётся `export-schema-2.json`: она проходит более длинную
  цепочку обновления, чем экспорт непосредственно предыдущей версии.
  2026-09-10: `0004_focus_desk` (TI-078, план 13) — вариант (б). Колонки `focus_key` и
  `focus_left_at` добавляются `ALTER TABLE … ADD` (nullable, пересборка не нужна), частичный
  уникальный индекс `tasks_focus_key … WHERE focus_key IS NOT NULL`. Задачи с `focus = 1`
  получают ключи прямо в SQL в порядке `(area, status, order_key, id)`: `'a0'` + три base-62
  цифры номера строки + `'V'` — допустимые ключи `fractional-indexing`, между ними можно
  вставлять новые. Формат экспорта поднят до 4; `upgradeExport` даёт форматам 1–3 те же ключи
  (`backfillFocusKey`) и `focusLeftAt: null`; `taskSchema` читает отсутствующие поля как `null`
  (`.default(null)`), потому что записи в сохранённых результатах старых операций их не несут;
  `validateExport` для задачи, которой журнал ни разу не назначал `focusKey`, принимает
  ключ из таблиц (только если задача в фокусе) — назначенный миграцией ключ событиями не
  выражен. Тест: `tests/api/migration-compat.test.ts`, describe `0004_focus_desk backfill`.
  2026-09-13: `0005_priority_labels_closes` (TI-086, спека `docs/specs/2026-09-12-owner-workflow.md` §4) — вариант (б).
  Колонки `tasks.priority TEXT NOT NULL DEFAULT 'p2'`, `tasks.labels TEXT NOT NULL DEFAULT '[]'`,
  `tasks.closes TEXT NULL`, `appearance.hide_p3 INTEGER NOT NULL DEFAULT false` добавляются
  `ALTER TABLE … ADD` с default, пересборка не нужна. Формат экспорта поднят до 5; `upgradeExport`
  читает формат 4 через `exportSchemaV4`, значения по умолчанию подставляют сами схемы записей
  (`taskSchema`, `appearanceSchema` с `.default()`); `applyEvent` при replay события создания без
  этих полей ставит те же значения, поэтому `validateExport` сходится и для журнала, записанного до
  миграции. Фикстура `tests/fixtures/export-schema-5.json` создана прежним кодом и включает
  изменения оформления, результаты задач и сохранённый отказ. Тест:
  `tests/api/migration-compat.test.ts`, describe `0005_priority_labels_closes backfill`.
  2026-09-17: `0006_drop_otvet_label` (решение владельца, спека §4 примечание) — вариант (б), файл
  создан `drizzle-kit generate --custom` (схема не меняется, снапшот повторяет 0005). `UPDATE`
  через `json_each`/`json_group_array(... ORDER BY key)` убирает `otvet` из `tasks.labels`,
  порядок остальных меток, `revision` и `updated_at` не меняются. Журнал и сохранённые
  результаты не переписываются: `applyEvent` при replay отбрасывает метки вне каталога
  (`isCatalogueLabel`), `taskSchema` читает записи через `storedLabelsSchema` (каталог плюс
  `RETIRED_LABELS`), формат экспорта поднят до 6, `upgradeExport` убирает снятую метку из
  задач форматов 1–5. Фикстура `tests/fixtures/export-schema-6.json` создана кодом dc37568.
  Тест: `tests/api/migration-compat.test.ts`, describe `0006_drop_otvet_label`.
  2026-09-17: `0007_labels` (решение владельца: метки как данные) — вариант (б). Таблица `labels`
  с частичным уникальным индексом по `name_key` среди действующих (`archived_at IS NULL`);
  пять прежних меток каталога вставляются в SQL теми же слагами, `revision 1`, штамп
  `2026-09-17T21:00:00.000Z`; строки задач не меняются. Журнал этих записей не содержит:
  `validateExport` начинает replay с `SEEDED_LABELS` (те же значения в `src/shared/labels.ts`),
  `upgradeExport` добавляет их экспортам форматов 1–6, формат экспорта поднят до 7. Фикстура
  `tests/fixtures/export-schema-7.json` создана кодом c3c4194. Тест: describe `0007_labels`.
- Журналы, созданные до появления контрольных сумм, получают `sha256` из файлов образа при
  первом `migrate` с записью `warn` `migration_checksum_backfilled` (допустимо только до
  рабочего переключения; после него backfill только по сверке с архивным SQL релиза).
