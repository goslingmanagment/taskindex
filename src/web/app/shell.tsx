import { useEffect, useRef, useState } from 'react';
import {
  Plus,
  Search,
  PanelsTopLeft,
  List,
  ChevronRight,
  Archive,
  CircleCheck,
  X,
  SlidersHorizontal,
  Pencil,
  RefreshCw,
  LoaderCircle,
} from 'lucide-react';
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
  useSidebar,
} from '../ui/sidebar';
import { Button } from '../ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs';
import { Checkbox } from '../ui/checkbox';
import { Empty, EmptyTitle, EmptyDescription } from '../ui/empty';
import { Skeleton } from '../ui/skeleton';
import { Toaster, toast } from '../ui/toast';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '../ui/dropdown-menu';
import {
  AREAS,
  type AreaId,
  type Task,
  type Status,
  type Project,
} from '../lib/workspace';
import { useWorkspace, taskSaveCommand } from '../lib/use-workspace';
import { byOrder, focusGroups, searchTasks } from '@shared/queries';
import type { Command, OperationSuccess } from '@shared/model';
import { workspaceStore } from './store';
import { startSync } from './sync';
import { useLocationState } from './url';
import { WorkspaceSidebar } from './sidebar';
import { TaskCard, TaskCardContent } from './card';
import { Board, DragBoard } from './board';
import { WorkspaceOverview } from './overview';
import { QuickCreate, ProjectDialog } from './dialogs';
import { TaskEditor } from './editor';
import { Activity } from './activity';
import { PendingNotice } from './pending-notice';
import { pendingTaskLabel } from './editor-base';
import { taskCount } from './labels';
export function Workspace() {
  return (
    <Toaster>
      <SidebarProvider
        style={{ '--sidebar-width': '14.5rem' } as React.CSSProperties}
        className="workspace-shell"
      >
        <WorkspaceBody />
      </SidebarProvider>
    </Toaster>
  );
}
function notify(result: OperationSuccess, message: string) {
  toast.add({
    title: message,
    type: 'success',
    timeout: 6500,
    ...(result.events.length
      ? {
          actionProps: {
            children: 'Отменить',
            onClick: () => {
              void workspaceStore
                .submit({
                  command: 'undo',
                  payload: { operationId: result.operationId },
                })
                .then(() =>
                  toast.add({ title: 'Действие отменено', type: 'info' }),
                )
                .catch((e) => toast.add({ title: e.message, type: 'error' }));
            },
          },
        }
      : {}),
  });
}
function WorkspaceBody() {
  const state = useWorkspace(),
    { data, loading, error, today, pending, saveTask, saveProject } = state;
  const [location, update] = useLocationState(),
    {
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
  const [create, setCreate] = useState<Status | null>(null),
    [projectDialog, setProjectDialog] = useState<Project | 'new' | null>(null),
    [mobileSearch, setMobileSearch] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null),
    searchRef = useRef<HTMLInputElement>(null);
  const { setOpenMobile } = useSidebar();
  useEffect(() => startSync(), []);
  const current = AREAS.find((a) => a.id === area)!,
    projects = data.projects.filter((p) => p.area === area),
    project = projects.find((p) => p.id === projectId);
  const selected = data.tasks.find((task) => task.id === location.task) ?? null;
  // TI-007: the editor is based on the confirmed record, never on an optimistic preview.
  const confirmedSelected =
    selected &&
    (state.confirmed.tasks.find((task) => task.id === selected.id) ?? selected);
  const searching = query.trim().length > 0,
    globalView = searching || focusView || activity;
  const focus = focusGroups(data.tasks, today);
  const contextual = data.tasks.filter(
    (t) =>
      t.area === area &&
      t.archived === archive &&
      (projectId === 'all' ||
        t.projectId === (projectId === 'none' ? null : projectId)),
  );
  const tasks = searching
    ? searchTasks(data.tasks, data.projects, query, searchArchive)
    : focusView
      ? focus.flatMap((g) => g.tasks)
      : contextual
          .filter(
            (t) =>
              !todayOnly ||
              (t.status !== 'done' &&
                ((t.due && t.due <= today) ||
                  (t.status === 'waiting' &&
                    t.followUp &&
                    t.followUp <= today))),
          )
          .sort(byOrder);
  const pendingTask = (id: string) =>
    pending.some((p) =>
      ('commands' in p.envelope ? p.envelope.commands : [p.envelope]).some(
        (c) =>
          ('id' in c.payload && c.payload.id === id) ||
          ('taskId' in c.payload && c.payload.taskId === id),
      ),
    );
  const closeNavigation = () => {
    setOpenMobile(false);
    bodyRef.current?.scrollTo({ left: 0, top: 0 });
  };
  function navigate(nextArea: AreaId, nextProject = 'all') {
    update({
      area: nextArea,
      project: nextProject,
      q: '',
      focus: false,
      activity: false,
      actor: '',
      archive: false,
      today: false,
      task: '',
    });
    closeNavigation();
  }
  useEffect(() => {
    const keyboard = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement,
        typing =
          target.matches('input,textarea,select') || target.isContentEditable;
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === 'k' &&
        !selected &&
        !create &&
        !projectDialog
      ) {
        e.preventDefault();
        setMobileSearch(true);
        requestAnimationFrame(() => searchRef.current?.focus());
      } else if (
        !typing &&
        !e.metaKey &&
        !e.ctrlKey &&
        e.key.toLowerCase() === 'n' &&
        !selected &&
        !create &&
        !projectDialog &&
        !loading &&
        !error &&
        state.storageAvailable
      ) {
        e.preventDefault();
        setCreate('todo');
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [selected, create, projectDialog, loading, error, state.storageAvailable]);
  useEffect(() => {
    if (
      !loading &&
      projectId !== 'all' &&
      projectId !== 'none' &&
      !projects.some((p) => p.id === projectId)
    )
      update({ project: 'all' }, true);
  }, [loading, projectId, projects, update]);
  async function execute(command: Command, message: string) {
    const result = await workspaceStore.submit(command);
    notify(result, message);
    return result;
  }
  async function move(task: Task, status: Status, before?: Task, after?: Task) {
    return execute(
      {
        command: 'task.move',
        payload: {
          id: task.id,
          baseRevision: task.revision,
          status,
          ...(before ? { before: before.id } : {}),
          ...(after ? { after: after.id } : {}),
        },
      },
      `Задача → ${status === 'todo' ? 'Очередь' : status === 'doing' ? 'В работе' : status === 'waiting' ? 'Жду' : 'Готово'}`,
    );
  }
  async function change(task: Task, patch: Partial<Task>, message: string) {
    let command: Command;
    if ('archived' in patch)
      command = {
        command: patch.archived ? 'task.archive' : 'task.restore',
        payload: { id: task.id, baseRevision: task.revision },
      };
    else if (patch.status)
      command = {
        command: 'task.move',
        payload: {
          id: task.id,
          baseRevision: task.revision,
          status: patch.status,
        },
      };
    else command = taskSaveCommand({ ...task, ...patch }, task);
    return execute(command, message);
  }
  async function first(task: Task) {
    const before = data.tasks
      .filter(
        (t) =>
          t.area === task.area &&
          t.status === 'todo' &&
          !t.archived &&
          t.id !== task.id,
      )
      .sort(byOrder)[0];
    await move(task, 'todo', before);
  }
  async function newTask(task: Task, operationId: string) {
    const { task: next } = await saveTask(
      focusView ? { ...task, focus: true } : task,
      undefined,
      operationId,
    );
    update({ q: '', today: false, archive: false }, true);
    toast.add({
      title: 'Задача добавлена',
      type: 'success',
      actionProps: {
        children: 'Открыть',
        onClick: () => update({ task: next.id }),
      },
    });
    return next;
  }
  const renderCard = (task: Task, overlay = false) => {
    const Card = overlay ? TaskCardContent : TaskCard;
    return (
      <Card
        key={task.id}
        task={task}
        data={data}
        projectId={projectId}
        globalView={globalView}
        pending={pendingTask(task.id)}
        today={today}
        disabled={archive || globalView || pendingTask(task.id)}
        setSelected={(t) => update({ task: t.id })}
        change={change}
        move={move}
        first={first}
      />
    );
  };
  const renderTask = (task: Task) => renderCard(task);
  // TI-006: without durable browser storage no command may be sent.
  const disabled = loading || !!error || !state.storageAvailable;
  return (
    <>
      <WorkspaceSidebar
        location={location}
        projects={projects}
        tasks={data.tasks}
        focusCount={
          data.tasks.filter(
            (task) =>
              task.createdBy.startsWith('agent:') &&
              !task.ownerTouchedAt &&
              !task.archived &&
              task.status !== 'done',
          ).length
        }
        navigate={navigate}
        showFocus={() => {
          update({
            focus: true,
            activity: false,
            actor: '',
            q: '',
            archive: false,
          });
          closeNavigation();
        }}
        showActivity={() => {
          update({ activity: true, focus: false, q: '', archive: false });
          closeNavigation();
        }}
        showArchive={() => {
          update({
            archive: !archive,
            focus: false,
            activity: false,
            actor: '',
            q: '',
            today: false,
            project: 'all',
          });
          closeNavigation();
        }}
        createProject={() => {
          setOpenMobile(false);
          setProjectDialog('new');
        }}
        disabled={disabled}
      />
      <SidebarInset className="workspace-main">
        <header className="board-heading">
          <div className="board-heading-row">
            <div className="board-title">
              <SidebarTrigger aria-label="Открыть навигацию" />
              <div className="board-name">
                {!globalView &&
                  (project || archive || projectId === 'none') && (
                    <button
                      className="area-crumb"
                      onClick={() => navigate(area)}
                    >
                      {current.name}
                      <ChevronRight size={15} />
                    </button>
                  )}
                <h1>
                  {searching
                    ? 'Поиск'
                    : activity
                      ? 'Активность'
                      : focusView
                        ? 'Фокус'
                        : archive
                          ? 'Архив'
                          : project?.name ||
                            (projectId === 'none'
                              ? 'Без направления'
                              : current.name)}
                </h1>
              </div>
            </div>
            <div className="heading-actions">
              <div
                className={'search-box ' + (mobileSearch ? 'search-open' : '')}
              >
                <button
                  aria-label="Открыть поиск"
                  onClick={() => {
                    setMobileSearch(true);
                    requestAnimationFrame(() => searchRef.current?.focus());
                  }}
                >
                  <Search size={17} />
                </button>
                <input
                  ref={searchRef}
                  placeholder="Найти во всех областях…"
                  aria-label="Найти во всех областях"
                  value={query}
                  onChange={(e) => update({ q: e.target.value }, true)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      update({ q: '' }, true);
                      setMobileSearch(false);
                      searchRef.current?.blur();
                    }
                  }}
                />
                {query ? (
                  <button
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
                onClick={() => setCreate('todo')}
              >
                <Plus />
                <span>Задача</span>
              </Button>
            </div>
          </div>
          <div className="toolbar">
            {globalView ? (
              <output className="overview-scope">
                {activity && !searching
                  ? 'Изменения пространства'
                  : `Все области · ${taskCount(tasks.length)}${searching && searchArchive ? ' в архиве' : ''}`}
              </output>
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
                    <button
                      type="button"
                      onClick={() => window.location.reload()}
                    >
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
              {searching && (
                <label htmlFor="search-archive" className="today-toggle">
                  <Checkbox
                    id="search-archive"
                    checked={searchArchive}
                    onCheckedChange={(v) =>
                      update({ archiveSearch: !!v }, true)
                    }
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
                    <DropdownMenuItem onClick={() => setProjectDialog(project)}>
                      <Pencil />
                      Переименовать проект
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    disabled={loading}
                    onClick={() => void state.refresh().catch(() => {})}
                  >
                    <RefreshCw />
                    Обновить данные
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>
        <div className="board-body" ref={bodyRef}>
          <PendingNotice />
          {todayOnly && !globalView && (
            <p className="filter-note">
              Срок или дата проверки — сегодня и раньше
            </p>
          )}
          {error ? (
            <Empty className="main-empty">
              <EmptyTitle>Не удалось открыть доску</EmptyTitle>
              <EmptyDescription>{error}</EmptyDescription>
              <Button onClick={() => void state.refresh().catch(() => {})}>
                <RefreshCw />
                Попробовать ещё раз
              </Button>
            </Empty>
          ) : loading ? (
            <div className="loading-columns">
              {[0, 1, 2, 3].map((i) => (
                <div key={i}>
                  <Skeleton className="h-5 w-28 mb-5" />
                  <Skeleton className="h-32 w-full mb-3" />
                  <Skeleton className="h-28 w-full" />
                </div>
              ))}
            </div>
          ) : activity && !searching ? (
            <Activity
              actor={location.actor}
              onActor={(next) => update({ actor: next })}
            />
          ) : (
            <DragBoard
              tasks={tasks}
              disabled={archive || globalView}
              move={move}
              renderOverlay={(task) => renderCard(task, true)}
            >
              {globalView ? (
                <WorkspaceOverview
                  searching={searching}
                  groups={
                    searching
                      ? AREAS.map((a) => ({
                          id: a.id,
                          title: a.name,
                          tasks: tasks.filter((t) => t.area === a.id),
                        }))
                      : focus
                  }
                  renderTask={renderTask}
                  onBrowse={() => navigate(area)}
                />
              ) : tasks.length === 0 &&
                (todayOnly || archive || !contextual.length) ? (
                <Empty className="main-empty">
                  <span className="empty-icon">
                    {archive ? (
                      <Archive />
                    ) : todayOnly ? (
                      <CircleCheck />
                    ) : (
                      <PanelsTopLeft />
                    )}
                  </span>
                  <EmptyTitle>
                    {archive
                      ? 'Архив пуст'
                      : todayOnly
                        ? 'На сегодня всё спокойно'
                        : 'Здесь пока нет задач'}
                  </EmptyTitle>
                  <EmptyDescription>
                    {archive
                      ? 'Здесь сохраняются задачи, убранные с доски.'
                      : todayOnly
                        ? 'Нет задач со сроком или проверкой на сегодня.'
                        : 'Добавь первое дело. Достаточно названия.'}
                  </EmptyDescription>
                  {todayOnly ? (
                    <Button
                      variant="outline"
                      onClick={() => update({ today: false }, true)}
                    >
                      Показать все задачи
                    </Button>
                  ) : (
                    !archive && (
                      <Button onClick={() => setCreate('todo')}>
                        <Plus />
                        Добавить задачу
                      </Button>
                    )
                  )}
                </Empty>
              ) : (
                <Board
                  key={state.generation}
                  tasks={tasks}
                  view={view}
                  area={area}
                  projectId={projectId}
                  archive={archive}
                  filtered={todayOnly}
                  disabled={archive}
                  renderTask={renderTask}
                  onCreate={newTask}
                />
              )}
            </DragBoard>
          )}
        </div>
      </SidebarInset>
      {selected && (
        <TaskEditor
          key={`${state.generation}/${selected.id}`}
          task={selected}
          base={confirmedSelected ?? selected}
          pendingLabel={pendingTaskLabel(pending, selected.id)}
          projects={data.projects}
          onClose={() => update({ task: '' })}
          onSave={async (task, base, operationId) => {
            const { task: next, result } = await saveTask(
              task,
              base,
              operationId,
            );
            notify(result, 'Изменения сохранены');
            return next;
          }}
          onArchive={async (task) => {
            await change(
              task,
              { archived: !task.archived },
              task.archived ? 'Задача возвращена' : 'Задача в архиве',
            );
          }}
          onFirst={first}
        />
      )}
      {location.task && !selected && !loading && !error && (
        <div className="missing-task" role="alert">
          Задача недоступна.{' '}
          <Button onClick={() => update({ task: '' })}>Закрыть</Button>
        </div>
      )}
      {create && (
        <QuickCreate
          key={`${state.generation}/${area}/${projectId}/${create}`}
          area={area}
          projectId={projectId}
          status={create}
          projects={data.projects}
          onClose={() => setCreate(null)}
          onSave={newTask}
        />
      )}
      {projectDialog && (
        <ProjectDialog
          key={`${state.generation}/${area}`}
          area={area}
          project={projectDialog === 'new' ? undefined : projectDialog}
          onClose={() => setProjectDialog(null)}
          onSave={async (project, operationId) => {
            const next = await saveProject(project, operationId);
            navigate(area, next.id);
            toast.add({
              title: project.revision
                ? 'Название сохранено'
                : 'Направление добавлено',
              type: 'success',
            });
            return next;
          }}
        />
      )}
    </>
  );
}
