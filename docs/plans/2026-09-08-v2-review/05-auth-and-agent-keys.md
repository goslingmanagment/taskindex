# Ключи агентов без записи в базу и закрытые маршруты плагина

Статус: предложение, 2026-09-08. Источник: сводное ревью v2 (см. `README.md` в этой папке).
Приоритет: P0 (запись в базу на каждый GET агента обходит `writes: held` и нагружает Litestream; инвариант «ключи только через admin CLI» держится на одной строке). Оценка: M, 1.5..2 дня. Зависимости: `09-data-layer-and-dependencies.md` (правило для миграций с переносом данных и решение по Drizzle; этот план создаёт первую миграцию после baseline), `06-server-structure-config-logging.md` (версия схемы без ручной константы; если план 06 ещё не выполнен, здесь поднимается `SCHEMA_VERSION` до 2), `02-agent-permissions-and-sync-semantics.md` (политика undo и focus для агентов, B-01/B-02, сюда не входит).

## 1. Проблема

Все ссылки проверены по текущему дереву 2026-09-08; расхождений с отчётами не найдено, уточнены детали плагина.

### 1.1. Каждая проверка ключа агента делает две записи в базу (S1, V3)

- `src/server/auth.ts:51` `await auth.api.verifyApiKey({ body: { key: token } })` вызывается на каждый запрос с `Authorization: Bearer` или `x-api-key`, включая GET. Дальше `:54-58` ещё один `SELECT` из `apikey` по `id` и `:61-65` `SELECT` из `agents`.
- В `@better-auth/api-key@1.7.3` (`node_modules/@better-auth/api-key/dist/index.mjs`): `validateApiKey` (`:1622`) заканчивается вызовом `claimUsageInDatabase` (`:1717-1730`). Внутри: `consumeRateLimit` получает от `evaluateRateLimit` решение `{ type: 'skip', lastRequest: now }`, потому что ключи создаются с `rateLimitEnabled: false` (`src/server/admin.ts:166`), и делает `adapter.update({ lastRequest })`; затем безусловно `adapter.update({ updatedAt: new Date() })` (`:1721-1727`). Итого два `UPDATE apikey` на каждый запрос агента. При `synchronous=FULL` (`src/server/db.ts:23`) это два fsync-коммита и WAL-кадры, которые Litestream реплицирует в S3.
- Уточнение к ревью 1: чистка просроченных ключей `deleteAllExpiredApiKeys` (`:2059-2063`, не чаще раз в 10 с) в пути `verifyApiKey` выполняется только при `deferUpdates` (`:1985`); с настройками по умолчанию она срабатывает из маршрутов create/get/list/delete (`:801, :946, :1092, :1316`). На горячий путь она не влияет, две записи выше влияют.
- Записи обходят gate деплоя: middleware `src/server/app.ts:296-322` сначала авторизует (`:305-309`), и только для не-GET проверяет `opened()` (`:319-320`). `taskindex events --follow` опрашивает раз в секунду (`src/cli/run.ts:387-390`), то есть в «закрытую» на время миграции базу идёт одна запись в секунду.
- Таблица `apikey` (`src/server/schema.ts:201-228`): 27 колонок (`refillInterval`, `rateLimitTimeWindow`, `remaining`, `requestCount`, `permissions`, `metadata`, …), из своих читаются только `agentId` и `scope` (`auth.ts:59`, `:72`). Scope записывается трижды: `metadata.scope` (`admin.ts:164`), `permissions.workspace` (`:165`), колонка `scope` (`:171`).
- Хеш ключа в плагине: `defaultKeyHasher` (`index.mjs:2310-2313`) это SHA-256 → base64url без padding. В Node это `createHash('sha256').update(token).digest('base64url')`, поэтому существующие хеши переносимы без перевыпуска ключей.

### 1.2. HTTP-маршруты плагина открыты (V8)

- `app.ts:372-387` монтирует `options.auth.handler` на `/api/auth/*` для GET и POST; middleware `app.ts:300-304` пропускает `/api/auth/*` без нашей авторизации (проверяется только `writes: held` для мутаций). Плагин регистрирует `/api-key/create|delete|get|list|update` (`index.mjs:597, 887, 957, 1122, 1354`), то есть они доступны как `/api/auth/api-key/*`.
- `create` по HTTP требует сессию (`getSessionFromCtx`, `:732`), отвергает `userId` и `permissions` от клиента (`:734-735`), но принимает `name`, `metadata`, `prefix`, `expiresIn`. Созданный так ключ имеет `agent_id NULL`, и его спасает только проверка `!key?.agentId` в `auth.ts:59-60`. Хуже другое: `list`, `get`, `update`, `delete` работают для `referenceId = session.user.id = 'owner'`, а admin создаёт ключи агентов с `userId: 'owner'` (`admin.ts:162`), поэтому cookie-сессия владельца может через HTTP перечислить, отключить или удалить ключи агентов. Заявление плана §9 «ключи через `taskindex-admin`» (`docs/plans/2026-09-08-taskindex-v2.md:598`) держится на одной защитной строке и на том, что никто не вызывает эти маршруты.
- В Better Auth есть штатный способ: опция верхнего уровня `disabledPaths` возвращает 404 для перечисленных путей (`node_modules/better-auth/dist/api/index.mjs:164-166`). Она не используется.

### 1.3. Сессия владельца (S2)

`auth.ts:75` `auth.api.getSession({ headers })` без `session.cookieCache` делает два `SELECT` (session + user) на каждый запрос владельца. Опция есть: `options.session.cookieCache.enabled` (`node_modules/better-auth/dist/api/routes/session.mjs:39-48`, `maxAge` по умолчанию 300 с, `create-context.mjs:151-152`). Включение конфликтует с проверкой `tests/api/auth.test.ts:124-129`: после `resetOwnerPassword` (удаляет сессии, `admin.ts:97-100`) `/api/me` с прежней cookie должен сразу дать 401, а с кэшем в cookie он даст 200 до истечения `maxAge`. Пароль и passkey через Better Auth остаются: писать WebAuthn руками (300..500 строк на `@simplewebauthn/server`) не имеет смысла.

### 1.4. Имя владельца захардкожено в клиенте (V9)

- `src/web/app/store.ts:100-105` актор оптимистичного превью `{ id: 'owner', label: 'Дмитрий', kind: 'owner', scope: 'write' }` (строка `:102`).
- `src/web/lib/workspace.ts:29` `createdByLabel: 'Дмитрий'` в `makeTask`.
- `src/web/app/auth.tsx:118` `{session.data?.user.name || 'Дмитрий'}`.
- Сервер берёт метку из `s.user.name` (`auth.ts:77`), по умолчанию `'Владелец'` (`admin.ts:48`). Превью и подтверждённое состояние расходятся в `createdByLabel`; в e2e совпадают случайно, потому что владелец создаётся с `name: 'Дмитрий'` (`tests/e2e/server.ts:17`), в api-тестах метка `'Владелец'` (`tests/api/helpers.ts:17`). `GET /api/me` (`app.ts:427-434`) уже отдаёт актора, но клиент его не запрашивает (grep `api/me` по `src/web` пуст).

## 2. Цель и критерии приёмки

1. Запрос агента (GET и POST) не изменяет ни одну строку базы до `executeOperation`: в тесте `SELECT total_changes()` на соединении базы одинаков до и после пяти `GET /api/me` с ключом. То же при `writes: held`.
2. Таблица `apikey` и зависимость `@better-auth/api-key` удалены; ключи живут в `agent_keys` (7 колонок), scope хранится один раз.
3. Существующие ключи, выданные плагином, продолжают работать после миграции (тест на перенос хеша и на совместимость хеш-функции с контрольным вектором).
4. `POST /api/auth/api-key/create`, `GET /api/auth/api-key/list` и остальные `/api/auth/api-key/*` отвечают 404 `{ ok: false, code: 'not_found' }` для cookie владельца и для ключа агента (тест-инвариант «ключи только через admin CLI»).
5. Команды `taskindex-admin agent create | agent list | agent disable | agent-key create --agent --scope --out | agent-key list | agent-key revoke` сохраняют имена, флаги и форму вывода `agent-key create` (`{ id, agentId, scope, path }`, файл 0600 с `{ id, key, agentId, scope }`); `agent-key create` больше не требует `BASE_URL` и `BETTER_AUTH_SECRET`.
6. Проверка ключа: SHA-256 хеша из запроса → выборка по уникальному индексу → `timingSafeEqual` найденного хеша; отозванный ключ и отключённый агент дают 403 с прежними сообщениями.
7. Клиент берёт актора из `GET /api/me` при загрузке; строка `'Дмитрий'` в `src/web` отсутствует; превью команды владельца показывает ту же `createdByLabel`, что и подтверждённая запись.
8. `npm run check` зелёный (все существующие тесты плюс новые из раздела 5), `npm run e2e` зелёный, `bash deploy/local-drill.sh` проходит шаг `agent-key create` внутри контейнера.

## 3. Решение

Выбрано: собственная таблица `agent_keys`, проверка ключа без библиотеки, удаление плагина `@better-auth/api-key`, закрытие `/api/auth/api-key/*` в middleware как инвариант с тестом, актор клиента из `/api/me`. Better Auth остаётся для пароля, passkey, сессий и rate-limit входа.

| Вариант                                                                        | Плюсы                                                                                                                                                  | Минусы                                                                                                                                                              | Решение                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Своя таблица `agent_keys` + `hashAgentKey` + `timingSafeEqual`                 | Ноль записей на запрос; 7 колонок вместо 27; scope один раз; синхронная проверка без `await`; `agent-key create` без Better Auth; тестируется без сети | Своя миграция с переносом данных; ~120 строк кода; теряются функции плагина, которые и так выключены (rate-limit по ключу, refill, expiry)                          | Принято                                                                                                                                                                                                                                                   |
| Оставить плагин, кэшировать `verifyApiKey` в памяти на 30..60 с по хешу токена | Меньше правок; записи реже                                                                                                                             | Записи остаются (первый запрос в окне), обходят `held`; отзыв действует с задержкой TTL; 27 колонок и тройной scope остаются; кэш это ещё одно состояние в процессе | Отклонено; описано как запасной путь на случай, если владелец решит не трогать схему до переключения: `Map<hash, {actor, until}>`, TTL 30 с, сброс при `agent disable`/`agent-key revoke` невозможен из другого процесса, поэтому задержка отзыва до 30 с |
| Плагин с `storage: 'secondary-storage'` (in-memory)                            | Штатная опция                                                                                                                                          | Список ключей владельца в памяти теряется при рестарте, `fallbackToDatabase` снова пишет; не решает 27 колонок и маршруты                                           | Отклонено                                                                                                                                                                                                                                                 |
| `deferUpdates: true`                                                           | Одна строка                                                                                                                                            | Записи те же, только в фоне; при `held` фоновые записи в закрытую базу                                                                                              | Отклонено                                                                                                                                                                                                                                                 |

Закрытие маршрутов: после удаления плагина маршрутов нет, но инвариант закрепляется отдельно: middleware отвечает `not_found` на префикс `/api/auth/api-key/` до передачи в Better Auth. Это защита от возврата плагина или похожего в будущем (например, плагин organization). `disabledPaths` Better Auth не нужен, пока плагина нет; если плагин когда-нибудь вернётся для другой цели, добавить `disabledPaths` тоже.

Cookie-кэш сессии: не включать сейчас. Два `SELECT` на запрос одного владельца это микросекунды на SQLite, а немедленный отзыв сессии после смены пароля важнее и уже закреплён тестом. Решение владельца: включить позже с `maxAge: 60` и заменить проверку `auth.test.ts:124-129` на «401 после истечения `maxAge`».

## 4. Шаги

Каждый шаг заканчивается `npm run check`. Шаги 1..5 меняют схему и должны идти одним коммитом с миграцией.

1. `src/server/schema.ts`: добавить таблицу и удалить `apikey` (`:201-228`):

   ```ts
   export const agentKeys = sqliteTable(
     'agent_keys',
     {
       id: text('id').primaryKey(),
       agentId: text('agent_id')
         .notNull()
         .references(() => agents.id),
       scope: text('scope', { enum: ['read', 'tasks', 'write'] }).notNull(),
       keyHash: text('key_hash').notNull(),
       name: text('name'),
       createdAt: text('created_at').notNull(),
       revokedAt: text('revoked_at'),
     },
     (t) => [
       uniqueIndex('agent_keys_hash').on(t.keyHash),
       index('agent_keys_agent').on(t.agentId),
     ],
   );
   ```

   Время в ISO-тексте, как у домена (`agents.createdAt`, `schema.ts:97`), не в integer ms таблиц Better Auth (Ж12 остаётся только у таблиц самой библиотеки).

2. Миграция: `npm run db:generate` → `drizzle/v2/0001_agent_keys.sql` (kit сгенерирует `CREATE TABLE agent_keys`, два индекса и `DROP TABLE apikey`). Вручную вставить перенос данных между `CREATE TABLE` и `DROP TABLE` (если kit поставил `DROP` первым, перенести `DROP` в конец файла: снапшот описывает результат, не порядок):

   ```sql
   INSERT INTO `agent_keys` (`id`, `agent_id`, `scope`, `key_hash`, `name`, `created_at`, `revoked_at`)
   SELECT `id`, `agent_id`, `scope`, `key`, `name`,
          strftime('%Y-%m-%dT%H:%M:%fZ', `created_at` / 1000.0, 'unixepoch'),
          CASE WHEN `enabled` = 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END
   FROM `apikey`
   WHERE `agent_id` IS NOT NULL AND `scope` IN ('read', 'tasks', 'write');
   ```

   Ключи без `agent_id` (созданные мимо admin) не переносятся. Мигратор (`db.ts:83`) выполняет файл через `exec`, маркеры `--> statement-breakpoint` это комментарии. Версия схемы: если план 06 выполнен, версия выводится из списка миграций; иначе `SCHEMA_VERSION = 2` в `src/shared/model.ts:86`. Добавить в `drizzle/v2/README.md` (появляется в плане 09, иначе комментарием в начале SQL) правило: перенос данных дописывается руками, схема только через kit. Проверка: `tests/api/migrations.test.ts` (снапшот ↔ `schema.ts`, журнал ↔ `__taskindex_migrations`) зелёный; новый тест переноса (раздел 5, п. 3).

3. `src/server/agent-keys.ts` (новый модуль):

   ```ts
   export const hashAgentKey = (token: string) =>
     createHash('sha256').update(token).digest('base64url'); // совместимо с defaultKeyHasher плагина
   export function issueAgentKey(
     db,
     input: { agentId: string; scope: Scope; name?: string },
   ): { id: string; key: string; agentId: string; scope: Scope }; // key = 'ti_' + randomBytes(32).toString('base64url')
   export function verifyAgentKey(db, token: string): Actor; // fail('forbidden', ...) при отсутствии/отзыве/отключённом агенте
   export function listAgentKeys(
     db,
     agentId?: string,
   ): { id; agentId; scope; name; createdAt; revokedAt }[];
   export function revokeAgentKey(db, id: string): { ok: true };
   ```

   `verifyAgentKey`: `hash = hashAgentKey(token)`; `SELECT agent_keys.*, agents.label, agents.disabled_at FROM agent_keys JOIN agents ON ... WHERE key_hash = ?` (один запрос, индекс `agent_keys_hash`); если строки нет или `revoked_at` не null → `fail('forbidden', 'Ключ недействителен или отозван.')`; `timingSafeEqual(Buffer.from(row.keyHash), Buffer.from(hash))` как явная защита от изменения способа выборки в будущем (реальная защита это сам хеш); `disabled_at` не null → `fail('forbidden', 'Агент отключён.')`; результат `{ id: 'agent:' + agentId, agentId, label, kind: 'agent', scope }`. Префикс `ti_` только у новых ключей; проверка хеширует любой токен, старые токены без префикса продолжают работать.

4. `src/server/auth.ts`: убрать импорт и плагин `apiKey` (`:3`, `:25-32`); в `authorizeRequest` (`:47-74`) ветку bearer заменить на `return verifyAgentKey(db, token)` (синхронно, без `await`). Оставить `passkey`, `emailAndPassword`, `rateLimit`, `advanced.ipAddress`. Не добавлять `session.cookieCache` (раздел 3).

5. `src/server/admin.ts:143-206`: `createAgentKey(db, input)` без параметра `auth` → `issueAgentKey`; `listAgentKeys`, `revokeAgentKey` → делегирование в `agent-keys.ts` (или перенос функций целиком, `admin.ts` остаётся фасадом до разреза в плане 06). `importWorkspace` (`:385`, `:409`): `schema.apikey` → `schema.agentKeys`. Удалить реэкспорт `createAuth` (`:26`), если он больше никому не нужен. `src/cli/admin-run.ts:135-145`: `agent-key create` больше не создаёт `createAuth`, не требует `BASE_URL` и `BETTER_AUTH_SECRET`; вывод команды и файл ключа без изменений; `agent-key list` печатает `revokedAt` вместо `enabled`/`expiresAt` (зафиксировать в `deploy/README.md` и `12-…md`). Проверка: `tests/cli/admin.test.ts`, `tests/cli/agent-cycle.test.ts` (сигнатура `createAgentKey(db, {...})`), `deploy/local-drill.sh` (шаг `agent-key create` в контейнере).

6. `package.json`: удалить `@better-auth/api-key`; `npm install` обновляет lockfile (в worktree). `npm ls` без `invalid/extraneous`.

7. Закрыть маршруты: в middleware `app.ts:300-304` (после плана 06 в `http/auth-middleware.ts`) перед передачей в Better Auth:

   ```ts
   if (c.req.path.startsWith('/api/auth/api-key/'))
     fail(
       'not_found',
       'Ключи агентов выдаются только командой taskindex-admin.',
     );
   ```

   Ответ проходит через общий `onError` → `{ ok: false, code: 'not_found', retryable: false }` 404. Тест-инвариант в разделе 5, п. 4.

8. V9, клиент. `src/web/app/store.ts`: `StoreState.actor: Actor | null` (начально `null`); в `refresh()` (`:170-191`) грузить `Promise.all([transport<Snapshot>('/api/snapshot'), transport<Actor>('/api/me')])` и класть `actor` в state перед `loadSnapshot`; в `publish` (`:100-105`) использовать `this.state.actor ?? { id: 'owner', label: 'Владелец', kind: 'owner', scope: 'write' }` (запасное значение совпадает с серверным по умолчанию, `admin.ts:48`). `src/web/lib/workspace.ts:9-37` `makeTask(fields, actor?)`: `createdBy`/`createdByLabel` из переданного актора, по умолчанию `'owner'`/`'Владелец'`; вызовы `makeTask` в `src/web/app` передают актора из store. `src/web/app/auth.tsx:118`: запасное значение `'Владелец'` или метка актора из store. Проверка: grep `'Дмитрий'` по `src/web` пуст; `tests/web/store.test.ts` (раздел 5, п. 7).

9. Документация в объёме этого плана: `deploy/README.md` (шаг 3 первой установки: `agent-key create` не требует секретов; `agent-key list` поля), `README.md` раздел «Агенты» (без изменений команд, упомянуть префикс `ti_`), план §9 (`docs/plans/2026-09-08-taskindex-v2.md:598`): «ключи в собственной таблице `agent_keys`, хеш SHA-256, без записи при проверке». Остальная документация в `12-…md`.

## 5. Тесты

| #   | Файл                                                 | Сценарий                                                                                                                                                                                                                                                                                                                                                                           | Ожидание                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `tests/api/auth.test.ts:133-187` (обновить)          | ротация, scope, revoke, disable на `agent_keys`                                                                                                                                                                                                                                                                                                                                    | как сейчас; проверка хеширования: `SELECT key_hash FROM agent_keys WHERE id=?` не равен токену и равен `hashAgentKey(token)`                                                                                                                                 |
| 2   | `tests/api/auth.test.ts` (новый кейс)                | `n0 = SELECT total_changes()`; 5× `GET /api/me` с ключом; 3× `GET /api/tasks`; то же при `setup('held')`                                                                                                                                                                                                                                                                           | `total_changes()` не изменился; при `held` GET → 200, POST → 503                                                                                                                                                                                             |
| 3   | `tests/api/agent-keys-migration.test.ts` (новый)     | `:memory:`, выполнить только `drizzle/v2/0000_taskindex.sql` и записать его имя в `__taskindex_migrations`; вставить `agents` `a1` и две строки `apikey` (`enabled=1` с `key='ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAJa0'` (SHA-256 строки `abc` в base64url без padding), `agent_id='a1'`, `scope='tasks'`, `created_at=1788875004514`; вторая `enabled=0`); затем `migrate(db)` | `sqlite_master` без `apikey`; `agent_keys` две строки; `created_at` = `2026-09-08T…Z` в формате `stamp`; у второй `revoked_at` не null; `verifyAgentKey(db, 'abc')` → `{ id: 'agent:a1', scope: 'tasks' }`; `hashAgentKey('abc')` равен контрольному вектору |
| 4   | `tests/api/auth.test.ts` (новый кейс, инвариант)     | cookie владельца: `POST /api/auth/api-key/create` с `{name:'x'}`, `GET /api/auth/api-key/list`; ключ агента: те же запросы                                                                                                                                                                                                                                                         | все 404, тело `{ ok: false, code: 'not_found', retryable: false }`; в базе нет новых строк (`total_changes()` неизменен)                                                                                                                                     |
| 5   | `tests/cli/admin.test.ts` (обновить)                 | `agent-key create --agent a --scope tasks --out <tmp>` с env только `DATABASE_PATH`                                                                                                                                                                                                                                                                                                | код 0, stdout `{id, agentId, scope, path}`, файл 0600 с `{id, key, agentId, scope}`, `key` начинается с `ti_`; повтор в тот же файл → ошибка и ключ отозван (`revokedAt` не null); `agent-key list` содержит `revokedAt`                                     |
| 6   | `tests/cli/agent-cycle.test.ts` (обновить сигнатуру) | два агента, потеря ответа после коммита                                                                                                                                                                                                                                                                                                                                            | без изменений по смыслу, зелёный                                                                                                                                                                                                                             |
| 7   | `tests/web/store.test.ts` (новый кейс)               | transport отвечает на `/api/me` `{ id:'owner', label:'Владелец', kind:'owner', scope:'write' }`; `submit(task.create)` до ответа сервера                                                                                                                                                                                                                                           | в `data` превью `createdByLabel === 'Владелец'`; после `acknowledge` метка совпадает                                                                                                                                                                         |
| 8   | `tests/e2e/workspace.spec.ts` (существующие)         | вход, создание задачи, имя в меню аккаунта                                                                                                                                                                                                                                                                                                                                         | зелёные; имя берётся из сессии (`'Дмитрий'` из фикстуры `tests/e2e/server.ts:17`)                                                                                                                                                                            |
| 9   | `bash deploy/local-drill.sh` (вручную)               | полный drill                                                                                                                                                                                                                                                                                                                                                                       | шаг `agent-key create` и команда CLI внутри контейнера проходят; `/health` без изменений                                                                                                                                                                     |

## 6. Риски и откат

- Перенос хешей: если у плагина в какой-то версии хеш кодировался иначе, старые ключи перестанут работать. Защита: тест 3 с контрольным вектором против `index.mjs:2310-2313` текущей версии; рабочих ключей ещё нет (переключение впереди), поэтому крайний случай это перевыпуск ключей командой `agent-key create`. Решение владельца: переносить (рекомендуется, SQL из шага 2) или перевыпустить и не писать перенос.
- Миграция с `DROP TABLE apikey` необратима. Откат образа по процедуре `deploy/README.md` возвращает пару «образ + копия базы», как для любой миграции; drill это репетирует.
- Удаление плагина меняет `auth.api` типы: `createAgentKey` без `auth` ломает вызовы в тестах (`tests/api/auth.test.ts:136`, `tests/cli/agent-cycle.test.ts:44`) до их обновления; `tsc` укажет все места.
- `timingSafeEqual` бросает при разной длине буферов: хеши одной длины (43 символа), но добавить проверку длины перед вызовом.
- Закрытие `/api/auth/api-key/*` в middleware не влияет на `/api/auth/passkey/*` и `/api/auth/sign-in/*` (проверяется `auth.test.ts:58-132`).
- Откат в целом: revert коммита с миграцией возможен только до применения к базе; после применения базу возвращают из копии. Поэтому шаги 1..6 идут одним коммитом и проверяются drill до деплоя.

## 7. Вне объёма

- Агент отменяет решения владельца через `undo` (B-01), агент ставит `focus` (B-02), агент отменяет операции другого агента (A12): `02-agent-permissions-and-sync-semantics.md`.
- Разрез `admin.ts` на `owner/agents/backup/deployment` и `auth-middleware.ts`: `06-server-structure-config-logging.md`; здесь модуль `agent-keys.ts` создаётся так, чтобы лечь в этот разрез без переименований.
- Выбор «Drizzle только как источник схемы» или уход на kysely/better-sqlite3, формат времени таблиц Better Auth (Ж12): `09-data-layer-and-dependencies.md`.
- Security-заголовки, HSTS, allowlist `/health` в nginx (B-10, Ж10): `11-deploy-and-ops.md`.
- Разделение outbox по агенту и `operation resume` чужих конвертов (A1): `03-cli-outbox-and-ergonomics.md`.
- `taskindex me`, `agents`/`me` в `context` (A4, A14): `03-cli-outbox-and-ergonomics.md`, `12-ai-readiness-and-docs.md`.

## Покрытые находки

| ID                                                                                                         | Отчёт           | Кратко                                                                        | Где в плане                                           |
| ---------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| S1                                                                                                         | 1 (стек)        | Две записи в базу на каждую проверку ключа; 27 колонок; scope трижды          | §1.1, шаги 1..6                                       |
| V3                                                                                                         | 2 (архитектура) | Записи плагина на каждый GET агента обходят `writes: held`                    | §1.1, шаги 3..4, тест 2                               |
| V8                                                                                                         | 2               | Открытые `/api/auth/api-key/*`, три места хранения scope                      | §1.2, шаги 1, 7, тест 4                               |
| S2                                                                                                         | 1               | `cookieCache` для сессии владельца; Better Auth для пароля и passkey оставить | §1.3, §3 (решение владельца: не включать)             |
| V9                                                                                                         | 2               | Захардкоженное имя владельца в клиенте                                        | §1.4, шаг 8, тест 7                                   |
| Ж12 (частично)                                                                                             | 2               | Два формата времени в базе                                                    | шаг 1: новая таблица в ISO-тексте; остаток в `09-…md` |
| B-01, B-02, A12                                                                                            | 3, 5            | Права агентов на undo/focus                                                   | не здесь: `02-…md`                                    |
| Astra B-01                                                                                                 | astra / TI-001  | отозванный ключ или отключённый агент продолжают получать SSE                 | шаги 10-12; форма подписчика в плане 06               |
| Astra `docs/audits/2026-09-08-multiside-review/01-stack.md` («Оставить» api-key), `ASTRA-VS-FABLE.md` §4.2 | astra / TI-036  | плагин оставить; чек-лист требований к любой замене                           | §3 (замена подтверждена замером), шаги 1-7, 10        |

## Сверка с ревью Astra (2026-09-08)

Кратко: Astra добавила B-01 (P1, `astra-01-sse-access-revocation.md`, реестр TI-001 P1): авторизация выполняется один раз в middleware (`src/server/app.ts:305-309`), замыкание `send` (`:810-823`) проверяет только локальный `closed`, heartbeat (`:839-845`) держит соединение под nginx `proxy_read_timeout 1h` (`deploy/nginx/taskindex.conf:35`) неограниченно, `revokeAgentKey` (`src/server/admin.ts:191-206`) лишь ставит `enabled=false`, тест `tests/api/auth.test.ts:182-186` проверяет отзыв только для нового запроса. Повтор probe при сверке: `{"freshRequestStatus":403,"mutationStatus":200,"receivedPostRevocationTitle":true}`. Тяжесть по сверке: реальный пробел контроля доступа, для этого продукта средняя (поставляемый CLI не открывает SSE: `taskindex events --follow` опрашивает `/api/events` раз в секунду, `src/cli/run.ts:387-390`, и после отзыва получает 403 на следующем опросе; окно ограничено жизнью процесса; эффект только чтение), но P0 до того, как ключи начнут раздаваться за пределы машины владельца. Проектировать вместе с V3: кэш результата `verifyApiKey` расширил бы то же окно; выбранная здесь замена (`agent_keys` плюс перепроверка в хабе SSE) закрывает оба пункта. Astra не нашла S1/V3 (TI-036) и V8 (TI-055) и рекомендовала оставить плагин.

### Добавлено по итогам сверки

| Пункт                                                                                                                                              | Источник Astra           | Реестр         | План Astra                          | Что делаем здесь / где делается                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Перепроверка доступа перед каждой отправкой и на heartbeat; закрытие потока при отзыве и отключении; явное максимальное окно                       | B-01                     | TI-001         | `astra-01`, шаги 2-5                | шаг 10 ниже; форма подписчика в плане 06 (дополнительный шаг 13)                                                 |
| Разделить публичный `Actor` и приватную идентичность credential (вид, id ключа или сессии)                                                         | B-01                     | TI-001         | `astra-01`, шаг 1                   | шаг 10: `verifyAgentKey` возвращает `credential`                                                                 |
| Перепроверка без записей в базу и без побочных счётчиков                                                                                           | B-01                     | TI-001         | `astra-01`, «Зависимости и границы» | шаг 12 расширяет тест `total_changes()`                                                                          |
| Кэш результата проверки отвергнут, второе основание: расширяет окно отзыва                                                                         | B-01 и FA:V3             | TI-001, TI-036 | `astra-01`                          | таблица §3 дополнена в разделе расхождений ниже                                                                  |
| Чек-лист требований к замене плагина: хеширование, выдача, ротация, связь агент/scope, отключение, отзыв, миграция ключей, долгоживущие соединения | `ASTRA-VS-FABLE.md` §4.2 | TI-036         | нет                                 | шаги 1-7 закрывают всё, кроме долгоживущих соединений; их закрывает шаг 10                                       |
| Завершение потока владельца при сбросе сессий                                                                                                      | B-01                     | TI-001         | `astra-01`, проверка 3              | шаг 10: `check` владельца через `getSession`; `resetOwnerPassword` удаляет сессии (`src/server/admin.ts:97-100`) |

### Расхождения и решение

- Тяжесть. Astra P1, реестр TI-001 P1; сверка: средняя для продукта по причинам из вводки. Решение: остаётся в P0-части этого плана, потому что правится тот же код, что и `agent_keys`, а после переключения ключи выйдут за пределы машины владельца.
- Плагин оставить или заменить. Astra в таблице стека рекомендует оставить `@better-auth/api-key`, не проверив стоимость проверки; `ASTRA-VS-FABLE.md` §4.2 не принимает автоматически «свою таблицу за 30-50 строк» и перечисляет требования. Решение: замена остаётся; замер координатора подтвердил цену (2 `UPDATE apikey` и 8 272 байта WAL на один GET при `writes: held`). Требования §4.2 закрыты шагами: хеширование (шаг 3, SHA-256 base64url совместим с плагином), выдача (`issueAgentKey`), ротация (`agent-key create` без изменений, шаг 5), связь агент/scope (`agent_keys.agent_id`, `scope`), отключение (`agents.disabled_at` в `verifyAgentKey`), отзыв (`revoked_at`), миграция выданных ключей (шаг 2, тест 3), долгоживущие соединения (шаг 10). TI-036 просит сначала определить требование к немедленности отзыва: оно записано шагом 11.
- Кэш 30-60 с (FA:V3). Отвергнут обеими сторонами: меняет гарантию отзыва и расширяет окно B-01. Запись в таблицу §3: второе основание отказа.
- «Уже отправленные байты отозвать невозможно» (`astra-01`, шаг 3): согласны; гарантия формулируется как «после ближайшей проверки новые данные не уходят» (шаг 11).
- Бесконечный reconnect после окончательного 401/403 (`astra-01`, шаг 6): закрывается планом 07 (шаг 7, V5): при `CLOSED` сначала `request('/api/me')`, при 401/403 переподключение прекращается.

### Дополнительные шаги

10. Перепроверка доступа в SSE (Astra B-01). Предпосылка: `createEventHub` из плана 06 (шаг 9) с подписчиком `{ onEvents, onOperations, actor, credential, check, close }` (план 06, дополнительный шаг 13); если план 06 не смержен, реализовать внутри `src/server/app.ts:752-866`. (а) `verifyAgentKey` (шаг 3) возвращает `{ actor, credential: { kind: 'agent-key', keyId, agentId } }`, путь владельца `{ kind: 'session', sessionId }`; `Env.Variables.credential`. (б) `check()` для агента: один индексный запрос `SELECT ak.revoked_at, a.disabled_at FROM agent_keys ak JOIN agents a ON a.id = ak.agent_id WHERE ak.id = ?`, истина только при обоих `NULL`; для владельца: `auth.api.getSession({ headers })` не null и `user.id === 'owner'`. Записей в базу нет. (в) Хаб вызывает `check()` перед каждой доставкой `onEvents`/`onOperations`, поток вызывает его на каждом тике heartbeat (`SSE_HEARTBEAT_MS`, сегодня 25 000 на `app.ts:845`); при провале в поток уходит `event: revoked\ndata: {}\n\n`, соединение закрывается, подписчик удаляется. (г) `revokeAgentKey`/`disableAgent` в том же процессе дополнительно вызывают `hub.closeFor((s) => s.credential.agentId === agentId)`; admin CLI работает в другом процессе, поэтому границей остаётся (в). (д) `AppOptions.sseHeartbeatMs` для тестов. Тесты `tests/api/auth.test.ts`: открыть поток ключом, вызвать `revokeAgentKey(f.db, id)` напрямую (имитация другого процесса), владелец создаёт задачу → поток не получает данных и закрывается в пределах одного heartbeat (`sseHeartbeatMs: 50`), тело заканчивается `event: revoked`; то же для `disableAgent`; поток владельца после `resetOwnerPassword` закрывается; разрешённый поток продолжает получать события. Приёмка: probe Astra `revoked-key-keeps-live-sse-access` даёт `receivedPostRevocationTitle: false`.
11. Формулировка гарантии. Критерий 9 в §2: «Отзыв ключа и отключение агента действуют на новые запросы немедленно, на открытый SSE не позже `SSE_HEARTBEAT_MS` (25 с) или ближайшей отправки данных; кэшей результата проверки нет». Записать в `deploy/README.md` (раздел про `agent-key revoke`) и в SKILL.md (план 12, дополнительный шаг 13): поток завершается событием `revoked`, клиент не переподключается в цикле, а запрашивает новый ключ у владельца.
12. Тест 2 (§5) расширить: `total_changes()` не меняется также после открытия `/api/events/stream` ключом агента и трёх тиков heartbeat (`sseHeartbeatMs: 20`), а также после одного провала `check()` с закрытием потока.

## Решение владельца (2026-09-10, делегировано Fable)

- Плагин `@better-auth/api-key` заменяется собственной таблицей `agent_keys` по шагам 1–7 с требованиями из сверки (хеширование, выдача, ротация без потери идентичности агента, отзыв и отключение на новых запросах и на открытом SSE, миграция выданных ключей, связь агент/scope). Кэш результата проверки не вводится.
- Отзыв ключа закрывает открытый SSE тем же изменением (шаги 10–12), гарантия не позже `SSE_HEARTBEAT_MS`.
- Better Auth для входа владельца (пароль, passkey) остаётся.
- Приоритет в реестре: TI-036 поднимается до P1, TI-001 остаётся P1, оба до рабочего переключения.
