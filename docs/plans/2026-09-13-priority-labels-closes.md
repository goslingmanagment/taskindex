# План реализации TI-086: приоритет, метки, `closes` и галочка «Без P3»

**Цель:** задача получает явный приоритет P1–P3, метки из фиксированного каталога и слаг проблемы `closes`; доска показывает их значком и чипами, прячет P3 галочкой, хранимой на сервере; CLI и API фильтруют по ним.

**Архитектура:** три поля добавляются в общий домен (`src/shared`), откуда их без ручного дублирования подхватывают схемы команд, CLI-флаги, OpenAPI и веб. Хранение — три колонки `tasks` и одна колонка `appearance` через миграцию `0005`; журнал событий и экспорт остаются совместимыми по правилу данных «вариант (б)» из `drizzle/v2/README.md`: replay подставляет значения по умолчанию, экспорт получает формат 5. Приоритет **не сортирует** карточки: порядок в колонке остаётся ручным (`orderKey`), приоритет только помечает и фильтрует.

**Стек:** TypeScript, Zod 4, Hono (`@hono/zod-openapi`), Drizzle + better-sqlite3, React 19, Vitest, Playwright. Node 26.7.0.

**Спека:** `docs/specs/2026-09-12-owner-workflow.md`, разделы 2, 3, 4 (4.1–4.6), 11. Этот план реализует волну 1 из §10.

**База:** `main` `0901fd2` (2026-09-13). Номер TI-085 в реестре занят ускорением доски (`0901fd2`), поэтому эта работа идёт как TI-086. Ревью Codex 2026-09-13 учтено: задача 0 про открытые вкладки, задача 4 переписана под `card-menu.tsx`, `useMemo`/`useDeferredValue` в `shell.tsx`, пустой экран при скрытых P3, перенос чипов; порядок меток канонизирует сервер.

**Примечание реализации 2026-09-13:** отдельный worktree находится в `~/code/taskindex/work/ti-086` (ветка `ti-086`, база `0901fd2`); каталог `work/` исключён из основного чекаута. Базовый `npm run check` прошёл: 402/402, полный лог `work/baseline-check.log`. Проверки с локальными портами требуют запуска вне сетевого ограничения песочницы.

**Уточнения по коду 2026-09-13:** `ContractMismatch.retryable = true` сохраняет `submission` редактора и исходный `operationId`; остановку повторов до перезагрузки обеспечивает `store.incompatible` с проверкой перед каждым POST (в том числе retry/recover/backoff). «Показать все задачи» снимает `today` и активный `hideP3`, даже если счётчик скрытых P3 равен нулю. `canonicalLabels` сортирует копию массива, не удаляя ошибочные значения до валидации. `selectVisibleTasks(data, selection, today)` получает `hideP3` внутри `selection`; типы каталога импортируются прямо из `labels.ts`, без неиспользуемого реэкспорта. Проверка размера результата операции сравнивает содержимое без событий и долю от полного ответа: абсолютный старый порог 4000 байт устарел с расширением задачи. Копия `data/dev.db` оказалась пустой, версия 1; прошла всю цепочку до версии 6. Заполненный переход 5→6 отдельно проверен настоящим экспортом из `0901fd2`.

## Global Constraints

**Результат реализации 2026-09-13:** задачи 0–5 выполнены в ветке `ti-086`. `node scripts/gate.mjs` зелёный: `check` — 65 файлов, 431 тест; сборка; e2e — 53 passed, 3 skipped (существующие opt-in замеры TI-085). Все 6 сценариев `priority.spec.ts` прошли. Дополнительно: собранный CLI в одноразовом sandbox, миграция копии базы, валидатор скилла, визуальная проверка 390 px board / 1440 px list. Полный вывод: `work/gate.log`; машинный отчёт: `test-results/gate.json` (`dirty: true`, коммита реализации пока нет). Логи отдельных проверок: `work/cli-smoke.log`, `work/migration-copy.log`, `work/ti-086-tooltip-red.log`, `work/ti-086-priority-e2e.log`. В ходе интеграции исправлены доступные имена меток и подсказка слага под кнопкой открытия; тест B06 теперь проверяет сохранение глубины страниц при любом числе операций и появление новой операции, а не предполагает, что во всей базе меньше 100 записей. Основной чекаут чист, прежние миграции и визуальный эталон не изменены. Коммит, push, деплой, установка скилла и переезд `/OS` не выполнялись.

Скопировано из спеки и `CLAUDE.md`; действует для каждой задачи.

- Работать только в отдельном git worktree на своей ветке; основной чекаут `~/code/taskindex` не трогать. Коммит и push только по слову владельца; один коммит на карточку, первая строка `TI-086: …`.
- Не редактировать применённые миграции `drizzle/v2/0000…0004*.sql`; `drizzle/v2/meta/*` только через `npm run db:generate`.
- Не трогать `data/`, `.env`, `deploy/.runtime/`, `docs/reference/**`, `docs/audits/**`. Эталон скриншотов `docs/reference/v2-validation` **не переснимать**: новая галочка меняет кадр доски, решение о переснятии принимает владелец отдельно.
- Идентификаторы, комментарии и названия тестов на английском; UI, ошибки, `.describe()` и документация на русском.
- Ошибки только через `fail()`/`DomainError`. Все записи домена только через `executeOperation`.
- Тесты не мокают модули: реальные SQLite `:memory:`, `app.request`, DI через `AppOptions`.
- Стили: цветовые литералы только в `src/web/tokens.css`; скин пишет только `var(--…)`, без `!important` (`scripts/check-skin.mjs` входит в `npm run check`).
- Каждая задача заканчивается `npm run check` (tsc, oxlint, oxfmt, unused-exports, shellcheck, build, check:skin, vitest). Вывод ошибок и тестов приводить целиком. `npm run format` чинит форматирование.
- Значения из спеки, менять нельзя: приоритеты `p1|p2|p3`, по умолчанию `p2`; метки до 8, без повторов, только из каталога; `closes` по `^[a-z0-9-]{1,80}$` или `null`; формат экспорта 5; колонка галочки `hideP3` в предпочтении владельца; галочка прячет P3 только на доске и в списке текущей области, не в поиске, Focus, архиве, `digest` и CLI; приоритет не участвует в сортировке.
- Каталог меток (id → имя → цвет → описание): `otvet` → «ответ» → `#bd811d` → «Нужен ответ или решение владельца кому-то: человеку, подрядчику, кандидату»; `dengi` → «деньги» → `#298467` → «Платёж, долг, приз, финансовое решение; при оплате строка в ledger»; `5-min` → «5 мин» → `#8290a4` → «Делается за несколько минут, годится в просвет»; `lora` → «Lora» → `#9661bf` → «Касается модели Lora»; `lily` → «Lily» → `#397faf` → «Касается модели Lily»; `ari` → «Ari» → `#a97928` → «Касается модели Ari».

## Карта файлов

| Файл | Ответственность в этой работе |
|---|---|
| `src/shared/labels.ts` (новый) | Каталоги `PRIORITIES` и `LABELS`, типы `Priority`, `LabelId`, `DEFAULT_PRIORITY` |
| `src/shared/limits.ts` | `taskLabels: 8`, `closes: 80` |
| `src/shared/schemas.ts` | `prioritySchema`, `labelSchema`, `labelsSchema`, `closesSchema`; поля в `taskFieldsSchema`; `hideP3` в `appearance.update` |
| `src/shared/domain-schemas.ts` | Поля записи задачи с `.default()`, `hideP3` записи оформления, экспорт формата 5 и схема формата 4, каталоги в `contextSchema`, счётчики `digestSchema` |
| `src/shared/model.ts` | `FORMAT_VERSION = 5` (типы каталога импортируются прямо из `labels.ts`) |
| `src/shared/entities.ts` | Предметные поля `priority`, `labels`, `closes`, `hideP3` |
| `src/shared/commands.ts` | Значения при создании, `priority` в `ownerLockedFields`, `hideP3` в `applyAppearanceUpdate`, инвариант меток, значения по умолчанию в `applyEvent` |
| `src/shared/queries.ts` | Фильтры `priority`, `label`, `closes` |
| `src/server/schema.ts` | Колонки Drizzle |
| `drizzle/v2/0005_priority_labels_closes.sql`, `drizzle/v2/meta/*` (генерируются) | Миграция |
| `src/server/backup.ts` | `upgradeExport` для формата 4 |
| `src/server/context.ts` | Каталоги и два правила в `/api/context` |
| `src/server/digest.ts` | `counts.p1`, `counts.otvet` |
| `src/server/routes/reads.ts` | Параметры `priority`, `label`, `closes` у `/api/tasks` |
| `src/cli/spec.ts`, `src/cli/help.ts`, `src/cli/writes.ts` | Вид флага `list` (`--labels otvet,dengi`), флаги чтения |
| `src/web/app/api.ts`, `src/web/app/store.ts` | Ответ 2xx вне контракта не отказ: конверт остаётся в очереди, записи останавливаются до перезагрузки (задача 0) |
| `src/web/app/commands.ts` | Поля в `editableFields` |
| `src/web/app/history.ts` | Подписи истории |
| `src/web/app/card.tsx` | Значок приоритета, чипы меток и `closes` |
| `src/web/app/card-menu.tsx` | Пункты приоритета в общем меню карточки |
| `src/web/app/workspace-empty.tsx` | Вариант пустого экрана «задачи скрыты фильтром» |
| `src/web/app/editor/editor.tsx` | Выбор приоритета, разделы «Метки» и «Закрывает проблему» |
| `src/web/app/selectors.ts`, `src/web/app/shell.tsx`, `src/web/app/workspace-header.tsx`, `src/web/app/appearance.ts` | Галочка «Без P3», подпись «скрыто N» |
| `src/web/skin/board.css`, `src/web/skin/editor.css` | Стили значка, чипов, выбора меток |
| `tests/web/fixtures.ts` | Поля в `makeTask` |
| `tests/api/priority-labels.test.ts` (новый), `tests/api/permissions.test.ts`, `tests/api/appearance.test.ts`, `tests/api/migration-compat.test.ts` | Тесты API |
| `tests/property/undo.test.ts`, `tests/unit/shared.test.ts`, `tests/unit/limits.test.ts` | Оракул undo, каталоги, лимиты |
| `tests/cli/help.test.ts`, `tests/cli/cli.test.ts` | Флаги CLI |
| `tests/web/history.test.ts`, `tests/web/commands.test.ts`, `tests/web/selectors.test.ts` | Веб-логика |
| `tests/e2e/priority.spec.ts` (новый) | Сцена в браузере |
| `skills/taskindex/SKILL.md`, `docs/plans/2026-09-08-taskindex-v2.md`, `drizzle/v2/README.md`, `issues.md`, `BACKLOG.md`, `CLAUDE.md` | Документация и реестр |

Не меняются: `src/server/db.ts` (кодек строки задачи это spread, новые колонки проходят сами), `src/web/app/board.tsx`, `src/web/app/dialogs.tsx` (быстрое создание остаётся «только название»), `src/web/app/desk/*` (стол Focus без изменений по спеке §4.5), `tests/property/commands.test.ts`, `tests/property/write-state.test.ts`.

## Перед началом

1. Прочитать этот план целиком и спеку §4. Противоречия и всё, что ревьюер назвал бы дефектом, поднять сразу списком, не по ходу.
2. Создать worktree от `main`:
   ```sh
   cd ~/code/taskindex && git worktree add ../.worktrees/taskindex-ti-086 -b ti-086 && cd ../.worktrees/taskindex-ti-086
   ln -s ../../taskindex/node_modules node_modules   # node_modules не копируется; симлинк виден в git status как untracked, в коммит не добавлять
   node --version   # v26.7.0
   npm run check    # зелёный до правок
   ```
   Спека и этот план лежат в worktree `~/code/.worktrees/taskindex-spec-owner-workflow` (ветка `spec-owner-workflow`, не закоммичены): скопировать `docs/specs/2026-09-12-owner-workflow.md` и `docs/plans/2026-09-13-priority-labels-closes.md` в новый worktree теми же путями, чтобы ссылки из карточки реестра работали.
3. Завести карточку TI-086 в `issues.md` со статусом «В РАБОТЕ» (текст в задаче 5, шаг 3); до конца работы статус не менять.

---

### Task 0: Совместимость открытых вкладок со следующим сервером

**Files:**
- Modify: `src/web/app/api.ts:3-12` (класс `ApiError`), `:79-90` (разбор ответа по схеме)
- Modify: `src/web/app/store.ts:483-500` (`send`, ветка `catch`)
- Modify: `tests/web/api.test.ts` (новый `it`), `tests/web/store.test.ts` (новый `it` в describe `ordered operation store`)

**Interfaces:**
- Consumes: ничего из других задач; делается первой, независимо от полей.
- Produces: `export class ContractMismatch extends ApiError` в `src/web/app/api.ts`; поведение store: на `ContractMismatch` конверт остаётся в `pending` со статусом `unknown` и сообщением `SERVER_UPDATED_MESSAGE`, `incompatible` становится `true`, новые записи отклоняются до перезагрузки, после перезагрузки `recover()` сверяет конверт через `GET /api/operations/{id}`.

Почему: сегодня ответ 2xx, который строгая схема бандла не принимает, считается окончательным отказом (`api.ts`, `retryable: false`), и `store.send` удаляет конверт через `finish`, хотя сервер запись сохранил. После выпуска с новыми полями любая открытая старая вкладка теряла бы подтверждение своей записи. Ревью Codex 2026-09-13 воспроизвело: HTTP 200, запись в базе, `pending = 0`, `incompatible = false`. Проверка версии схемы срабатывает только при загрузке снимка.

- [x] Шаг 1. `src/web/app/api.ts`: после класса `ApiError` добавить

```ts
// A 2xx body the shared schema refuses: the server answers from another
// contract than this bundle (a deploy under an open tab). The request may well
// have landed, so this is never a final rejection of the operation (TI-086).
export class ContractMismatch extends ApiError {}
```

и заменить блок `if (!parsed.success) throw new ApiError({ … 'Ответ сервера не соответствует контракту.' … })` на

```ts
  if (!parsed.success)
    throw new ContractMismatch(
      {
        ok: false,
        code: 'unavailable',
        retryable: true,
        message: 'Ответ сервера не соответствует контракту.',
      },
      response.status,
    );
```

- [x] Шаг 2. `src/web/app/store.ts`: в импорт из `./api` добавить `ContractMismatch`. В `send`, в блоке `catch (error)` перед строкой `if (error instanceof MismatchedResponse) throw error;` добавить

```ts
          // Another contract on the wire: the write may have landed, so the
          // envelope stays pending and writes stop until the page is
          // reloaded; recover() then settles it through
          // GET /api/operations/{id} (TI-086).
          if (error instanceof ContractMismatch) {
            this.status(id, 'unknown', SERVER_UPDATED_MESSAGE);
            this.publish({ incompatible: true });
            throw error;
          }
```

- [x] Шаг 3. Тесты. `tests/web/api.test.ts` (в импорт из `../../src/web/app/api` добавить `ContractMismatch`):

```ts
it('TI-086: a 2xx body outside the contract is a ContractMismatch, not a final rejection', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ ok: true, unexpected: 1 })),
  );
  const result = request(
    '/api/commands',
    z.strictObject({ ok: z.literal(true) }),
    { method: 'POST', body: '{}' },
  );
  await expect(result).rejects.toBeInstanceOf(ContractMismatch);
  await expect(result).rejects.toMatchObject({
    status: 200,
    detail: { code: 'unavailable', retryable: true },
  });
});
```

`tests/web/store.test.ts` (в импорт из `../../src/web/app/api` добавить `ContractMismatch`, из `../../src/web/app/store` добавить `SERVER_UPDATED_MESSAGE`), в describe `ordered operation store`:

```ts
  it('TI-086 keeps the envelope pending and stops writes when the server answers from another contract', async () => {
    const storage = new MemoryStorage();
    const store = new WorkspaceStore(async <T>(): Promise<T> => {
      throw new ContractMismatch(
        {
          ok: false,
          code: 'unavailable',
          retryable: true,
          message: 'Ответ сервера не соответствует контракту.',
        },
        200,
      );
    }, storage);
    store.loadSnapshot(snapshot());
    const attempt = store.submit(
      taskSaveCommand({ ...task(), title: 'Новое' }, task()),
      'op-contract',
    );
    await expect(attempt).rejects.toBeInstanceOf(ContractMismatch);
    expect(store.getSnapshot().incompatible).toBe(true);
    expect(store.getSnapshot().pending).toMatchObject([
      { status: 'unknown', message: SERVER_UPDATED_MESSAGE },
    ]);
    expect(storage.getItem('taskindex/ops/op-contract')).not.toBeNull();
    await expect(
      store.submit(
        taskSaveCommand({ ...task(), note: 'Ещё' }, task()),
        'op-next',
      ),
    ).rejects.toThrow(SERVER_UPDATED_MESSAGE);
  });
```

- [x] Verify: `npx vitest run tests/web/api.test.ts tests/web/store.test.ts` зелёные; до правок `api.ts` и `store.ts` оба новых теста красные (первый ждёт `ContractMismatch`, второй видит `pending` пустым и `incompatible: false`).

Граница задачи: она защищает вкладки **этой** сборки от следующих релизов. Вкладки, открытые на нынешнем проде (сборка без этой правки), при первой записи после релиза TI-086 всё ещё получат отказ и потеряют конверт из очереди, а сервер запись сохранит. Поэтому в день выпуска владелец перезагружает открытые вкладки до первой записи; это записано в карточке (Task 5) и в сообщении о готовности.

- [x] Commit: не делать.

---

### Task 1: Домен (`src/shared`): каталоги, схемы, команды, фильтры

**Files:**
- Create: `src/shared/labels.ts`
- Modify: `src/shared/limits.ts:4-31`
- Modify: `src/shared/schemas.ts:1-3` (импорты), `:38-62` (схемы), `:120-140` (`taskFieldsSchema`), `:258-268` (`appearance.update`)
- Modify: `src/shared/domain-schemas.ts:1-24` (импорты), `:52-60` (`taskSchema` после `status`), `:127-160` (`appearanceSchema`, `defaultAppearance`), `:420-470` (экспорт), `:528-560` (`contextSchema`), `:586-620` (`digestSchema`)
- Modify: `src/shared/model.ts:92-96`
- Modify: `src/shared/entities.ts:24-42`
- Modify: `src/shared/commands.ts:54-58`, `:594-620` (`applyAppearanceUpdate`), `:684-720` (`createTask`), `:327-345` (`assertInvariants`, цикл задач), `:1040-1080` (`applyEvent`)
- Modify: `src/shared/queries.ts:167-195`
- Modify: `tests/web/fixtures.ts:12-35`
- Modify: `tests/property/undo.test.ts:41-57`, `:206-215` (`intents`)
- Modify: `tests/unit/shared.test.ts` (новый `describe` в конце файла)
- Modify: `tests/unit/limits.test.ts:60-100` (одна граница)

**Interfaces:**
- Consumes: ничего нового.
- Produces (на них опираются задачи 2–4):
  - `src/shared/labels.ts`: `PRIORITIES: readonly {id:'p1'|'p2'|'p3'; name:string; hint:string}[]`, `type Priority`, `PRIORITY_IDS: [Priority, ...Priority[]]`, `DEFAULT_PRIORITY: Priority` (= `'p2'`), `LABELS: readonly {id; name; color; description}[]`, `type LabelId`, `LABEL_IDS: [LabelId, ...LabelId[]]`.
  - `src/shared/schemas.ts`: `prioritySchema`, `labelSchema`, `labelsSchema`, `closesSchema`; `taskFieldsSchema` и все производные payload содержат `priority?`, `labels?`, `closes?`; `appearance.update` содержит `hideP3?: boolean`.
  - `Task` (из `taskSchema`) содержит `priority: Priority`, `labels: LabelId[]`, `closes: string | null`; `Appearance` содержит `hideP3: boolean`; `Context` содержит `priorities`, `labels`; `Digest.counts` содержит `p1`, `otvet`; `ExportData.formatVersion === 5`; `exportSchemaV4`.
  - `queryTasks(tasks, projects, filter)` принимает `filter.priority`, `filter.label`, `filter.closes`.

- [x] Шаг 1. Создать `src/shared/labels.ts`:

```ts
// Catalogues behind the owner's priority levels and labels (spec
// docs/specs/2026-09-12-owner-workflow.md §4). A new label is an edit of this
// file and a release, never a command: the set stays small and identical for
// every agent. `LABELS` is what /api/context shows; `labelSchema` in
// schemas.ts is the enum over `LABEL_IDS`, so an unknown label is `invalid`.
export const PRIORITIES = [
  { id: 'p1', name: 'P1', hint: 'Горит: делать первым' },
  { id: 'p2', name: 'P2', hint: 'Обычная задача' },
  { id: 'p3', name: 'P3', hint: 'Когда-нибудь: не сейчас' },
] as const;
export type Priority = (typeof PRIORITIES)[number]['id'];
export const PRIORITY_IDS = PRIORITIES.map((p) => p.id) as [
  Priority,
  ...Priority[],
];
export const DEFAULT_PRIORITY: Priority = 'p2';
export const LABELS = [
  {
    id: 'otvet',
    name: 'ответ',
    color: '#bd811d',
    description:
      'Нужен ответ или решение владельца кому-то: человеку, подрядчику, кандидату',
  },
  {
    id: 'dengi',
    name: 'деньги',
    color: '#298467',
    description:
      'Платёж, долг, приз, финансовое решение; при оплате строка в ledger',
  },
  {
    id: '5-min',
    name: '5 мин',
    color: '#8290a4',
    description: 'Делается за несколько минут, годится в просвет',
  },
  { id: 'lora', name: 'Lora', color: '#9661bf', description: 'Касается модели Lora' },
  { id: 'lily', name: 'Lily', color: '#397faf', description: 'Касается модели Lily' },
  { id: 'ari', name: 'Ari', color: '#a97928', description: 'Касается модели Ari' },
] as const;
export type LabelId = (typeof LABELS)[number]['id'];
export const LABEL_IDS = LABELS.map((l) => l.id) as [LabelId, ...LabelId[]];
```

- [x] Шаг 2. `src/shared/limits.ts`: после строки `checklistItems: 100,` добавить:

```ts
  taskLabels: 8,
  closes: 80,
```

- [x] Шаг 3. `src/shared/schemas.ts`. Импорт после `import { ALL_PROJECTS, NO_PROJECT } from './constants.js';`:

```ts
import { LABEL_IDS, PRIORITY_IDS } from './labels.js';
```

После `statusSchema` (строка 43) добавить:

```ts
export const prioritySchema = z
  .enum(PRIORITY_IDS)
  .describe('Приоритет: p1 горит, p2 обычная (по умолчанию), p3 когда-нибудь');
export const labelSchema = z
  .enum(LABEL_IDS)
  .describe('Метка из каталога labels ответа /api/context');
export const labelsSchema = z
  .array(labelSchema)
  .max(LIMITS.taskLabels)
  .refine((v) => new Set(v).size === v.length, 'Метки не должны повторяться')
  .describe(`До ${LIMITS.taskLabels} меток из каталога, без повторов`);
export const closesSchema = z
  .string()
  .regex(new RegExp(`^[a-z0-9-]{1,${LIMITS.closes}}$`))
  .nullable()
  .describe(
    'Слаг проблемы из /OS/PROBLEMS.md, которую закрывает задача, или null',
  );
```

В `taskFieldsSchema` после `followUp: dateSchema.optional(),` добавить:

```ts
    priority: prioritySchema.optional(),
    labels: labelsSchema.optional(),
    closes: closesSchema.optional(),
```

`appearance.update` заменить целиком:

```ts
  'appearance.update': z
    .object({
      baseRevision: revisionSchema,
      mode: appearanceModeSchema.optional(),
      skinId: skinIdSchema.optional(),
      hideP3: z
        .boolean()
        .optional()
        .describe('Скрывать задачи P3 на доске и в списке'),
    })
    .strict()
    .refine(
      (v) =>
        v.mode !== undefined ||
        v.skinId !== undefined ||
        v.hideP3 !== undefined,
      'Укажите режим, скин или hideP3',
    ),
```

- [x] Шаг 4. `src/shared/domain-schemas.ts`. В импорт из `./schemas.js` добавить `prioritySchema, labelSchema, labelsSchema, closesSchema`; добавить `import { DEFAULT_PRIORITY } from './labels.js';`.

В `taskSchema` после `status: statusSchema,` добавить:

```ts
    // Absent in records stored before 0005_priority_labels_closes (operation
    // results): read as the defaults the migration wrote into the rows.
    priority: prioritySchema.default(DEFAULT_PRIORITY),
    labels: labelsSchema.default([]),
    closes: closesSchema.default(null),
```

В `appearanceSchema` после `skinId: …` добавить:

```ts
    hideP3: z
      .boolean()
      .default(false)
      .describe('Скрывать задачи P3 на доске и в списке'),
```

В `defaultAppearance()` добавить `hideP3: false,` после `skinId: DEFAULT_SKIN_ID,`.

Экспорт: в `exportSchema` заменить `formatVersion: z.literal(4)` на `z.literal(5)`. После `exportSchemaV3` добавить:

```ts
// Format 4 (schema version 5): tasks without priority, labels and closes,
// appearance without hideP3. The record schemas fill the defaults that
// 0005_priority_labels_closes.sql wrote into an existing database.
export const exportSchemaV4 = z
  .object({
    formatVersion: z.literal(4),
    ...exportFields,
    operations: z.array(exportedOperationSchema),
    appearance: z.array(appearanceSchema),
  })
  .strict();
```

В `contextSchema` после `projects: z.array(projectSchema),` добавить:

```ts
    priorities: z
      .array(z.object({ id: prioritySchema, name: z.string(), hint: z.string() }))
      .describe('Уровни приоритета'),
    labels: z
      .array(
        z.object({
          id: labelSchema,
          name: z.string(),
          color: z.string(),
          description: z.string(),
        }),
      )
      .describe('Каталог меток: выбирайте по описанию'),
```

В `digestSchema.counts` заменить объект на:

```ts
    counts: z.object({
      tasks: z.number(),
      archived: z.number(),
      projects: z.number(),
      p1: z.number().describe('Незавершённые P1 вне архива'),
      otvet: z.number().describe('Незавершённые с меткой otvet вне архива'),
    }),
```

- [x] Шаг 5. `src/shared/model.ts`: строки 92–96 заменить на

```ts
// Export format: 2 adds operationSeq to operations, 3 adds the appearance
// preference, 4 adds focusKey and focusLeftAt to tasks (2026-09-10), 5 adds
// priority, labels and closes to tasks and hideP3 to appearance (2026-09-13);
// formats 1-4 are still imported, see exportSchemaV1..V4 and
// backup.upgradeExport.
export const FORMAT_VERSION = 5;
export type { LabelId, Priority } from './labels.js';
```

Если `npm run unused-exports` назовёт этот реэкспорт типов неиспользуемым, удалить строку `export type { LabelId, Priority }`: код и тесты импортируют типы из `./labels.js` напрямую.

- [x] Шаг 6. `src/shared/entities.ts`: в `taskFields` добавить `'priority', 'labels', 'closes',` после `'status',`; `appearanceFields` заменить на `new Set(['mode', 'skinId', 'hideP3'])`.

- [x] Шаг 7. `src/shared/commands.ts`.

Импорт: `import { DEFAULT_PRIORITY, LABEL_IDS, type LabelId } from './labels.js';`.

`ownerLockedFields` (строка 58) заменить на:

```ts
// Fields the source never overwrites once the owner touched the task. Priority
// is here on purpose: an owner who touched a card decided how urgent it is.
const ownerLockedFields = [
  'status',
  'archived',
  'focus',
  'projectId',
  'area',
  'priority',
];
// Labels carry no order of their own: they are stored in catalogue order, so
// the same set written in another order is not a change (TI-086, Codex P3).
function canonicalLabels(labels: readonly LabelId[] = []): LabelId[] {
  return labels.toSorted((a, b) => LABEL_IDS.indexOf(a) - LABEL_IDS.indexOf(b));
}
```

В `createTask` в литерале `record` после `status: fields.status ?? 'todo',` добавить:

```ts
    priority: fields.priority ?? DEFAULT_PRIORITY,
    labels: canonicalLabels(fields.labels),
    closes: fields.closes ?? null,
```

В `commitTaskPatch` после деструктуризации `const { focus, ...patch } = input as { focus?: boolean } & Record<string, unknown>;` (она занимает несколько строк) добавить:

```ts
  if (Array.isArray(patch.labels))
    patch.labels = canonicalLabels(patch.labels as LabelId[]);
```

В `applyTaskSync` после цикла `for (const key of ownerOnlyCreateFields) …` (перед `const existing = findByOrigin(…)`) добавить:

```ts
  if (fields.labels) fields = { ...fields, labels: canonicalLabels(fields.labels) };
```

В `applyAppearanceUpdate` тип патча и патч:

```ts
  const patch: Partial<Pick<Appearance, 'mode' | 'skinId' | 'hideP3'>> = {
    ...(p.mode !== undefined ? { mode: p.mode } : {}),
    ...(p.skinId !== undefined ? { skinId: p.skinId } : {}),
    ...(p.hideP3 !== undefined ? { hideP3: p.hideP3 } : {}),
  };
```

В `assertInvariants`, в цикле `for (const t of state.tasks)` после проверки `itemIds` добавить:

```ts
    if (
      new Set(t.labels).size !== t.labels.length ||
      t.labels.some((l) => !(LABEL_IDS as readonly string[]).includes(l))
    )
      fail('invalid', 'Метки задачи повторяются или не из каталога.');
```

В `applyEvent` заменить строку `if (event.entityKind === 'task' && !prior && isTask(next)) next.commentCount = 0;` на:

```ts
    if (event.entityKind === 'task' && !prior && isTask(next)) {
      next.commentCount = 0;
      // 0005 (drizzle/v2/README.md, data rule variant b): a task created
      // before the columns existed has no priority, labels or closes in its
      // creation event; replay applies the schema defaults, exactly what the
      // migration wrote into the rows, so later events find the same `from`.
      // Through a loose view: the typed record declares the fields as
      // present, and `??=` on a never-nullish field does not compile.
      const fields = next as Record<string, unknown>;
      if (fields.priority === undefined) fields.priority = DEFAULT_PRIORITY;
      if (fields.labels === undefined) fields.labels = [];
      if (fields.closes === undefined) fields.closes = null;
    }
```

- [x] Шаг 8. `src/shared/queries.ts`: добавить `import type { LabelId, Priority } from './labels.js';`. В `TaskFilter` добавить:

```ts
  priority?: Priority;
  label?: LabelId;
  closes?: string;
```

В `queryTasks` в конец условия `.filter((t) => … )` перед закрывающей скобкой добавить три конъюнкта:

```ts
      (!filter.priority || t.priority === filter.priority) &&
      (!filter.label || t.labels.includes(filter.label)) &&
      (!filter.closes || t.closes === filter.closes) &&
```

(вставить перед `(!filter.today ||`, чтобы `today` остался последним).

- [x] Шаг 9. `tests/web/fixtures.ts`: в литерал `makeTask` после `status: 'todo',` добавить `priority: 'p2', labels: [], closes: null,`.

- [x] Шаг 10. `tests/property/undo.test.ts`: в `UNDO_SUBJECT_FIELDS` после `'status',` добавить `'priority', 'labels', 'closes',`. В массив `intents` добавить три элемента:

```ts
  (v: number) => ({
    field: 'priority' as const,
    value: (['p1', 'p2', 'p3'] as const)[v % 3],
  }),
  (v: number) => ({
    field: 'labels' as const,
    value: v % 2 ? ['otvet'] : ['dengi', 'lora'],
  }),
  (v: number) => ({ field: 'closes' as const, value: `slug-${v}` }),
```

Ветка `default` в `command()` уже отправляет `task.update` с `[intent.field]: intent.value`, менять её не нужно.

- [x] Шаг 11. `tests/unit/shared.test.ts`: в тесте, который сверяет предметные поля (`expect([...ENTITIES.appearance.subjectFields].sort()).toEqual(['mode', 'skinId'])`, около строки 163), ожидание заменить на `['hideP3', 'mode', 'skinId']`. В шапку файла добавить импорты

```ts
import {
  DEFAULT_PRIORITY,
  LABELS,
  LABEL_IDS,
  PRIORITIES,
  PRIORITY_IDS,
} from '../../src/shared/labels.js';
```

и в существующий импорт из `../../src/shared/schemas.js` добавить `closesSchema, labelsSchema, prioritySchema`. В конец файла добавить:

```ts
describe('TI-086 priority and label catalogues', () => {
  it('ids are unique, the schemas are enums over them and the default is p2', () => {
    expect(new Set(LABEL_IDS).size).toBe(LABELS.length);
    expect(new Set(PRIORITY_IDS).size).toBe(PRIORITIES.length);
    expect(PRIORITY_IDS).toEqual(['p1', 'p2', 'p3']);
    expect(prioritySchema.safeParse(DEFAULT_PRIORITY).success).toBe(true);
    expect(prioritySchema.safeParse('p4').success).toBe(false);
    for (const label of LABELS) {
      expect(label.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(label.description.length).toBeGreaterThan(10);
    }
    expect(labelsSchema.safeParse(['otvet', 'dengi']).success).toBe(true);
    expect(labelsSchema.safeParse(['otvet', 'otvet']).success).toBe(false);
    expect(labelsSchema.safeParse(['unknown']).success).toBe(false);
    expect(closesSchema.safeParse('lora-km-of-vacancy').success).toBe(true);
    expect(closesSchema.safeParse(null).success).toBe(true);
    expect(closesSchema.safeParse('Lora KM').success).toBe(false);
  });
});
```

- [x] Шаг 12. `tests/unit/limits.test.ts`: в шапку добавить `import { LABEL_IDS } from '../../src/shared/labels.js';`. В тесте `entity schemas accept the limit and refuse limit + 1` после границы `task.checklist` добавить границу `closes`:

```ts
    boundary(
      taskSchema,
      (n) => task({ closes: 'a'.repeat(n) }),
      LIMITS.closes,
      'task.closes',
    );
```

Границу по числу меток через `boundary` проверить нельзя: каталог даёт шесть разных слагов, а лимит восемь, и правило «без повторов» сработает раньше лимита. Вместо неё добавить в тот же `describe`:

```ts
  it('labels: the whole catalogue fits into one task and the limit is not below the catalogue size', () => {
    expect(taskSchema.safeParse(task({ labels: [...LABEL_IDS] })).success).toBe(
      true,
    );
    expect(LIMITS.taskLabels).toBeGreaterThanOrEqual(LABEL_IDS.length);
  });
```

- [x] Verify:

```sh
npx tsc --noEmit                      # ожидаемо ПАДАЕТ до задачи 2: src/server/schema.ts и backup.ts ещё не знают полей — это нормально, продолжить
npx vitest run tests/unit tests/property/undo.test.ts tests/web/commands.test.ts tests/web/selectors.test.ts
```

Ожидание: `tests/unit/shared.test.ts` новый describe зелёный; `tests/property/undo.test.ts` guard `the production subject list is exactly the oracle list` зелёный (списки совпадают, 18 полей); `tests/unit/limits.test.ts` зелёный. Если `undo.test` красный по `labels` — проверить, что `changesBetween` сравнивает массивы через `JSON.stringify` (так и есть) и что `intents` отдают новый массив каждый раз.

- [ ] Commit: не делать (один коммит на карточку в конце по слову владельца).

---

### Task 2: Сервер: миграция `0005`, экспорт формата 5, контекст, дайджест, фильтры `/api/tasks`

**Files:**
- Modify: `src/server/schema.ts:22-25` (импорты), `:30-37` (`appearance`), `:53-62` (`tasks`)
- Create (генерация): `drizzle/v2/0005_priority_labels_closes.sql`, `drizzle/v2/meta/0005_snapshot.json`, запись в `drizzle/v2/meta/_journal.json`
- Modify: `src/server/backup.ts:27-33` (импорт), `:60-90` (`upgradeExport`)
- Modify: `src/server/context.ts:1-10`, `:34-50` (`RULES`), `:60-70` (`buildContext`)
- Modify: `src/server/digest.ts:96-100`
- Modify: `src/server/routes/reads.ts:4` (импорт), `:120-140` (query)
- Modify: `drizzle/v2/README.md` (одна запись)
- Create: `tests/api/priority-labels.test.ts`
- Modify: `tests/api/permissions.test.ts:566-690` (новый `it` в describe «owner fields need an explicit confirmation from agents»)
- Modify: `tests/api/appearance.test.ts:41-47` и новый `it`
- Modify: `tests/api/migration-compat.test.ts` (новый `describe` в конце)

**Interfaces:**
- Consumes: всё из Task 1 (`Priority`, `LabelId`, `PRIORITY_IDS`, `LABELS`, `PRIORITIES`, `prioritySchema`, `labelSchema`, `exportSchemaV4`, `FORMAT_VERSION = 5`, `queryTasks` с новыми фильтрами, `Digest.counts.p1/otvet`).
- Produces: `GET /api/tasks?priority=p1&label=otvet&closes=slug`; `GET /api/context` с `priorities`, `labels`; `GET /api/digest` с `counts.p1`, `counts.otvet`; таблицы с колонками `tasks.priority`, `tasks.labels`, `tasks.closes`, `appearance.hide_p3`; `upgradeExport` принимает формат 4.

- [x] Шаг 1. `src/server/schema.ts`. Импорт после `import { APPEARANCE_MODES } from '../shared/appearance.js';`:

```ts
import { PRIORITY_IDS } from '../shared/labels.js';
```

В таблице `appearance` после `skinId: text('skin_id').notNull(),`:

```ts
  hideP3: integer('hide_p3', { mode: 'boolean' }).notNull().default(false),
```

В таблице `tasks` после `status: text('status').notNull(),`:

```ts
    // TI-086: the owner's priority level, the labels from the catalogue and
    // the slug of the /OS problem the task closes. Defaults are what
    // 0005_priority_labels_closes.sql wrote into existing rows.
    priority: text('priority', { enum: PRIORITY_IDS }).notNull().default('p2'),
    labels: text('labels', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    closes: text('closes'),
```

- [x] Шаг 2. Сгенерировать миграцию:

```sh
npm run db:generate -- --name priority_labels_closes
cat drizzle/v2/0005_priority_labels_closes.sql
```

Ожидаемое содержимое (порядок таблиц может отличаться):

```sql
ALTER TABLE `appearance` ADD `hide_p3` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `priority` text DEFAULT 'p2' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `labels` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `closes` text;
```

Если kit сгенерировал пересборку таблицы (`__new_tasks`) вместо `ALTER … ADD`, значит default не попал в схему: проверить `.default(...)` у трёх колонок и перегенерировать (удалить сгенерированные `0005_*.sql`, `meta/0005_snapshot.json` и последнюю запись `_journal.json` перед повтором). Добавить в начало файла комментарий (файл ещё не применён, редактировать можно):

```sql
-- priority / labels / closes on tasks and hide_p3 on appearance (TI-086,
-- docs/specs/2026-09-12-owner-workflow.md §4). Existing rows get the schema
-- defaults: p2, no labels, no problem, P3 visible. Data rule (drizzle/v2/README.md,
-- variant b): applyEvent applies the same defaults on replay of a creation event
-- that predates the columns, and backup.upgradeExport reads format 4.
```

Проверка миграции на копии живой базы владельца (чтение `data/dev.db` из основного чекаута, запись только в `/tmp`):

```sh
cp ~/code/taskindex/data/dev.db /tmp/ti085.db
DATABASE_PATH=/tmp/ti085.db npm run db:migrate
sqlite3 /tmp/ti085.db "PRAGMA table_info(tasks);" | grep -E "priority|labels|closes"
sqlite3 /tmp/ti085.db "SELECT priority, labels, closes FROM tasks LIMIT 3;"
rm /tmp/ti085.db
```

Ожидание: три строки колонок; значения `p2|[]|` у существующих задач.

- [x] Шаг 3. `src/server/backup.ts`. В импорт из `../shared/domain-schemas.js` добавить `exportSchemaV4`. В `upgradeExport` после строки `if (version === FORMAT_VERSION) return exportSchema.parse(raw);` добавить:

```ts
  // Format 4 (schema version 5): the record schemas fill priority, labels,
  // closes and hideP3 with the defaults 0005 wrote into existing rows.
  if (version === 4)
    return { ...exportSchemaV4.parse(raw), formatVersion: FORMAT_VERSION };
```

Обновить комментарий над функцией: «Reads an export of the current format, of format 4 (schema version 5, no priority/labels/closes/hideP3), of format 3 …». Остальные ветки не меняются: `legacyTaskSchema` производна от `taskSchema` и уже отдаёт значения по умолчанию, `appearanceSchema` тоже.

- [x] Шаг 4. `src/server/context.ts`. Импорт: `import { LABELS, PRIORITIES } from '../shared/labels.js';`. В `RULES` добавить две строки после строки про `focus`:

```ts
  'Приоритет: p1 горит, p2 обычная (по умолчанию), p3 когда-нибудь. Порядок карточек в колонке остаётся ручным (orderKey); приоритет только помечает и фильтрует, его выставляет владелец словами. Метки только из каталога labels этого ответа, до 8 без повторов. closes — слаг проблемы из /OS/PROBLEMS.md, которую закрывает задача.',
  'После касания владельца task.sync не меняет priority (как статус, архив, область и проект). Прямая команда над priority, labels или closes из ownerFields требует confirmOwnerFields: true.',
```

В `buildContext` после `projects: state.projects,` добавить:

```ts
    priorities: [...PRIORITIES],
    labels: [...LABELS],
```

- [x] Шаг 5. `src/server/digest.ts`: блок `counts` заменить на:

```ts
      counts: {
        tasks: state.tasks.length,
        archived: state.tasks.filter((t) => t.archived).length,
        projects: state.projects.length,
        p1: state.tasks.filter(
          (t) => !t.archived && t.status !== 'done' && t.priority === 'p1',
        ).length,
        otvet: state.tasks.filter(
          (t) =>
            !t.archived && t.status !== 'done' && t.labels.includes('otvet'),
        ).length,
      },
```

- [x] Шаг 6. `src/server/routes/reads.ts`. Импорт: `import { areaSchema, labelSchema, prioritySchema, statusSchema } from '../../shared/schemas.js';`. В query `/api/tasks` после `status: statusSchema.optional(),` добавить:

```ts
              priority: prioritySchema.optional(),
              label: labelSchema.optional().describe('Только задачи с этой меткой'),
              closes: z
                .string()
                .regex(/^[a-z0-9-]{1,80}$/)
                .optional()
                .describe('Только задачи, закрывающие эту проблему /OS'),
```

Ничего больше: `identity` собирается из остатка `q` и включит новые параметры в отпечаток курсора сам.

- [x] Шаг 7. `drizzle/v2/README.md`: после абзаца про `0004_focus_desk` добавить:

```md
  2026-09-13: `0005_priority_labels_closes` (TI-086, спека `docs/specs/2026-09-12-owner-workflow.md` §4) — вариант (б).
  Колонки `tasks.priority TEXT NOT NULL DEFAULT 'p2'`, `tasks.labels TEXT NOT NULL DEFAULT '[]'`,
  `tasks.closes TEXT NULL`, `appearance.hide_p3 INTEGER NOT NULL DEFAULT false` добавляются
  `ALTER TABLE … ADD` с default, пересборка не нужна. Формат экспорта поднят до 5; `upgradeExport`
  читает формат 4 через `exportSchemaV4`, значения по умолчанию подставляют сами схемы записей
  (`taskSchema`, `appearanceSchema` с `.default()`); `applyEvent` при replay события создания без
  этих полей ставит те же значения, поэтому `validateExport` сходится и для журнала, записанного до
  миграции. Тест: `tests/api/migration-compat.test.ts`, describe `0005_priority_labels_closes backfill`.
```

- [x] Шаг 8. Создать `tests/api/priority-labels.test.ts`:

```ts
// TI-086: priority, labels and closes on a task; hideP3 on the appearance
// preference; the filters, the digest counters and the catalogue in context.
import { afterEach, describe, it, expect } from 'vitest';
import { fixture, success } from './helpers.js';
import { LABELS, PRIORITIES } from '../../src/shared/labels.js';
import type {
  Context,
  Digest,
  OperationError,
  Task,
} from '../../src/shared/model.js';
const cleanup: (() => void)[] = [];
function setup() {
  const f = fixture();
  cleanup.push(f.close);
  return f;
}
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
const task = (f: ReturnType<typeof setup>, id: string): Task =>
  f.state().tasks.find((t) => t.id === id)!;
const ids = async (f: ReturnType<typeof setup>, query: string) => {
  const response = await f.app.request(`/api/tasks?${query}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: { id: string }[] };
  return body.items.map((t) => t.id).sort();
};
describe('TI-086 task fields', () => {
  it('creates with defaults, accepts explicit values and records them in the event', async () => {
    const f = setup();
    const plain = success(
      await f.post({
        command: 'task.create',
        payload: { id: 'plain', area: 'agency', title: 'Обычная' },
      }),
    );
    expect(plain.results[0]!.record).toMatchObject({
      priority: 'p2',
      labels: [],
      closes: null,
    });
    const urgent = success(
      await f.post({
        command: 'task.create',
        payload: {
          id: 'urgent',
          area: 'agency',
          title: 'Горит',
          priority: 'p1',
          labels: ['otvet', 'dengi'],
          closes: 'lora-km-of-vacancy',
        },
      }),
    );
    expect(urgent.results[0]!.record).toMatchObject({
      priority: 'p1',
      labels: ['otvet', 'dengi'],
      closes: 'lora-km-of-vacancy',
    });
    expect(urgent.events[0]!.changes).toMatchObject({
      priority: { from: null, to: 'p1' },
      labels: { from: null, to: ['otvet', 'dengi'] },
      closes: { from: null, to: 'lora-km-of-vacancy' },
    });
    const updated = success(
      await f.post({
        command: 'task.update',
        payload: {
          id: 'urgent',
          baseRevision: 1,
          priority: 'p3',
          labels: [],
          closes: null,
        },
      }),
    );
    expect(updated.events[0]!.changes).toEqual(
      expect.objectContaining({
        priority: { from: 'p1', to: 'p3' },
        labels: { from: ['otvet', 'dengi'], to: [] },
        closes: { from: 'lora-km-of-vacancy', to: null },
      }),
    );
    const undone = success(
      await f.post({
        command: 'undo',
        payload: { operationId: updated.operationId },
      }),
    );
    expect(undone.results[0]!.record).toMatchObject({
      priority: 'p1',
      labels: ['otvet', 'dengi'],
      closes: 'lora-km-of-vacancy',
    });
    const saved = success(
      await f.post({
        command: 'task.save',
        payload: {
          id: 'urgent',
          baseRevision: task(f, 'urgent').revision,
          fields: { priority: 'p2', labels: ['lora'] },
          status: 'doing',
        },
      }),
    );
    expect(saved.results[0]!.record).toMatchObject({
      priority: 'p2',
      labels: ['lora'],
      status: 'doing',
    });
  });
  it('stores labels in catalogue order and treats the same set in another order as no change', async () => {
    const f = setup();
    const created = success(
      await f.post({
        command: 'task.create',
        payload: { id: 'l', area: 'agency', title: 'L', labels: ['dengi', 'otvet'] },
      }),
    );
    expect((created.results[0]!.record as Task).labels).toEqual(['otvet', 'dengi']);
    const same = success(
      await f.post({
        command: 'task.update',
        payload: { id: 'l', baseRevision: 1, labels: ['dengi', 'otvet'] },
      }),
    );
    expect(same.events).toEqual([]);
    expect(task(f, 'l').revision).toBe(1);
    const synced = success(
      await f.post(
        {
          command: 'task.sync',
          payload: {
            origin: { system: 'os', ref: 'l-sync', version: '1' },
            fields: { area: 'agency', title: 'S', labels: ['lora', '5-min'] },
          },
        },
        { role: 'agent' },
      ),
    );
    expect((synced.results[0]!.record as Task).labels).toEqual(['5-min', 'lora']);
  });
  it('refuses an unknown label, a duplicate, more than eight and a slug outside the pattern', async () => {
    const f = setup();
    const refuse = async (payload: Record<string, unknown>, path: string) => {
      const r = await f.post({
        command: 'task.create',
        payload: { area: 'agency', title: 'X', ...payload } as never,
      });
      expect(r.status).toBe(400);
      const body = r.body as OperationError;
      expect(body.code).toBe('invalid');
      expect(body.issues!.map((i) => i.path)).toContain(path);
    };
    await refuse({ labels: ['unknown'] }, 'payload.labels[0]');
    await refuse({ labels: ['otvet', 'otvet'] }, 'payload.labels');
    await refuse(
      { labels: ['otvet', 'dengi', '5-min', 'lora', 'lily', 'ari', 'otvet', 'dengi', 'lora'] },
      'payload.labels',
    );
    await refuse({ closes: 'Lora KM' }, 'payload.closes');
    await refuse({ priority: 'p4' }, 'payload.priority');
    expect(f.state().tasks).toHaveLength(0);
  });
  it('task.sync applies the fields until the owner touches the task, then skips priority as locked', async () => {
    const f = setup();
    const origin = { system: 'os', ref: 'tasks:1', version: '1' };
    const created = success(
      await f.post(
        {
          command: 'task.sync',
          payload: {
            origin,
            fields: {
              area: 'agency',
              title: 'Из TASKS.md',
              priority: 'p3',
              labels: ['dengi'],
              closes: 'fyp-production-no-contractor',
            },
          },
        },
        { role: 'agent' },
      ),
    );
    expect(created.results[0]).toMatchObject({
      applied: expect.arrayContaining(['priority', 'labels', 'closes']),
    });
    const id = (created.results[0]!.record as Task).id;
    const second = success(
      await f.post(
        {
          command: 'task.sync',
          payload: {
            origin: { ...origin, version: '2' },
            fields: { area: 'agency', title: 'Из TASKS.md', priority: 'p1', labels: [] },
          },
        },
        { role: 'agent' },
      ),
    );
    expect(second.results[0]).toMatchObject({ applied: expect.arrayContaining(['priority', 'labels']) });
    expect(task(f, id)).toMatchObject({ priority: 'p1', labels: [] });
    // The owner touches the note only: priority is locked anyway, labels are not.
    success(
      await f.post({
        command: 'task.update',
        payload: { id, baseRevision: task(f, id).revision, note: 'Владелец' },
      }),
    );
    const third = success(
      await f.post(
        {
          command: 'task.sync',
          payload: {
            origin: { ...origin, version: '3' },
            fields: { area: 'agency', title: 'Из TASKS.md', priority: 'p3', labels: ['ari'] },
          },
        },
        { role: 'agent' },
      ),
    );
    expect(third.results[0]).toMatchObject({
      applied: expect.arrayContaining(['labels']),
      skipped: expect.arrayContaining([{ field: 'priority', reason: 'locked' }]),
    });
    expect(task(f, id)).toMatchObject({ priority: 'p1', labels: ['ari'] });
  });
  it('filters /api/tasks by priority, label and closes, and the cursor identity includes them', async () => {
    const f = setup();
    const create = (id: string, extra: Record<string, unknown>) =>
      f.post({
        command: 'task.create',
        payload: { id, area: 'agency', title: id, ...extra } as never,
      });
    expect((await create('a', { priority: 'p1', labels: ['otvet'] })).status).toBe(200);
    expect((await create('b', { priority: 'p3', labels: ['otvet', 'lora'] })).status).toBe(200);
    expect((await create('c', { closes: 'x-1' })).status).toBe(200);
    expect(await ids(f, 'priority=p1')).toEqual(['a']);
    expect(await ids(f, 'priority=p3')).toEqual(['b']);
    expect(await ids(f, 'label=otvet')).toEqual(['a', 'b']);
    expect(await ids(f, 'label=lora&priority=p3')).toEqual(['b']);
    expect(await ids(f, 'closes=x-1')).toEqual(['c']);
    expect((await f.app.request('/api/tasks?label=nope')).status).toBe(400);
    expect((await f.app.request('/api/tasks?priority=p9')).status).toBe(400);
    expect((await f.app.request('/api/tasks?closes=Bad')).status).toBe(400);
    const page = (await (
      await f.app.request('/api/tasks?label=otvet&limit=1')
    ).json()) as { nextCursor: string | null };
    expect(page.nextCursor).not.toBeNull();
    const other = await f.app.request(
      `/api/tasks?label=lora&limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`,
    );
    expect(other.status).toBe(400);
  });
  it('digest counts p1 and otvet without done and archived tasks; context lists the catalogues', async () => {
    const f = setup();
    const create = (id: string, extra: Record<string, unknown>) =>
      f.post({
        command: 'task.create',
        payload: { id, area: 'agency', title: id, ...extra } as never,
      });
    await create('open', { priority: 'p1', labels: ['otvet'] });
    await create('done', { priority: 'p1', labels: ['otvet'], status: 'done' });
    await create('other', { labels: ['otvet'] });
    success(
      await f.post({
        command: 'task.archive',
        payload: { id: 'other', baseRevision: 1 },
      }),
    );
    const digest = (await (await f.app.request('/api/digest')).json()) as Digest;
    expect(digest.counts).toMatchObject({ p1: 1, otvet: 1 });
    const context = (await (await f.app.request('/api/context')).json()) as Context;
    expect(context.priorities).toEqual([...PRIORITIES]);
    expect(context.labels).toEqual([...LABELS]);
    expect(context.rules.join('\n')).toContain('Порядок карточек в колонке остаётся ручным');
    expect(context.rules.join('\n')).toContain('task.sync не меняет priority');
  });
});
```

- [x] Шаг 9. `tests/api/permissions.test.ts`: в describe `owner fields need an explicit confirmation from agents` добавить:

```ts
  it('TI-086: a priority the owner set is an owner field; labels and closes follow the same rule', async () => {
    const f = await seed(setup());
    success(
      await f.post({
        command: 'task.update',
        payload: {
          id: 'ta',
          baseRevision: task(f, 'ta').revision,
          priority: 'p1',
          labels: ['otvet'],
          closes: 'lora-km-of-vacancy',
        },
      }),
    );
    expect(task(f, 'ta').ownerFields).toEqual(
      expect.arrayContaining(['priority', 'labels', 'closes']),
    );
    const refused = await f.post(
      {
        command: 'task.update',
        payload: { id: 'ta', baseRevision: task(f, 'ta').revision, priority: 'p2', labels: [] },
      },
      { role: 'agent' },
    );
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining(PROTECTED),
      conflicts: [{ entityKind: 'task', entityId: 'ta', fields: ['priority', 'labels'] }],
    });
    expect(task(f, 'ta').priority).toBe('p1');
    const confirmed = success(
      await f.post(
        {
          command: 'task.update',
          payload: { id: 'ta', baseRevision: task(f, 'ta').revision, priority: 'p2' },
        },
        { role: 'agent', confirmOwnerFields: true },
      ),
    );
    expect(confirmed.results[0]).toMatchObject({ confirmedOwnerFields: ['priority'] });
    expect(task(f, 'ta').priority).toBe('p2');
  });
  it('TI-086: a field the owner never changed stays open to a direct agent command, as every other field (spec §4.1)', async () => {
    const f = await seed(setup());
    // The owner changes the note only: ownerFields = ['note'].
    success(
      await f.post({
        command: 'task.update',
        payload: { id: 'ta', baseRevision: task(f, 'ta').revision, note: 'Владелец' },
      }),
    );
    expect(task(f, 'ta').ownerFields).toEqual(['note']);
    const direct = await f.post(
      {
        command: 'task.update',
        payload: {
          id: 'ta',
          baseRevision: task(f, 'ta').revision,
          priority: 'p1',
          labels: ['otvet'],
          closes: 'lora-km-of-vacancy',
        },
      },
      { role: 'agent' },
    );
    expect(direct.status).toBe(200);
    expect(success(direct).results[0]!.confirmedOwnerFields).toBeUndefined();
    expect(task(f, 'ta')).toMatchObject({ priority: 'p1', labels: ['otvet'] });
  });
```

- [x] Шаг 10. `tests/api/appearance.test.ts`: в `toEqual` первого теста (строки 41–47) добавить `hideP3: false,` после `skinId: 'classic',`. Добавить тест в describe:

```ts
  it('TI-086: the owner stores hideP3, an agent may not, and the flag alone is a valid update', async () => {
    const f = api();
    const set = success(
      await f.post({
        command: 'appearance.update',
        payload: { baseRevision: 1, hideP3: true },
      }),
    );
    expect(set.results[0]!.record).toMatchObject({ hideP3: true, revision: 2 });
    expect((await read(f)).body).toMatchObject({ hideP3: true });
    const agent = await f.post(
      {
        command: 'appearance.update',
        payload: { baseRevision: 2, hideP3: false },
      },
      { role: 'agent' },
    );
    expect(agent.status).toBe(403);
    const empty = await f.post({
      command: 'appearance.update',
      payload: { baseRevision: 2 },
    });
    expect(empty.status).toBe(400);
    expect(empty.body).toMatchObject({ code: 'invalid' });
  });
```

- [x] Шаг 11. `tests/api/migration-compat.test.ts`: в конец файла добавить:

```ts
describe('0005_priority_labels_closes backfill', () => {
  it('gives existing rows p2, no labels, no problem and a visible P3, and reads them back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'taskindex-v5-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    for (const name of [
      '0000_taskindex.sql',
      '0001_agent_keys.sql',
      '0002_operation_seq.sql',
      '0003_appearance.sql',
      '0004_focus_desk.sql',
    ])
      cpSync(join(migrationsDirectory(), name), join(dir, name));
    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    migrate(db, { migrationsDir: dir });
    db.sqlite
      .prepare(
        "INSERT INTO tasks(id, area, project_id, title, status, note, due, waiting_for, follow_up, order_key, focus, focus_key, focus_left_at, archived, origin_system, origin_ref, origin_url, origin_version, created_by, created_by_label, owner_touched_at, owner_fields, revision, created_at, updated_at) VALUES ('old', 'agency', NULL, 'Old', 'todo', '', NULL, '', NULL, 'a0', 0, NULL, NULL, 0, NULL, NULL, NULL, NULL, 'owner', 'Владелец', NULL, '[]', 1, '2026-09-08T12:00:00.000Z', '2026-09-08T12:00:00.000Z')",
      )
      .run();
    db.sqlite
      .prepare(
        "INSERT INTO appearance(id, mode, skin_id, revision, updated_at) VALUES ('owner', 'dark', 'focus', 2, '2026-09-08T12:00:00.000Z')",
      )
      .run();
    migrate(db, { logger: { warn: () => {} } });
    expect(() => assertSchema(db)).not.toThrow();
    expect(
      db.sqlite.prepare("SELECT priority, labels, closes FROM tasks WHERE id = 'old'").get(),
    ).toEqual({ priority: 'p2', labels: '[]', closes: null });
    expect(
      db.sqlite.prepare("SELECT hide_p3 FROM appearance WHERE id = 'owner'").get(),
    ).toEqual({ hide_p3: 0 });
    const state = readState(db);
    expect(state.tasks[0]).toMatchObject({ priority: 'p2', labels: [], closes: null });
    expect(state.appearance[0]).toMatchObject({ mode: 'dark', hideP3: false });
  });
  it('upgradeExport reads a format 4 export; a journal written before the columns replays with the defaults and takes later priority events', async () => {
    // The fixture database of schema version 2: its creation events carry no
    // priority, labels or closes. After the full migration the owner changes
    // the priority; the export then holds a creation event without the field
    // and an update event with `from: 'p2'`, and validateExport must agree.
    const db = openDatabase(':memory:');
    cleanup.push(() => db.close());
    migrate(db, { migrationsDir: legacyMigrations() });
    loadLegacy(db, fixture);
    migrate(db, { logger: { warn: () => {} } });
    const app = createApp({
      db,
      baseURL: 'http://localhost:3001',
      trustedOrigins: ['http://localhost:5173'],
      authorize: () => owner,
    });
    cleanup.push(() => app.closeStreams());
    const before = readState(db).tasks.find((t) => t.id === 't1')!;
    expect(before).toMatchObject({ priority: 'p2', labels: [], closes: null });
    const response = await app.request('/api/commands', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:5173',
      },
      body: JSON.stringify({
        operationId: 'ti-086-bump',
        generation: getSetting(db, 'generation'),
        command: 'task.update',
        payload: { id: 't1', baseRevision: before.revision, priority: 'p1' },
      }),
    });
    expect(response.status).toBe(200);
    const exported = exportWorkspace(db);
    expect(exported.formatVersion).toBe(FORMAT_VERSION);
    expect(exported.tasks.find((t) => t.id === 't1')).toMatchObject({
      priority: 'p1',
      labels: [],
      closes: null,
    });
    expect(exported.appearance[0]).toMatchObject({ hideP3: false });
    expect(() => validateExport(exported)).not.toThrow();
    // The same export as format 4: records without the fields, as a client of
    // the previous build would have written them. The schemas fill the defaults.
    const strip = ({
      priority: _p,
      labels: _l,
      closes: _c,
      ...rest
    }: Record<string, unknown>) => rest;
    const legacy = {
      ...exported,
      formatVersion: 4,
      tasks: exported.tasks.map((t) =>
        t.id === 't1' ? t : strip(t as unknown as Record<string, unknown>),
      ),
      appearance: exported.appearance.map(({ hideP3: _h, ...rest }) => rest),
    };
    const upgraded = upgradeExport(legacy);
    expect(upgraded.formatVersion).toBe(FORMAT_VERSION);
    expect(upgraded.tasks.find((t) => t.id !== 't1')).toMatchObject({
      priority: 'p2',
      labels: [],
      closes: null,
    });
    expect(upgraded.appearance[0]).toMatchObject({ hideP3: false });
    expect(() => validateExport(upgraded)).not.toThrow();
    const target = openDatabase(':memory:');
    cleanup.push(() => target.close());
    migrate(target);
    importWorkspace(target, legacy, { replace: true });
    expect(readState(target).tasks.find((t) => t.id === 't1')).toMatchObject({
      priority: 'p1',
    });
  });
});
```

Все использованные имена (`legacyMigrations`, `loadLegacy`, `fixture`, `createApp`, `getSetting`, `owner`, `exportWorkspace`, `upgradeExport`, `validateExport`, `importWorkspace`, `readState`, `assertSchema`, `migrationsDirectory`, `FORMAT_VERSION`, `mkdtempSync`, `cpSync`, `rmSync`, `join`, `tmpdir`) уже импортированы в шапке этого файла. Задача `t1` в фикстуре существует (`fixture.tasks` это `t1` и одна задача с UUID). Тест проходит, потому что `applyEvent` (Task 1, шаг 7) подставляет значения при replay события создания без полей, событие `ti-086-bump` несёт `priority: {from: 'p2', to: 'p1'}`, а `exportSchemaV4` парсит записи через `taskSchema` и `appearanceSchema` с `.default()`.

- [x] Verify:

```sh
npx tsc --noEmit
npx vitest run tests/api tests/unit tests/property
```

Ожидание: всё зелёное, включая `tests/api/migrations.test.ts` (снапшот Drizzle совпадает со схемой, версия схемы 6), `tests/api/openapi.test.ts` (новых компонентов нет), существующий тест `a database of the previous version migrates, exports as format 2, validates, imports…` (журнал старой базы без полей проходит `validateExport` благодаря `applyEvent`). Запуск в sandbox:

```sh
eval "$(npm run -s sandbox)"
npm run -s cli -- task create --area agency --title 'Проверка' --payload '{"priority":"p1","labels":["otvet"],"closes":"lora-km-of-vacancy"}' | head -c 400
npm run -s cli -- tasks --payload '{}' 2>/dev/null; npm run -s cli -- context | python3 -c "import json,sys; d=json.load(sys.stdin); print([l['id'] for l in d['labels']], [p['id'] for p in d['priorities']])"
npm run sandbox -- --stop
```

Ожидание: задача создана с `priority: "p1"`; контекст печатает шесть меток и три приоритета. (Флаги `--priority` и `--labels` появятся в Task 3.)

- [x] Commit: не делать.

---

### Task 3: CLI: флаг-список `--labels`, флаги чтения, справка

**Files:**
- Modify: `src/cli/spec.ts:7` (`FlagKind`), `:165-190` (READS `tasks`), `:597-603` (`HELP_TEXT.payloads`), `:636-670` (`JsonSchemaNode`, `kindOf`)
- Modify: `src/cli/help.ts:24-56` (`placeholder`), `:58-69` (`typeLabel`)
- Modify: `src/cli/writes.ts:38-55` (`convert`)
- Modify: `tests/cli/help.test.ts:185-200` (тест `documents --today…`)
- Modify: `tests/cli/cli.test.ts` (новый `it` в первом describe)

**Interfaces:**
- Consumes: payload-схемы из Task 1 (флаги строятся из них сами); параметры `/api/tasks` из Task 2 (`tests/cli/help.test.ts` сверяет READS с OpenAPI).
- Produces: `taskindex task create --priority p1 --labels otvet,dengi --closes slug`; `taskindex task update ID --base-revision N --labels '["otvet"]'` (JSON тоже принимается); `taskindex tasks --priority p1 --label otvet --closes slug`; `taskindex appearance set --hide-p3 true`.

- [x] Шаг 1. `src/cli/spec.ts`. `FlagKind`:

```ts
type FlagKind = 'string' | 'boolean' | 'number' | 'json' | 'list';
```

`JsonSchemaNode` добавить `items?: JsonSchemaNode;`. `kindOf` заменить на:

```ts
function kindOf(node: JsonSchemaNode): FlagKind {
  const found = types(node);
  // An array of strings (labels, itemIds) is typed on the command line as a
  // comma-separated list; a JSON array is still accepted (writes.ts).
  if (found.includes('array') && node.items && types(node.items).includes('string'))
    return 'list';
  if (found.includes('object') || found.includes('array')) return 'json';
  if (found.includes('boolean')) return 'boolean';
  if (found.includes('integer') || found.includes('number')) return 'number';
  return 'string';
}
```

В `READS`, элемент `tasks`, после `boolFilter('has-follow-up', …)` добавить:

```ts
      flag('priority', 'string', 'Приоритет', { values: ['p1', 'p2', 'p3'] }),
      flag('label', 'string', 'Одна метка из каталога (taskindex context → labels)'),
      flag('closes', 'string', 'Слаг проблемы из /OS/PROBLEMS.md'),
```

`HELP_TEXT.payloads` заменить на:

```ts
  payloads:
    'Поля записи задаются флагами (--project-id, --waiting-for, --follow-up: kebab-case имён полей) или одним --payload JSON / --file. Флаги-объекты (--origin, --fields, --checklist, --position) принимают JSON; флаги-списки (--labels, --item-ids) — список через запятую или JSON-массив. null очищает --due, --follow-up, --project-id и --closes. Полные схемы: taskindex context.',
```

- [x] Шаг 2. `src/cli/help.ts`. В `placeholder` перед `default:` добавить `case 'list': return 'A,B';`. В `typeLabel`:

```ts
  const base =
    entry.kind === 'number'
      ? 'integer'
      : entry.kind === 'boolean'
        ? 'boolean'
        : entry.kind === 'json'
          ? 'json'
          : entry.kind === 'list'
            ? 'list'
            : 'string';
```

- [x] Шаг 3. `src/cli/writes.ts`, `convert`: перед `case 'boolean':` добавить:

```ts
    case 'list': {
      const text = String(value).trim();
      if (text.startsWith('[')) return parseJson(text, `--${entry.name}`);
      return text
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }
```

- [x] Шаг 4. `tests/cli/help.test.ts`: в тесте `documents --today and --has-follow-up for tasks and me/openapi as reads` после `expect(flags).toContain('--all');` добавить:

```ts
    expect(flags).toContain('--priority');
    expect(flags).toContain('--label');
    expect(flags).toContain('--closes');
    expect(tasks.usage).toContain('--priority p1|p2|p3');
    const create = renderHelp('task', 'create') as Rendered;
    expect(create.flags!.find((flag) => flag.flag === '--labels')).toMatchObject({ type: 'list' });
    expect(create.flags!.find((flag) => flag.flag === '--priority')).toMatchObject({ type: 'p1|p2|p3' });
    expect(create.usage).toContain('--labels A,B');
    const reorder = renderHelp('checklist', 'reorder') as Rendered;
    expect(reorder.flags!.find((flag) => flag.flag === '--item-ids')).toMatchObject({ type: 'list' });
```

- [x] Шаг 5. `tests/cli/cli.test.ts`: рядом с тестом `--confirm-owner-fields goes into the envelope…` добавить (использовать те же `setup`, `json`, `success`, `requestBody`, что и соседние тесты файла):

```ts
  it('TI-086: --labels takes a comma list or a JSON array, --priority and --closes are plain fields, tasks filters go to the query', async () => {
    const sent: Record<string, unknown>[] = [];
    const test = await setup((url, init) => {
      if (url.pathname === '/api/context') return json({ generation: 'g_first' });
      sent.push(JSON.parse(requestBody(init)) as Record<string, unknown>);
      return json(success(init));
    });
    expect(
      await test.run([
        'task', 'create', '--area', 'agency', '--title', 'T',
        '--priority', 'p1', '--labels', 'otvet, dengi', '--closes', 'lora-km-of-vacancy',
      ]),
    ).toBe(0);
    expect(sent[0]).toMatchObject({
      command: 'task.create',
      payload: { priority: 'p1', labels: ['otvet', 'dengi'], closes: 'lora-km-of-vacancy' },
    });
    expect(
      await test.run(['task', 'update', 't1', '--base-revision', '3', '--labels', '["lora"]', '--closes', 'null']),
    ).toBe(0);
    expect(sent[1]).toMatchObject({ payload: { labels: ['lora'], closes: null } });
    expect(await test.run(['task', 'create', '--area', 'agency', '--title', 'T', '--labels', 'nope'])).toBe(2);
    expect(test.output.at(-1)).toMatchObject({
      code: 'invalid_arguments',
      issues: [expect.objectContaining({ path: 'labels[0]' })],
    });
    const urls: string[] = [];
    const reads = await setup((url) => {
      urls.push(`${url.pathname}${url.search}`);
      return json({ generation: 'g', seq: 0, items: [], more: false, nextCursor: null });
    });
    expect(await reads.run(['tasks', '--priority', 'p1', '--label', 'otvet', '--closes', 'x-1'])).toBe(0);
    expect(urls.at(-1)).toBe('/api/tasks?priority=p1&label=otvet&closes=x-1');
  });
```

Порядок параметров в строке запроса задан порядком флагов в `READS` (`src/cli/reads.ts` обходит `spec.query`, затем `PAGE_FLAGS`): `priority`, `label`, `closes` идут после `has-follow-up` именно в этом порядке. Путь `labels[0]` печатает `formatPath` в `src/cli/errors.ts` (числовой сегмент как `[n]`, без префикса `payload.`).

- [x] Verify:

```sh
npx tsc --noEmit
npx vitest run tests/cli tests/unit
```

Ожидание: зелёные `help.test.ts` (в том числе `covers every query parameter of every GET route` для трёх новых параметров), `docs.test.ts` (SKILL.md ещё без новых флагов, это допустимо: тест проверяет только упомянутые флаги), `cli.test.ts`.

- [x] Commit: не делать.

---

### Task 4: Веб: значок и чипы на карточке, поля в редакторе, галочка «Без P3»

Все ссылки на строки по `main` `0901fd2`: карточка уже разделена на `card.tsx` и `card-menu.tsx`, `shell.tsx` считает список через `useMemo` над `selection` и `useDeferredValue` поиска, у шапки есть `searchPending`. Эти оптимизации (TI-085) сохраняются: галочка входит в `selection`, а не в отдельный вызов.

**Files:**
- Modify: `src/web/app/commands.ts:6-16`
- Modify: `src/web/app/history.ts:26-45` (`FIELD_LABELS`), `:170-200` (`value`), `:225-245` (`line`)
- Modify: `src/web/app/card.tsx:1-20` (импорты), `:160-180` (строка заголовка в `TaskCardBody`), `:206-232` (`card-label-row`)
- Modify: `src/web/app/card-menu.tsx:1-10` (импорты), `:46-93` (`CardActions`)
- Modify: `src/web/app/editor/editor.tsx:1-40` (импорты), `:60-70` (`sections`), `:83-88` (`details`), `:150-165` (после «Состояние»), `:245-260` (новые секции)
- Modify: `src/web/app/selectors.ts:7-11` (`TaskSelection`), `:48-62` (`selectVisibleTasks`, новый `hiddenP3Count`)
- Modify: `src/web/app/shell.tsx:94-118` (`selection`, `tasks`), `:140-160` (шапка), `:165-175` (подпись фильтра), `:215-235` (пустой экран, доска)
- Modify: `src/web/app/workspace-header.tsx:37-60` (пропсы), `:232-245` (галочка)
- Modify: `src/web/app/workspace-empty.tsx` (вариант «скрыто фильтром»)
- Modify: `src/web/app/appearance.ts` (конец файла)
- Modify: `src/web/skin/board.css` (`.card-label-row` и конец файла), `src/web/skin/editor.css` (конец файла)
- Modify: `tests/web/history.test.ts`, `tests/web/commands.test.ts`, `tests/web/selectors.test.ts` (по одному новому `it`)
- Create: `tests/e2e/priority.spec.ts`

**Interfaces:**
- Consumes: `Task.priority/labels/closes`, `Appearance.hideP3`, `PRIORITIES`, `LABELS`, `Priority`, `LabelId` (Task 1); команда `appearance.update` с `hideP3` (Task 1, Task 2).
- Produces: `TaskSelection` с полем `hideP3?: boolean`, `selectVisibleTasks(data, selection, today)` учитывает `selection.hideP3`, `hiddenP3Count(data, selection, today)`, `chooseHideP3(hideP3: boolean): Promise<void>`, `WorkspaceEmpty` с пропсами `hiddenP3: number` и `onShowP3: () => void`; классы `.priority-mark`, `.priority-p1`, `.priority-p3`, `.label-chip`, `.closes-chip`, `.label-picker`, `.label-option`, `.field-hint`; доступные имена `Приоритет задачи` (combobox), `Метка: <имя>` (checkbox), `Слаг проблемы` (textbox), `Без P3` (checkbox `#hide-p3`).

- [x] Шаг 1. `src/web/app/commands.ts`: в `editableFields` после `'followUp',` добавить `'priority', 'labels', 'closes',`.

- [x] Шаг 2. `src/web/app/history.ts`. Импорт: `import { LABELS, PRIORITIES } from '@shared/labels';`. В `FIELD_LABELS` после `status: 'Состояние',` добавить `priority: 'Приоритет',`; после `projectId: 'Направление',` добавить `labels: 'Метки',` и `closes: 'Закрывает',`. В `value()` перед `if (raw === null || raw === undefined) return { text: 'не задано' };` добавить:

```ts
  if (field === 'priority') {
    const level = PRIORITIES.find((p) => p.id === raw);
    return { text: level ? level.name : 'другой приоритет' };
  }
  if (field === 'closes' && typeof raw === 'string' && raw)
    return { text: `проблема «${raw}»` };
```

Добавить функцию рядом с `checklistText`:

```ts
// Labels are told as a diff by name: what was added and what was removed.
const labelName = (id: unknown) =>
  LABELS.find((l) => l.id === id)?.name ?? String(id);
function labelsText(from: unknown, to: unknown): string {
  const before = Array.isArray(from) ? from : [],
    after = Array.isArray(to) ? to : [];
  const added = after.filter((l) => !before.includes(l)).map(labelName);
  const removed = before.filter((l) => !after.includes(l)).map(labelName);
  const told = [
    ...added.map((n) => `+${n}`),
    ...removed.map((n) => `−${n}`),
  ];
  if (!told.length) return after.length ? after.map(labelName).join(', ') : 'без меток';
  return told.join(', ');
}
```

Начало `line()` заменить: после строки `const label = FIELD_LABELS[field]!;` и до `if (creating) {` вставить

```ts
  if (field === 'labels')
    return { label, text: labelsText(creating ? [] : change.from, change.to) };
```

(при создании `labelsText([], to)` печатает `+ответ, +деньги`; остальной код `line()` не меняется).

- [x] Шаг 3. `src/web/app/card.tsx`. Импорт: `import { LABELS } from '@shared/labels';`. В `TaskCardBody` внутри `<div className="task-title-row">` перед `<h3>{task.title}</h3>` добавить:

```tsx
        {task.priority !== 'p2' && (
          <span
            className={`priority-mark priority-${task.priority}`}
            aria-label={`Приоритет ${task.priority.toUpperCase()}`}
          >
            {task.priority.toUpperCase()}
          </span>
        )}
```

В `<div className="card-label-row">` после блока `{p && showProject && (…project-tag…)}` добавить:

```tsx
        {task.labels.map((id) => {
          const label = LABELS.find((l) => l.id === id);
          return (
            <span key={id} className="label-chip" data-label={id}>
              <span
                className="tag-dot"
                style={{ background: label?.color ?? 'currentColor' }}
              />
              {label?.name ?? id}
            </span>
          );
        })}
        {task.closes && (
          <span className="closes-chip" title={`Закрывает проблему ${task.closes}`}>
            закрывает <code>{task.closes}</code>
          </span>
        )}
```

Пункты меню в `card.tsx` не добавляются: меню одно на доску и живёт в `card-menu.tsx`.

- [x] Шаг 3а. `src/web/app/card-menu.tsx`. Импорт: `import { PRIORITIES } from '@shared/labels';`. В `CardActions` после блока `{STATUSES.map(…)}` и следующего за ним `<DropdownMenuSeparator />` (перед пунктом «В начало очереди») добавить:

```tsx
      {PRIORITIES.map((level) => (
        <DropdownMenuItem
          key={level.id}
          disabled={pending || task.priority === level.id}
          onClick={() =>
            runCardAction(
              saveFields(
                task,
                { priority: level.id },
                `Приоритет: ${level.name}`,
              ),
            )
          }
        >
          <span className={`priority-mark priority-${level.id}`}>
            {level.name}
          </span>
          {level.hint}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
```

`saveFields` и `runCardAction` в `CardActions` уже есть.

- [x] Шаг 4. `src/web/app/editor/editor.tsx`. Импорты: `import { LABELS, PRIORITIES, type Priority } from '@shared/labels';`, `import { Input } from '../../ui/input';`, `import { Checkbox } from '../../ui/checkbox';`, в импорт `lucide-react` добавить `Link2, Tag`. Состояние секций:

```ts
  const [sections, setSections] = useState({
    note: !!task.note,
    due: !!task.due,
    list: task.checklist.length > 0,
    labels: task.labels.length > 0,
    closes: !!task.closes,
  });
```

`details` дополнить:

```ts
    { key: 'labels' as const, icon: <Tag />, label: 'Метки' },
    { key: 'closes' as const, icon: <Link2 />, label: 'Закрывает проблему' },
```

В `<div className="editor-state">` после `</label>` состояния добавить:

```tsx
              <label htmlFor="task-priority">
                Приоритет
                <Choice
                  id="task-priority"
                  value={draft.priority}
                  label="Приоритет задачи"
                  items={PRIORITIES.map((p) => ({
                    value: p.id,
                    label: `${p.name} · ${p.hint}`,
                  }))}
                  onChange={(v) => patch({ priority: v as Priority })}
                />
              </label>
```

После блока `{sections.list && (<ChecklistEditor … />)}` добавить:

```tsx
            {sections.labels && (
              <section className="detail-section">
                <h3>
                  <Tag size={17} />
                  Метки
                </h3>
                <div className="label-picker">
                  {LABELS.map((l) => {
                    const checked = draft.labels.includes(l.id);
                    return (
                      <label key={l.id} htmlFor={`label-${l.id}`} className="label-option">
                        <Checkbox
                          id={`label-${l.id}`}
                          aria-label={`Метка: ${l.name}`}
                          checked={checked}
                          onCheckedChange={(v) =>
                            patch({
                              labels: LABELS.filter((x) =>
                                x.id === l.id ? !!v : draft.labels.includes(x.id),
                              ).map((x) => x.id),
                            })
                          }
                        />
                        <span className="tag-dot" style={{ background: l.color }} />
                        <span>{l.name}</span>
                        <small>{l.description}</small>
                      </label>
                    );
                  })}
                </div>
              </section>
            )}
            {sections.closes && (
              <section className="detail-section">
                <h3>
                  <Link2 size={17} />
                  Закрывает проблему
                </h3>
                <Input
                  aria-label="Слаг проблемы"
                  placeholder="lora-km-of-vacancy"
                  maxLength={LIMITS.closes}
                  value={draft.closes ?? ''}
                  onChange={(e) =>
                    patch({ closes: e.target.value.trim().toLowerCase() || null })
                  }
                />
                <p className="field-hint">
                  Слаг из /OS/PROBLEMS.md: строчные латинские буквы, цифры и дефис.
                </p>
              </section>
            )}
```

Порядок меток в `draft.labels` всегда порядок каталога (фильтр по `LABELS`), так что «отметил, снял, отметил» даёт тот же массив и `dirty` не врёт.

- [x] Шаг 5. `src/web/app/selectors.ts`. `TaskSelection` дополнить полем галочки (она не часть адреса, а предпочтение владельца):

```ts
type TaskSelection = Pick<
  LocationState,
  'area' | 'project' | 'archive' | 'q' | 'archiveSearch' | 'focus' | 'today'
> & {
  /** TI-086: галочка «Без P3» владельца; действует только на доске и в списке области. */
  hideP3?: boolean;
};
```

`selectVisibleTasks` заменить последним оператором:

```ts
  return selectContextualTasks(data, location)
    .filter((t) => !location.today || dueToday(t, today))
    .filter((t) => !location.hideP3 || location.archive || t.priority !== 'p3')
    .toSorted(byOrder);
```

После неё добавить:

```ts
/** TI-086: сколько задач P3 спрятала галочка на этом экране (подпись «скрыто N»). */
export function hiddenP3Count(
  data: TaskSource,
  location: TaskSelection,
  today: string,
): number {
  if (
    !location.hideP3 ||
    location.q.trim().length > 0 ||
    location.focus ||
    location.archive
  )
    return 0;
  return selectContextualTasks(data, location).filter(
    (t) => (!location.today || dueToday(t, today)) && t.priority === 'p3',
  ).length;
}
```

- [x] Шаг 6. `src/web/app/appearance.ts`: в конец файла добавить:

```ts
// TI-086: the «Без P3» toggle is an owner preference like the theme, so it is
// the same on every device.
export async function chooseHideP3(hideP3: boolean) {
  const appearance = workspaceStore.getSnapshot().data.appearance[0];
  await workspaceStore.submit({
    command: 'appearance.update',
    payload: { baseRevision: appearance?.revision ?? 0, hideP3 },
  });
}
```

- [x] Шаг 7. `src/web/app/workspace-header.tsx`. Пропсы: добавить `hideP3: boolean; onHideP3: (value: boolean) => void;` в тип и в деструктуризацию. После `<label htmlFor="today-only" …>…</label>` добавить:

```tsx
          {!globalView && !archive && (
            <label
              htmlFor="hide-p3"
              className={'today-toggle ' + (hideP3 ? 'active' : '')}
            >
              <Checkbox
                id="hide-p3"
                checked={hideP3}
                onCheckedChange={(v) => onHideP3(!!v)}
              />
              <span>Без P3</span>
            </label>
          )}
```

- [x] Шаг 8. `src/web/app/shell.tsx`. Импорты: `import { hiddenP3Count, selectContextualTasks, selectVisibleTasks } from './selectors';`, `import { chooseHideP3 } from './appearance';`, `import { taskCount } from './labels';`. Перед `const selection = useMemo(…)` добавить `const hideP3 = data.appearance[0]?.hideP3 ?? false;`, в объект `selection` и в его список зависимостей добавить `hideP3`:

```ts
  const selection = useMemo(
    () => ({
      area,
      project: projectId,
      archive,
      q: deferredQuery,
      archiveSearch,
      focus: focusView,
      today: todayOnly,
      hideP3,
    }),
    [
      area,
      projectId,
      archive,
      deferredQuery,
      archiveSearch,
      focusView,
      todayOnly,
      hideP3,
    ],
  );
```

`tasks = useMemo(() => selectVisibleTasks(data, selection, today), [data, selection, today])` не меняется. После `const contextual = …` добавить:

```ts
  const hiddenP3 = useMemo(
    () => hiddenP3Count(data, selection, today),
    [data, selection, today],
  );
  const showP3 = () =>
    void chooseHideP3(false).catch((error: Error) =>
      toast.add({ title: error.message, type: 'error' }),
    );
```

В `<WorkspaceHeader …>` добавить:

```tsx
          hideP3={hideP3}
          onHideP3={(value) =>
            void chooseHideP3(value).catch((error: Error) =>
              toast.add({ title: error.message, type: 'error' }),
            )
          }
```

После блока `{todayOnly && !globalView && (<p className="filter-note">…</p>)}` добавить:

```tsx
          {hideP3 && !globalView && !archive && (
            <p className="filter-note" data-hidden-p3={hiddenP3}>
              Без задач P3{hiddenP3 ? `: скрыто ${taskCount(hiddenP3)}` : ''}
            </p>
          )}
```

Условие пустого экрана заменить на `tasks.length === 0 && (todayOnly || hideP3 || archive || !contextual.length)`, компонент вызывать как `<WorkspaceEmpty onCreate={() => setCreate('todo')} hiddenP3={hiddenP3} onShowP3={showP3} />`; проп доски `filtered={todayOnly || hideP3}`.

- [x] Шаг 8а. `src/web/app/workspace-empty.tsx`: скрытые задачи не выдаются за отсутствие задач. Импорт `EyeOff` из `lucide-react`, `taskCount` из `./labels`; пропсы и текст:

```tsx
export function WorkspaceEmpty({
  onCreate,
  hiddenP3,
  onShowP3,
}: {
  onCreate: () => void;
  /** TI-086: сколько задач P3 спрятала галочка «Без P3»; 0 — она ни при чём. */
  hiddenP3: number;
  onShowP3: () => void;
}) {
  const { location, update } = useNavigation();
  const { archive, today: todayOnly } = location;
  const hidden = hiddenP3 > 0;
  return (
    <Empty className="main-empty">
      <span className="empty-icon">
        {archive ? (
          <Archive />
        ) : hidden ? (
          <EyeOff />
        ) : todayOnly ? (
          <CircleCheck />
        ) : (
          <PanelsTopLeft />
        )}
      </span>
      <EmptyTitle>
        {archive
          ? 'Архив пуст'
          : hidden
            ? 'Задачи скрыты фильтром'
            : todayOnly
              ? 'На сегодня всё спокойно'
              : 'Здесь пока нет задач'}
      </EmptyTitle>
      <EmptyDescription>
        {archive
          ? 'Здесь сохраняются задачи, убранные с доски.'
          : hidden
            ? `Галочка «Без P3» прячет ${taskCount(hiddenP3)}${todayOnly ? ', фильтр «На сегодня» остальные' : ''}.`
            : todayOnly
              ? 'Нет задач со сроком или проверкой на сегодня.'
              : 'Добавь первое дело. Достаточно названия.'}
      </EmptyDescription>
      {hidden ? (
        <div className="empty-actions">
          <Button variant="outline" onClick={onShowP3}>
            Показать P3
          </Button>
          {todayOnly && (
            <Button
              variant="outline"
              onClick={() => update({ today: false }, true)}
            >
              Показать все задачи
            </Button>
          )}
        </div>
      ) : todayOnly ? (
        <Button
          variant="outline"
          onClick={() => update({ today: false }, true)}
        >
          Показать все задачи
        </Button>
      ) : (
        !archive && (
          <Button onClick={onCreate}>
            <Plus />
            Добавить задачу
          </Button>
        )
      )}
    </Empty>
  );
}
```

Когда включены обе галочки и пусто, но среди прошедших фильтр «На сегодня» нет P3 (`hiddenP3 === 0`), экран остаётся прежним «На сегодня всё спокойно» с кнопкой «Показать все задачи»: `hiddenP3Count` считает только задачи, прошедшие фильтр «На сегодня», так что скрытых этим экраном P3 нет.

- [x] Шаг 9. Стили. В `src/web/skin/board.css` в правило `.card-label-row { display: flex; gap: 8px; margin: 11px 0 0 26px; align-items: center; min-height: 0; }` добавить `flex-wrap: wrap;` (чипы переносятся, а не вылезают за карточку). В правиле `.list-view .card-label-row { … max-width: 160px; }` заменить `max-width: 160px` на `max-width: 260px`. В конец файла добавить:

```css
/* TI-086: приоритет — значок, не сортировка; метки и closes — чипы в ряду подписей. */
.priority-mark {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  margin-top: 2px;
  padding: 0 5px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  letter-spacing: 0.02em;
  color: var(--muted-foreground);
}
.priority-p1 {
  color: var(--destructive);
  border-color: var(--destructive);
}
.task-done .priority-mark {
  opacity: 0.6;
}
.label-chip,
.closes-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  font-size: 12px;
  color: var(--muted-foreground);
}
.closes-chip code {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11px;
}
.empty-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}
```

Полный слаг остаётся в `title` чипа (шаг 3) и в редакторе. В конец `src/web/skin/editor.css`:

```css
/* TI-086: выбор меток и слаг проблемы в карточке. */
.label-picker {
  display: grid;
  gap: 10px;
}
.label-option {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  cursor: pointer;
}
.label-option small {
  flex-basis: 100%;
  padding-left: 30px;
  font-size: 12px;
  color: var(--muted-foreground);
}
.field-hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--muted-foreground);
}
```

Перед этим проверить, что оба файла целиком лежат внутри `@layer skin` (подключаются из `styles.css` со слоем, см. первую строку `board.css`), и что `--radius-sm`, `--border`, `--destructive`, `--muted-foreground`, `--font-mono` объявлены в `src/web/tokens.css` (`grep -n "\-\-radius-sm\|\-\-font-mono\|\-\-destructive:" src/web/tokens.css`). `npm run check:skin` ловит любой литерал цвета.

- [x] Шаг 10. Веб-тесты.

`tests/web/history.test.ts`, в describe `TI-032 …` добавить:

```ts
  it('TI-086: priority, labels and closes are told in words', () => {
    expect(
      texts({
        priority: { from: 'p2', to: 'p1' },
        labels: { from: ['otvet'], to: ['dengi', 'lora'] },
        closes: { from: null, to: 'lora-km-of-vacancy' },
      }),
    ).toEqual([
      'Приоритет: P2 → P1',
      'Метки: +деньги, +Lora, −ответ',
      'Закрывает: не задано → проблема «lora-km-of-vacancy»',
    ]);
    expect(texts({ labels: { from: ['otvet'], to: [] } })).toEqual(['Метки: −ответ']);
    expect(
      texts(
        {
          createdAt: { from: null, to: '2026-09-09T09:00:00.000Z' },
          title: { from: null, to: 'Новая' },
          priority: { from: null, to: 'p1' },
          labels: { from: null, to: ['otvet'] },
        },
        'task.create',
      ),
    ).toEqual(['Название: «Новая»', 'Приоритет: P1', 'Метки: +ответ']);
  });
```

Порядок строк задаёт `ORDER`, то есть порядок ключей `FIELD_LABELS` после шага 2: `title`, `name`, `text`, `status`, `priority`, `area`, `projectId`, `labels`, `closes`, `focus`, … Ожидания выше записаны в этом порядке.

`tests/web/commands.test.ts`, в describe `command builders` добавить:

```ts
  it('TI-086: task.save carries priority, labels and closes only when they changed', () => {
    const from = base();
    const command = taskSaveCommand(
      { ...from, priority: 'p1', labels: ['otvet'], closes: 'lora-km-of-vacancy' },
      from,
    );
    expect(command).toEqual({
      command: 'task.save',
      payload: {
        id: from.id,
        baseRevision: 3,
        fields: { priority: 'p1', labels: ['otvet'], closes: 'lora-km-of-vacancy' },
      },
    });
    expect(valid(command)).toBe(true);
    expect(taskSaveCommand({ ...from, labels: [] }, from)).toEqual({
      command: 'task.save',
      payload: { id: from.id, baseRevision: 3 },
    });
  });
```

`tests/web/selectors.test.ts`, в describe `selectors` добавить (массив `tasks` дополнить элементом `makeTask({ id: 't8', area: 'agency', title: 'Когда-нибудь', orderKey: 'a7', priority: 'p3' })`, ожидания существующих тестов, перечисляющих все задачи области, дополнить `'t8'` в конце):

```ts
  it('TI-086: «Без P3» hides p3 on the board and in the list, counts what it hid, and leaves search, focus and archive alone', () => {
    const board = where({});
    const hiding = { ...board, hideP3: true };
    expect(ids(selectVisibleTasks(data, board, at('10')))).toContain('t8');
    expect(ids(selectVisibleTasks(data, hiding, at('10')))).not.toContain('t8');
    expect(hiddenP3Count(data, hiding, at('10'))).toBe(1);
    expect(hiddenP3Count(data, board, at('10'))).toBe(0);
    expect(hiddenP3Count(data, { ...hiding, today: true }, at('10'))).toBe(0);
    expect(hiddenP3Count(data, { ...hiding, q: 'когда' }, at('10'))).toBe(0);
    expect(ids(selectVisibleTasks(data, { ...hiding, q: 'когда' }, at('10')))).toEqual(['t8']);
    expect(hiddenP3Count(data, { ...hiding, archive: true }, at('10'))).toBe(0);
  });
```

(добавить `hiddenP3Count` в импорт из `../../src/web/app/selectors`).

- [x] Шаг 11. Создать `tests/e2e/priority.spec.ts` (проект `functional`, файл не попадает под `testIgnore`):

```ts
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { command, signIn } from './helpers';
// TI-086: priority badge, label chips, closes chip, the editor fields and the
// owner's «Без P3» toggle that survives a reload because the server keeps it.
test.beforeEach(async ({ page }, testInfo) => {
  await signIn(page, testInfo);
});
test('TI-086 badge, chips, editor and the hide-P3 toggle', async ({ page }) => {
  const urgent = `П1 ${randomUUID().slice(0, 8)}`;
  const someday = `П3 ${randomUUID().slice(0, 8)}`;
  await command(page, 'task.create', {
    id: randomUUID(),
    area: 'agency',
    title: urgent,
    priority: 'p1',
    labels: ['dengi'],
    closes: 'lora-km-of-vacancy',
  });
  await command(page, 'task.create', {
    id: randomUUID(),
    area: 'agency',
    title: someday,
    priority: 'p3',
  });
  await page.goto('/?area=agency&project=all&view=board');
  const urgentCard = page.locator('article.task-card', { hasText: urgent });
  await expect(urgentCard.getByLabel('Приоритет P1')).toHaveText('P1');
  await expect(urgentCard.locator('.label-chip[data-label="dengi"]')).toHaveText('деньги');
  await expect(urgentCard.locator('.closes-chip code')).toHaveText('lora-km-of-vacancy');
  const somedayCard = page.locator('article.task-card', { hasText: someday });
  await expect(somedayCard.getByLabel('Приоритет P3')).toHaveText('P3');
  // The editor shows and changes the fields.
  await page.getByRole('button', { name: `Открыть: ${urgent}`, exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Приоритет задачи', exact: true })).toContainText('P1');
  await page.getByRole('checkbox', { name: 'Метка: деньги', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Метка: ответ', exact: true }).click();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Редактирование задачи', exact: true })).toBeHidden();
  await expect(urgentCard.locator('.label-chip[data-label="otvet"]')).toHaveText('ответ');
  await expect(urgentCard.locator('.label-chip[data-label="dengi"]')).toHaveCount(0);
  // The toggle hides P3, says how many, and is remembered by the server.
  await page.getByRole('checkbox', { name: 'Без P3', exact: true }).click();
  await expect(somedayCard).toBeHidden();
  await expect(page.locator('.filter-note[data-hidden-p3]')).toContainText('Без задач P3: скрыто');
  await page.reload();
  await expect(page.locator('article.task-card', { hasText: urgent })).toBeVisible();
  await expect(page.locator('article.task-card', { hasText: someday })).toBeHidden();
  await expect(page.getByRole('checkbox', { name: 'Без P3', exact: true })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Без P3', exact: true }).click();
  await expect(page.locator('article.task-card', { hasText: someday })).toBeVisible();
  // The card menu changes priority in one command.
  await page.getByRole('button', { name: `Действия: ${someday}`, exact: true }).click();
  await page.getByRole('menuitem', { name: /P1/ }).click();
  await expect(page.locator('article.task-card', { hasText: someday }).getByLabel('Приоритет P1')).toHaveText('P1');
});
test('TI-086 a direction with only P3 tasks says they are hidden and offers to show them', async ({ page }) => {
  const title = `Только П3 ${randomUUID().slice(0, 8)}`;
  await command(page, 'task.create', {
    id: randomUUID(),
    area: 'personal',
    title,
    priority: 'p3',
  });
  await page.goto('/?area=personal&project=all&view=board');
  await page.getByRole('checkbox', { name: 'Без P3', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Задачи скрыты фильтром', exact: true })).toBeVisible();
  await expect(page.getByText('Галочка «Без P3» прячет 1 задача')).toBeVisible();
  await page.getByRole('button', { name: 'Показать P3', exact: true }).click();
  await expect(page.locator('article.task-card', { hasText: title })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Без P3', exact: true })).not.toBeChecked();
});
```

Второй тест использует область «Личное», чтобы карточки других тестов проекта `functional` (они пишут в «Агентство») не мешали пустому экрану; в проекте `functional` каждая спека получает одну общую базу прогона, поэтому перед этим тестом в «Личном» не должно быть задач других спек: `grep -rn "area: 'personal'" tests/e2e/*.spec.ts` должен находить только этот файл, иначе взять область `development` и повторить проверку.


Если `signIn` в `helpers.ts` требует `testInfo` иначе (сверить с `tests/e2e/regressions.spec.ts`), повторить его сигнатуру. Если чекбокс Base UI не отдаёт роль `checkbox` по имени из `aria-label`, кликать по `label[for="label-dengi"]`.

- [x] Verify:

```sh
npm run check                       # целиком: tsc, lint, unused-exports, format, build, check:skin, vitest
npx playwright install chromium     # если ещё нет
npm run e2e -- --project functional --grep TI-086
npm run e2e                         # весь набор; visual пишет только в test-results/, эталон не трогается
```

Ожидание: `npm run check` зелёный; `priority.spec.ts` зелёный; остальной e2e зелёный. Ручная проверка переноса (e2e её не доказывает): в sandbox создать задачу со всеми шестью метками и `closes` из 80 символов, посмотреть карточку на доске при ширине окна 390 px и в списке при 1440 px: чипы переносятся на новую строку, слаг обрезан многоточием, полный виден в подсказке при наведении и в редакторе. Если `npm run unused-exports` называет `hiddenP3Count` или `chooseHideP3`, значит они не подключены в `shell.tsx`, исправить подключение, а не помечать `@internal`. Ручная проверка в sandbox: `eval "$(npm run -s sandbox)"`, войти по `owner.json`, создать задачу, поставить P1 из меню, отметить метку в карточке, включить «Без P3».

- [x] Commit: не делать.

---

### Task 5: Документация, реестр, финальный гейт

**Files:**
- Modify: `skills/taskindex/SKILL.md` (раздел «Правки» и раздел про `appearance`)
- Modify: `docs/plans/2026-09-08-taskindex-v2.md` (после таблицы §5)
- Modify: `issues.md` (шапка, индекс, карточка)
- Modify: `BACKLOG.md` (раздел «За пределами первой версии»)
- Modify: `CLAUDE.md` (карта кода `src/shared`)

**Interfaces:**
- Consumes: всё из задач 1–4; `tests/cli/docs.test.ts` проверяет, что в SKILL.md упомянуты только существующие команды и флаги.
- Produces: карточка TI-086 в статусе «В РАБОТЕ» с абзацем «Закрытие» для владельца.

- [x] Шаг 1. `skills/taskindex/SKILL.md`. В раздел «Правки» после абзаца про `task save --payload` добавить:

```md
Приоритет, метки и проблема: `--priority p1|p2|p3` (по умолчанию `p2`; P1 ставит
владелец словами, порядок карточек остаётся ручным), `--labels otvet,dengi`
(только слаги из `labels` в `taskindex context`, до 8 без повторов; JSON-массив
тоже принимается), `--closes lora-km-of-vacancy` (слаг проблемы из
`/OS/PROBLEMS.md`, `null` снимает). Чтение: `tasks --priority p1`,
`tasks --label otvet`, `tasks --closes SLUG`; `digest` несёт `counts.p1` и
`counts.otvet`. После касания владельца `task sync` пропускает `priority`
(`skipped: locked`), а прямая команда над `priority`, `labels`, `closes` из
`ownerFields` требует `--confirm-owner-fields`.
```

В абзац про оформление после `--skin-id ID)` добавить: `; галочка «Без P3» это поле того же предпочтения: taskindex appearance set --hide-p3 true|false` (внутри тех же бэктиков, что и соседняя команда, чтобы `docs.test` увидел флаг `--hide-p3`).

- [x] Шаг 2. `docs/plans/2026-09-08-taskindex-v2.md`: сразу после таблицы команд §5 добавить строку:

```md
2026-09-13 (TI-086): `task.create`, `task.sync` (`fields`), `task.update`, `task.save` (`fields`) принимают `priority` (`p1|p2|p3`, по умолчанию `p2`), `labels` (до 8 слагов каталога `src/shared/labels.ts`) и `closes` (слаг или `null`); `appearance.update` принимает `hideP3`. Приоритет не сортирует колонку. Спека: `docs/specs/2026-09-12-owner-workflow.md` §4.
```

- [x] Шаг 3. `issues.md`. В шапке после абзаца «**Окружение 2026-09-12 (вечер):** …» добавить абзац:

```md
**Продуктовая работа 2026-09-13:** добавлена [TI-086](#ti-086) (приоритет P1–P3, метки, `closes`, галочка «Без P3»; P2; спека `docs/specs/2026-09-12-owner-workflow.md`). Состав: 86 записей — **78 исправлено, 1 в работе, 4 открыто, 2 отложено, 1 снятая гипотеза**.
```

В индексе после строки `| [TI-085](#ti-085) | P2 | ИСПРАВЛЕНО | Задержки поиска, переключения вида и переноса на большой доске |` добавить:

```md
| [TI-086](#ti-086) | P2 | В РАБОТЕ | Приоритет, метки, `closes` и галочка «Без P3» |
```

Перед `<a id="source-coverage"></a>` добавить карточку:

```md
### TI-086 — Приоритет, метки, `closes` и галочка «Без P3»

**Тип:** Продуктовая работа. **Статус:** В РАБОТЕ. **Приоритет:** P2.

**Источники:** брейншторм владельца 2026-09-12/13, спека [docs/specs/2026-09-12-owner-workflow.md](/Users/dmitriy/code/taskindex/docs/specs/2026-09-12-owner-workflow.md) §4; план [docs/plans/2026-09-13-priority-labels-closes.md](/Users/dmitriy/code/taskindex/docs/plans/2026-09-13-priority-labels-closes.md); ревью Codex спеки 2026-09-13 (ручной порядок вместо сортировки, формат экспорта 5).

**Где:** `src/web/app/api.ts`, `src/web/app/store.ts` (задача 0: ответ вне контракта), `src/shared/labels.ts`, `src/shared/schemas.ts`, `src/shared/domain-schemas.ts`, `src/shared/commands.ts`, `src/shared/queries.ts`, `src/server/schema.ts`, `drizzle/v2/0005_priority_labels_closes.sql`, `src/server/backup.ts`, `src/server/context.ts`, `src/server/digest.ts`, `src/server/routes/reads.ts`, `src/cli/spec.ts`, `src/cli/help.ts`, `src/cli/writes.ts`, `src/web/app/{card,card-menu,shell,workspace-header,workspace-empty,history,selectors,commands,appearance}.ts*`, `src/web/app/editor/editor.tsx`, `src/web/skin/{board,editor}.css`.

**Проблема и последствия.** Живые задачи владельца лежат в `/OS/TASKS.md` с тегами `[ответ] [деньги] [5 мин]`, разделом Someday и связкой `closes` с `PROBLEMS.md`; в модели TaskIndex нет ни приоритета, ни меток, ни ссылки на проблему, поэтому перенести список и смотреть «что горит» на доске нельзя. Без этих полей волны 2–4 спеки (скилл, зеркало `TASKS.md`, импорт) не начинаются.

**Решение владельца (2026-09-12/13).** Три поля задачи: `priority` P1–P3 (по умолчанию P2; Someday это P3), `labels` из фиксированного каталога в коде, `closes` со слагом проблемы; порядок карточек остаётся ручным, приоритет только помечает и фильтрует; галочка «Без P3» хранится на сервере как предпочтение владельца. Предложения агентов и главная с обзором отклонены (BACKLOG).

**Детали и оговорки.** Открытая вкладка старой сборки при первой записи после выпуска теряет конверт из очереди (ревью Codex 2026-09-13, воспроизведено: HTTP 200, запись сохранена, `pending = 0`). Сборка TI-086 чинит это для следующих релизов (`ContractMismatch`: конверт остаётся, записи стоят до перезагрузки); для самого выпуска TI-086 владелец перезагружает открытые вкладки до первой записи. Ручной порядок карточек сохранён, приоритет не сортирует; порядок меток канонизирует сервер (порядок каталога), поэтому один и тот же набор в другом порядке не даёт события.

**Критерий закрытия.** `npm run check` и `npm run e2e` зелёные; миграция `0005` проходит на копии `data/dev.db`; `tests/web/api.test.ts` и `tests/web/store.test.ts` (TI-086, ответ вне контракта); `tests/api/priority-labels.test.ts`, `tests/api/migration-compat.test.ts` (describe `0005_priority_labels_closes backfill`), `tests/cli/cli.test.ts` (TI-086), `tests/web/{history,commands,selectors}.test.ts` (TI-086), `tests/e2e/priority.spec.ts` зелёные; сцена спеки §1.1 после волны 2а. Эталон `docs/reference/v2-validation` не переснят: галочка меняет кадр доски, решение владельца отдельно.

**Связанные записи:** [TI-078](#ti-078) (стол Focus без изменений), [TI-027](#ti-027) (защита полей владельца распространена на новые поля).
```

- [x] Шаг 4. `BACKLOG.md`, раздел «За пределами первой версии», добавить пункт:

```md
- Предложения агентов (сущность «предложение», scope `propose`, лента с кнопками принять/отклонить): владелец 2026-09-13 счёл допустимыми, но не нужными, пока автоматы не пишут на доску (спека `docs/specs/2026-09-12-owner-workflow.md` §2–3). Главная с обзором направлений отклонена 2026-09-13; напоминания в TaskIndex и Telegram не решены.
```

- [x] Шаг 5. `CLAUDE.md`, «Карта кода», пункт `src/shared`: после `errors.ts` добавить `, labels.ts (каталоги приоритетов P1–P3 и меток; новая метка это правка каталога и релиз)`.

- [x] Verify (финальный гейт):

```sh
npm run check
npm run e2e
node scripts/gate.mjs
git status --short                  # только ожидаемые файлы; drizzle/v2/meta/0005_snapshot.json и _journal.json сгенерированы
```

Ожидание: всё зелёное; `test-results/gate.json` записан; в `git status` нет `data/`, `docs/reference/`, `dist/`.

- [ ] Commit: не делать самому. Сообщить владельцу одним сообщением: ветка `ti-086`, список файлов, полный вывод `npm run check` и e2e, предложенное сообщение коммита `TI-086: приоритет, метки и closes у задачи, галочка «Без P3»` абзац «Закрытие (2026-09-13)» для карточки (коммит, тесты, что не сделано: эталон скриншотов) и напоминание: в день выпуска перезагрузить открытые вкладки до первой записи. Коммит после слова владельца.

---

## Самопроверка плана против спеки §4

| Требование спеки | Задача |
|---|---|
| Поля `priority`, `labels`, `closes`, значения по умолчанию, лимиты | 1 |
| Каталог `LABELS` в коде, `z.enum`, отдаётся в `/api/context` | 1, 2 |
| `[найм]`, `[код]`, `[сегодня]` не метки | нет кода: каталог их не содержит |
| 4.1 защита полей владельца, `task sync` пропускает `priority` | 1 (`ownerLockedFields`, `entities`), тесты 2 |
| 4.2 поля во всех командах, CLI `--priority`, `--closes`, `--labels` через запятую, история словами | 1, 3, 4 |
| 4.3 фильтры `/api/tasks`, `counts.p1/otvet`, экспорт 5, форматы 1–4 читаются, ручной порядок | 2, 1 |
| 4.4 миграция `0005` без индекса | 2 |
| 4.5 значок, чипы, редактор, меню, галочка «Без P3» на сервере, подпись «скрыто N», не трогает поиск, Focus, архив, `digest`, CLI | 4 |
| 4.6 тесты api, permissions, property, cli, web, e2e | 1–4; e2e-эталон не переснимается по Global Constraints |
| Ревью Codex 2026-09-13: открытые вкладки (P2) | 0 |
| Ревью Codex: актуальность к `main` `0901fd2`, `card-menu.tsx`, `useMemo` (P2) | 4 |
| Ревью Codex: контракт защиты полей (P2) | спека §4.1 исправлена под TI-027, тест примера в 2 |
| Ревью Codex: пустой экран при скрытых P3 (P2) | 4, шаг 8а и e2e |
| Ревью Codex: перенос чипов и длинный `closes` (P2) | 4, шаг 9 и ручная проверка |
| Ревью Codex: ложная правка при порядке меток (P3) | 1 (`canonicalLabels`), тест в 2 |
| Ревью Codex: тест предметных полей оформления (P3) | 1, шаг 11 |
| §11 открытые вопросы (состав меток, напоминания) | не в объёме; каталог правится одной таблицей в `labels.ts` |

Проверка типов между задачами: `Priority`/`LabelId` объявлены в Task 1 и используются в Task 2 (`PRIORITY_IDS` в схеме Drizzle), Task 4 (`Priority` в редакторе); `selectVisibleTasks(data, location, today, hideP3)` объявлена в Task 4 шаг 5 и вызывается в шаге 8 той же сигнатурой; `chooseHideP3` объявлена в шаге 6, вызывается в шаге 8; `hiddenP3Count` объявлена в шаге 5, вызывается в шаге 8 и в тесте шага 10; `exportSchemaV4` объявлена в Task 1 шаг 4 и импортирована в Task 2 шаг 3; `labelSchema`/`prioritySchema` объявлены в Task 1 шаг 3 и импортированы в Task 2 шаг 6.

2026-09-17, примечание (расходится с кодом): по решению владельца чип приоритета не рисуется в колонке своего приоритета (только «В работе», «Готово» и экраны без колонок), а чип «закрывает …» убран с карточки: слаг остаётся в редакторе.
