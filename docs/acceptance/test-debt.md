# Тестовый долг и единый список регрессий

Один список на весь реестр: находка ревью → карточка `TI-NNN` → файл теста,
который её держит. Составлен по плану 10 (шаг 17 «Приёмка и долг» и
дополнительный шаг 23) и сверен с деревом `tests/**` 2026-09-11: в таблице
только тесты, которые в нём действительно есть.

Строка закрывается, когда тест смержен. Пустая клетка «файл теста» — открытый
долг, а не «проверено вручную».

## Регрессии по объединённым находкам

| ID Astra/Fable | TI | Файл теста | План |
|---|---|---|---|
| FB:B-01 | [TI-027](../../issues.md#ti-027) | `tests/api/permissions.test.ts` › «lets no agent undo an operation with owner events, by operationId or by seq» | 02 |
| FB:B-02 | [TI-027](../../issues.md#ti-027) | `tests/api/permissions.test.ts` › «rejects a whole batch when one command sets focus», «always skips focus for agents (reason owner)» | 02 |
| FB:B-03 | [TI-012](../../issues.md#ti-012) | `tests/property/write-state.test.ts`, `tests/property/projection.test.ts`, замеры `scripts/bench-journal.ts` → `bench-baseline.json` | 01 |
| FB:B-05 | [TI-039](../../issues.md#ti-039), [TI-035](../../issues.md#ti-035) | `tests/cli/state.test.ts` › «separates servers, quarantines unreadable envelopes and never resends a file saved by another actor»; `tests/cli/outbox-isolation.test.ts` | 03 |
| Astra B-01 / FI:A1 | [TI-001](../../issues.md#ti-001), [TI-036](../../issues.md#ti-036) | `tests/api/auth.test.ts` › «stops an open SSE stream after its key is revoked elsewhere», «closes idle and active streams when the agent is disabled», «checks agent keys without writing to the database» | 05 |
| Astra B-02 | [TI-003](../../issues.md#ti-003) | `tests/web/store.test.ts` › «TI-003 a snapshot that arrives after a newer live event never rolls the state back» (probe `refresh-rolls-back-live-event`), «TI-003 a refresh answered by the previous generation is discarded» | 07 |
| Astra B-08 | [TI-006](../../issues.md#ti-006) | `tests/web/store.test.ts` › «refuses to send a command when browser storage is unavailable (TI-006)» | 07 |
| Astra A-01 | [TI-007](../../issues.md#ti-007) | `tests/web/editor-base.test.ts`; `tests/web/store.test.ts` › «sends only dirty editor fields in one atomic save» | 07 |
| Astra B-04 | [TI-008](../../issues.md#ti-008) | `tests/api/operations-journal.test.ts` › «reads success, no-op, rejection, repeat and success completely with after= and limit=1; since=0 and no since mean everything»; `tests/cli/cursor.test.ts` | 04, 01 |
| Astra B-05 | [TI-009](../../issues.md#ti-009) | `tests/api/operations-journal.test.ts` › «invariant-rejection-is-not-idempotently-recorded», «a step id already used in the task takes the same stored path», «a violation in the second command of a batch reports commandIndex 1» | 04 |
| Astra B-06, B-07 | [TI-010](../../issues.md#ti-010), [TI-011](../../issues.md#ti-011) | `tests/api/contract.test.ts` › «none, all, by-origin and lookup are refused as new identifiers», «the origin lookup lives under /api/tasks/lookup/by-origin and does not shadow task ids», «import refuses reserved identifiers before replaying history» | 04 |
| — (TI-004) | [TI-004](../../issues.md#ti-004) | `tests/cli/acknowledgement.test.ts` › «resume: an unrecognised stored-operation body keeps the envelope and does not resend», «get: a stored result of a different operation or generation leaves the envelope alone»; `tests/cli/canonical-envelope.test.ts` | 03 |
| FA:V1, FB:B-09 | [TI-037](../../issues.md#ti-037) | `tests/cli/reads.test.ts` › «restarts from the first page after 409 conflict», «gives up after three restarts», «warns when the list changed between the first and the last page», «forwards a keyset cursor of the server (v: 2) verbatim»; `tests/api/pagination.test.ts` | 01, 03 |
| FB:B-04 | [TI-038](../../issues.md#ti-038) | `tests/web/store.test.ts` › «does not replay outbox envelopes across database generations and lets the owner dismiss them (TI-038)»; `tests/web/pending.test.ts` | 07 |
| FB:B-06 | [TI-040](../../issues.md#ti-040) | `tests/api/contract.test.ts` › «project.create with an existing name returns the existing project as current», «renaming a project into a taken name points at the other project» | 04 |
| FB:B-07 | [TI-041](../../issues.md#ti-041) | `tests/web/drafts.test.ts` | 07 |
| FB:B-08 | [TI-042](../../issues.md#ti-042) | `tests/web/url.test.ts` | 07 |
| FA:V5 | [TI-043](../../issues.md#ti-043) | `tests/web/sync.test.ts` | 07 |
| Astra A-03, FA:Ж11 | [TI-014](../../issues.md#ti-014) | `tests/api/migration-compat.test.ts` (фикстура `tests/fixtures/export-schema-2.json`) | 09 |
| Astra Q-03 | [TI-021](../../issues.md#ti-021) | `tests/property/undo.test.ts` | 10 |
| Astra Q-04 | [TI-022](../../issues.md#ti-022) | `tests/cli/state.test.ts` › «TI-022: every persisted envelope passes savedOperationSchema before use»; `tests/web/drafts.test.ts` | 10 |
| Astra Q-01, A-05 | [TI-019](../../issues.md#ti-019) | `tests/unit/shared.test.ts` | 04, 10 |
| FQ:§9 | [TI-058](../../issues.md#ti-058) | `tests/e2e/artifacts.spec.ts` | 10 |
| FS:Q2 | [TI-069](../../issues.md#ti-069) | `tests/e2e/static.spec.ts`, `tests/e2e/static-server.ts` | 10 |
| FI:A4, A5 | [TI-044](../../issues.md#ti-044) | `tests/cli/help.test.ts`, `tests/cli/docs.test.ts` | 03, 12 |
| FI:A3, A8, B9 | [TI-046](../../issues.md#ti-046) | `tests/cli/cli.test.ts` › «TI-046…»; `tests/api/contract.test.ts` | 03, 04 |
| FI:A6 | [TI-047](../../issues.md#ti-047) | `tests/cli/cursor.test.ts` | 03 |
| FI:A7, A14 | [TI-048](../../issues.md#ti-048) | `tests/cli/cursor.test.ts` › «inbox: the owner comments addressed to this agent (TI-048)» | 03 |
| FI:A10 | [TI-050](../../issues.md#ti-050) | `tests/cli/process.test.ts` | 03 |
| FI:A11 | [TI-051](../../issues.md#ti-051) | `tests/cli/follow.test.ts` | 03 |
| FQ:R7 | [TI-060](../../issues.md#ti-060) | `tests/unit/limits.test.ts` | 04 |
| FQ:§3 | [TI-061](../../issues.md#ti-061) | `tests/unit/canonical-json.test.ts`, `tests/cli/canonical-envelope.test.ts` | 04 |
| FI:B10 | [TI-072](../../issues.md#ti-072) | `tests/deploy/deploy-plan.test.ts` | 11 |
| FA:V9 | [TI-074](../../issues.md#ti-074) | `tests/web/store.test.ts` › «TI-074 previews are attributed to the actor from /api/me» | 07 |
| — (TI-076) | [TI-076](../../issues.md#ti-076) | `tests/web/history.test.ts`, `tests/web/url.test.ts`, `tests/e2e/web-client.spec.ts` | 07 |
| FS:F1, FQ:§6 | [TI-025](../../issues.md#ti-025) | `tests/e2e/dark.spec.ts`, `tests/web/use-mobile.test.ts`, `tests/unit/shared.test.ts`, гейт `npm run check:skin` | 08 |
| Astra 26 | [TI-026](../../issues.md#ti-026) | `tests/api/appearance.test.ts`, `tests/cli/cli.test.ts` › «оформление владельца в CLI (TI-026)» | 08 |
| Astra 30 | [TI-030](../../issues.md#ti-030) | `tests/web/strings.test.ts`, `tests/web/auth-errors.test.ts`, `tests/e2e/localization.spec.ts` | 07 |
| Astra 32 | [TI-032](../../issues.md#ti-032) | `tests/web/history.test.ts` | 07 |
| Astra 31 | [TI-031](../../issues.md#ti-031) | `tests/web/labels.test.ts` › «TI-031 taskCount declines «задача» by the Russian rules» (0, 1, 2, 4, 5, 11, 12, 14, 21, 22, 25) | 07 |

Открытые строки (теста нет):

| ID Astra/Fable | TI | Чего не хватает | План |
|---|---|---|---|
| Astra S-05 | [TI-018](../../issues.md#ti-018) | проекта `webkit` в `tests/e2e/playwright.config.ts` нет; спека писалась и откачена (см. ниже) | 10, шаг 21 |
| Astra 34 | [TI-034](../../issues.md#ti-034) | физическая приёмка: [phone.md](phone.md), отчёта ещё нет | — |
| Astra 23 | [TI-023](../../issues.md#ti-023) | общий жизненный цикл намерения в формах не выделен, тестов нет | 07 |
| Astra 24 | [TI-024](../../issues.md#ti-024) | замер бандла не автоматизирован, порога нет | 09 |
| FQ:§3, §9 | [TI-070](../../issues.md#ti-070) | остаток перестройки e2e: проекты `setup` и `visual`, чистая база на прогон | 10, шаг 15 |
| Astra 63 | [TI-063](../../issues.md#ti-063) | комментарии всё ещё грузятся двумя путями | 07 |

## Передано Astra 2026-09-11

Решение владельца: UI/UX-работа и её тесты уходят другому исполнителю. Здесь
только список, чтобы «тестовый долг закрыт» оставался проверяемым.

- **TI-018 — WebKit-проект e2e.** Спека была написана и откачена: падала на
  сцене «черновик после перезагрузки» — редактор сворачивает секцию заметки,
  и проверка не находила поле (отчёт области C, раунд 3). Нужен либо стабильный
  селектор развёрнутой секции, либо явное разворачивание в сцене. Физический
  чек-лист телефона уже лежит в [phone.md](phone.md).
- **TI-023** — общий жизненный цикл намерения в формах (`astra-23`).
- **TI-063** — дублирование комментариев между store и отдельной загрузкой.
- **TI-024** — замер бандла и порог загрузки интерфейса (`astra-24`).
- **TI-078 (UI)** — вид «Стол» на экране Focus; серверная часть и CLI сделаны,
  осталась раскладка (план 13).
- **TI-029 (UI)** — счётчик Focus в интерфейсе.
- **Скин «Фокус» (CSS)** — палитра каталога есть в `src/shared/appearance.ts`,
  правил в `src/web/skin/**` под неё ещё нет.
- **План 08, фаза B (шаг 11)** — сведение оттенков, WebKit-скриншоты тёмной темы.
- **План 07, шаги 9–21** — перестройка веб-клиента.
- **План 10, шаг 15** — проекты `setup` и `visual` в Playwright, чистая база на
  прогон (остаток TI-070).
