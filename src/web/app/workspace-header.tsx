// oxlint-disable jsx-a11y/prefer-tag-over-role -- план 07, §3.9: `<output>` это
// результат вычисления и по HTML принимает только фразовое содержимое, а здесь
// внутри живут абзацы, `pre` и кнопки. Роль `status` даёт ту же живую область
// без нарушения модели содержимого.
import { type RefObject } from 'react';
import {
  ChevronRight,
  List,
  LoaderCircle,
  PanelsTopLeft,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Tag,
  X,
} from 'lucide-react';
import { ignoreRejection } from '@shared/ignore-rejection';
import { AREAS, type Project } from '@shared/model';
import { SidebarOpenButton } from './sidebar-toggle';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../ui/dropdown-menu';
import { workspaceStore } from './store';
import { useWorkspace } from './use-workspace';
import { useNavigation } from './navigation';
import { taskCount } from './labels';
// TI-059 (план 07, шаг 12): шапка доски. Из `shell.tsx` переехала как есть,
// поменялся только заголовок: вместо пятиуровневого тернария таблица «условие →
// название», в которой видно приоритет экранов.
export function WorkspaceHeader({
  visible,
  project,
  disabled,
  searchRef,
  mobileSearch,
  searchPending,
  hideP3,
  onHideP3,
  showDone,
  doneCount,
  onMobileSearch,
  onCreate,
  onEditProject,
  onManageLabels,
}: {
  /** Сколько карточек показывает текущий экран. */
  visible: number;
  project?: Project;
  disabled: boolean;
  searchRef: RefObject<HTMLInputElement | null>;
  mobileSearch: boolean;
  searchPending: boolean;
  hideP3: boolean;
  onHideP3: (value: boolean) => void;
  /** Колонка «Готово» видна; `doneCount` — сколько готовых на этом экране. */
  showDone: boolean;
  doneCount: number;
  onMobileSearch: (open: boolean) => void;
  onCreate: () => void;
  onEditProject: (project: Project) => void;
  onManageLabels: () => void;
}) {
  const state = useWorkspace(),
    { loading, pending } = state;
  const { location, update, navigate } = useNavigation();
  const {
    area,
    project: projectId,
    view,
    q: query,
    focus: focusView,
    archive,
    today: todayOnly,
    archiveSearch: searchArchive,
    activity,
  } = location;
  const current = AREAS.find((a) => a.id === area)!;
  const searching = query.trim().length > 0,
    globalView = searching || focusView || activity;
  const heading =
    (
      [
        [searching, 'Поиск'],
        [activity, 'Активность'],
        [focusView, 'Фокус'],
        [archive, 'Архив'],
      ] as const
    ).find(([on]) => on)?.[1] ??
    project?.name ??
    (projectId === 'none' ? 'Без направления' : current.name);
  const openSearch = () => {
    onMobileSearch(true);
    requestAnimationFrame(() => searchRef.current?.focus());
  };
  return (
    <header className="board-heading">
      <div className="board-heading-row">
        <div className="board-title">
          <SidebarOpenButton />
          <div className="board-name">
            {!globalView && (project || archive || projectId === 'none') && (
              <button
                type="button"
                className="area-crumb"
                onClick={() => navigate(area)}
              >
                {current.name}
                <ChevronRight size={15} />
              </button>
            )}
            <h1>{heading}</h1>
          </div>
        </div>
        <div className="heading-actions">
          <div className={'search-box ' + (mobileSearch ? 'search-open' : '')}>
            <button
              type="button"
              className="search-icon-button"
              aria-label="Открыть поиск"
              onClick={openSearch}
            >
              <Search size={17} />
            </button>
            <input
              className="search-field"
              ref={searchRef}
              placeholder="Найти во всех областях…"
              aria-label="Найти во всех областях"
              value={query}
              onChange={(e) => update({ q: e.target.value }, true)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  update({ q: '' }, true);
                  onMobileSearch(false);
                  searchRef.current?.blur();
                }
              }}
            />
            {query ? (
              <button
                type="button"
                className="search-icon-button"
                onClick={() => update({ q: '' }, true)}
                aria-label="Очистить поиск"
              >
                <X size={15} />
              </button>
            ) : (
              <kbd>⌘ K</kbd>
            )}
          </div>
          <Button
            className="primary-add"
            aria-label="Добавить задачу"
            title="Добавить задачу · N"
            disabled={disabled}
            onClick={onCreate}
          >
            <Plus />
            <span>Задача</span>
          </Button>
        </div>
      </div>
      <div className="toolbar">
        {globalView ? (
          <p className="overview-scope" role="status">
            {searchPending
              ? 'Ищем…'
              : activity && !searching
                ? 'Изменения пространства'
                : `Все области · ${taskCount(visible)}${searching && searchArchive ? ' в архиве' : ''}`}
          </p>
        ) : (
          <Tabs
            value={view}
            onValueChange={(v) =>
              update({ view: v === 'list' ? 'list' : 'board' })
            }
          >
            <TabsList className="view-tabs" aria-label="Вид задач">
              <TabsTrigger value="board">
                <PanelsTopLeft />
                Доска
              </TabsTrigger>
              <TabsTrigger value="list">
                <List />
                Список
              </TabsTrigger>
            </TabsList>
            <TabsContent value="board" className="sr-only">
              Задачи по колонкам
            </TabsContent>
            <TabsContent value="list" className="sr-only">
              Задачи списком
            </TabsContent>
          </Tabs>
        )}
        <div className="toolbar-actions">
          <span
            className="sync-status"
            aria-live="polite"
            data-connection={
              state.connected
                ? 'online'
                : state.connectionFailed
                  ? 'offline'
                  : 'connecting'
            }
          >
            {state.revoked ? (
              <>
                Доступ отозван.{' '}
                <button type="button" onClick={() => window.location.reload()}>
                  Войти заново
                </button>
              </>
            ) : pending.some((p) => p.status === 'sending') ? (
              <>
                <LoaderCircle size={13} className="animate-spin" />
                Сохраняем…
              </>
            ) : state.connectionFailed && !loading ? (
              'Нет соединения'
            ) : null}
          </span>
          {!globalView && (
            <label
              htmlFor="today-only"
              className={'today-toggle ' + (todayOnly ? 'active' : '')}
            >
              <Checkbox
                id="today-only"
                checked={todayOnly}
                onCheckedChange={(v) => update({ today: !!v }, true)}
              />
              <span>На сегодня</span>
            </label>
          )}
          {!globalView && !archive && (
            <label
              htmlFor="hide-p3"
              className={'today-toggle ' + (hideP3 ? 'active' : '')}
            >
              <Checkbox
                id="hide-p3"
                checked={hideP3}
                disabled={disabled}
                onCheckedChange={onHideP3}
              />
              <span>Без P3</span>
            </label>
          )}
          {!globalView && !archive && (
            <label
              htmlFor="show-done"
              className={'today-toggle ' + (showDone ? 'active' : '')}
            >
              <Checkbox
                id="show-done"
                checked={showDone}
                onCheckedChange={(v) => update({ done: !!v }, true)}
              />
              <span>Готово</span>{' '}
              <span className="toggle-count">{doneCount}</span>
            </label>
          )}
          {searching && (
            <label htmlFor="search-archive" className="today-toggle">
              <Checkbox
                id="search-archive"
                checked={searchArchive}
                onCheckedChange={(v) => update({ archiveSearch: !!v }, true)}
              />
              <span>Искать в архиве</span>
            </label>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Настройки доски"
                />
              }
            >
              <SlidersHorizontal size={17} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {project && !archive && !globalView && (
                <DropdownMenuItem onClick={() => onEditProject(project)}>
                  <Pencil />
                  Переименовать проект
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={onManageLabels}>
                <Tag />
                Метки
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={loading}
                onClick={() =>
                  ignoreRejection(
                    workspaceStore.refresh(),
                    'повтор загрузки: ошибка снова попадёт в баннер',
                  )
                }
              >
                <RefreshCw />
                Обновить данные
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}
