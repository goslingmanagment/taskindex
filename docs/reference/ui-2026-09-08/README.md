# Визуальный эталон TaskIndex · 2026-09-08

19 снимков существующего интерфейса для переноса в v2. Источник — `main`
на ревизии `4b780e42292e8702eee0f906acb77d5aa34ab7c1`; UI-файлы рабочего
worktree на момент съёмки совпадали с этой ревизией. Эксперименты
`public/visions/` здесь не используются.

| Состояние                       | Desktop, 1440 × 1000              | Mobile viewport, 390 × 844       |
| ------------------------------- | --------------------------------- | -------------------------------- |
| Доска агентства                 | [PNG](desktop-board.png)          | [PNG](mobile-board.png)          |
| Список по статусам              | [PNG](desktop-list.png)           | [PNG](mobile-list.png)           |
| Фокус: три группы               | [PNG](desktop-focus.png)          | [PNG](mobile-focus.png)          |
| Глобальный поиск «сценарий»     | [PNG](desktop-search.png)         | [PNG](mobile-search.png)         |
| Архив в виде списка             | [PNG](desktop-archive.png)        | [PNG](mobile-archive.png)        |
| Редактор с заметкой и чеклистом | [PNG](desktop-editor.png)         | [PNG](mobile-editor.png)         |
| Редактор с раскрытым сроком     | [PNG](desktop-editor-date.png)    | —                                |
| Создание задачи с черновиком    | [PNG](desktop-quick-create.png)   | [PNG](mobile-quick-create.png)   |
| Создание направления            | [PNG](desktop-project-dialog.png) | [PNG](mobile-project-dialog.png) |
| Меню действий карточки          | [PNG](desktop-card-menu.png)      | —                                |
| Мобильная навигация             | —                                 | [PNG](mobile-navigation.png)     |

## Условия съёмки

- Существующие React-компоненты и CSS скопированы без изменений в отдельный
  Vite harness. Использованы исходные `components/`, `hooks/`, `lib/` и
  `app/globals.css`; старые vinext, Sites, Cloudflare и D1 не запускались.
- Съёмка: Chromium `152.0.7977.76`, Playwright CLI `0.1.19` с Playwright
  `1.63.0-alpha-2026-08-31`, macOS, DPR 1, светлая тема, язык браузера en-US,
  часовой пояс Europe/Moscow. Фактический Node — `v26.7.0`, Vite `8.2.2`.
  Путь с именем `node@24` в этой среде указывал на Node 26.
- Фиксированное время `2026-09-08T09:00:00.000Z` (12:00 Москвы).
  `makeSeed('2026-09-07')`: 10 направлений/проектов и 19 исходных задач.
  Для покрытия всех групп Focus у `a1` установлен `focus: true`.
  Дополнительно создана одна архивная копия `a9` с id `reference-archive`
  и названием «Архив: согласовать прошлую неделю». Всего 20 задач.
- GET/POST `/api/workspace` перехватывает `window.fetch` в памяти страницы.
  Фикстура сразу сообщает `initialized: true`; запрос `initialize` запрещён.
  Перезагрузка возвращает исходные фикстуры. Остальные fetch-запросы запрещены.
  Перед desktop/mobile проходом очищены только localStorage/sessionStorage
  локального harness. `.wrangler/state` не читалось и не изменялось.
- Каждый PNG — снимок видимого viewport с завершёнными CSS-анимациями.
  Список и мобильный Focus продолжаются ниже края снимка; на мобильной доске
  следующие колонки доступны горизонтальным скроллом. Это исходное поведение.
- Ошибок приложения при проходе не обнаружено. Единственная ошибка ресурсов
  в консоли — отсутствующий `favicon.ico` у harness (404).

Мобильные PNG подтверждают адаптивную компоновку в Chromium. Это не проверка
на физическом телефоне: мобильная клавиатура, safe area, касания и Safari
проверяются отдельно при реализации. Побайтовое совпадение снимков требует
тех же браузера, системных шрифтов и параметров окружения.

## Граница переноса в v2

Сохраняются геометрия, типографика, цвета, навигация, карточки, формы и
существующие состояния. Надписи «пример», баннер демозадач и `demo` относятся
к старому приложению и фикстурам: по согласованному плану v2 их не переносит
и стартует с пустой базы. Фикстуры лежат только в этом эталоне.

«Новое от агентов», автор на карточке, «Активность», комментарии и история
редактора — согласованные новые дополнения; визуального эталона v1 для них нет.

## Повторить съёмку

Из корня репозитория подготовить исходники именно сохранённой ревизии:

```sh
python3 docs/reference/ui-2026-09-08/harness/prepare.py
```

Скрипт пишет только в `/tmp/taskindex-ui-reference-20260908`. Он сохраняет
старые package.json/package-lock.json в отдельную папку `dependencies`.
Для первого запуска установить зависимости только туда:

```sh
npm ci --prefix /tmp/taskindex-ui-reference-20260908/dependencies
cd /tmp/taskindex-ui-reference-20260908
node node_modules/vite/bin/vite.js --config vite.config.ts --configLoader runner
```

Если исходное дерево зависимостей v1 уже доступно, `prepare.py --deps
/absolute/path/to/v1/node_modules` использует его без установки. Vite cache
всегда хранится внутри `/tmp` harness. Не запускать `npm install` в worktree
с симлинком `node_modules` на другой checkout.

В другом терминале, из папки harness:

```sh
PWCLI=/Users/dmitriy/.codex/skills/playwright/scripts/playwright_cli.sh
"$PWCLI" --session taskindex-reference open http://127.0.0.1:4328 --headed
"$PWCLI" --session taskindex-reference run-code --filename=capture-desktop.js
"$PWCLI" --session taskindex-reference run-code --filename=capture-mobile.js
```

Скрипты снимают PNG в папку harness. Для этой съёмки npm-обёртка оказалась
недоступна при повторном обращении к реестру, поэтому был запущен тот же
уже установленный официальный CLI `0.1.19` напрямую из локального npm cache.
Сценарии не отправляют формы и не сохраняют изменения задач.

[SHA-256 исходных UI-файлов](source-sha256.json) и
[SHA-256 снимков](screenshots-sha256.json) фиксируют содержимое эталона.
