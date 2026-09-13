import {
  lazy,
  Suspense,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ignoreRejection } from '@shared/ignore-rejection';
import { RefreshCw } from 'lucide-react';
import { Menu } from '@base-ui/react/menu';
import { SidebarProvider, SidebarInset } from '../ui/sidebar';
import { Button } from '../ui/button';
import { Empty, EmptyTitle, EmptyDescription } from '../ui/empty';
import { Skeleton } from '../ui/skeleton';
import { Toaster, toast } from '../ui/toast';
import { AREAS, type Project, type Status, type Task } from '@shared/model';
import { focusGroups } from '@shared/queries';
import { workspaceStore } from './store';
import { startSync } from './sync';
import { NavigationProvider, useNavigation } from './navigation';
import { useWorkspaceFrame } from './use-workspace';
import { useWorkspaceCommands } from './use-workspace-commands';
import { useKeyboardShortcuts } from './use-keyboard-shortcuts';
import {
  hiddenP3Count,
  selectContextualTasks,
  selectVisibleTasks,
} from './selectors';
import { chooseHideP3 } from './appearance';
import { taskCount } from './labels';
import type { NewTask } from './commands';
import { WorkspaceSidebar } from './sidebar';
import { TaskCard, TaskCardContent } from './card';
import { TaskCardMenu } from './card-menu';
import { Board, DragBoard } from './board';
import { WorkspaceOverview } from './overview';
import { Desk } from './desk/desk';
import { QuickCreate, ProjectDialog } from './dialogs';
import { PendingNotice } from './pending-notice';
import { WorkspaceHeader } from './workspace-header';
import { WorkspaceEmpty } from './workspace-empty';
import { pendingTaskLabel } from './editor-base';
// План 07, шаг 19: экран активности и карточка задачи грузятся отдельными
// чанками. На доску они не нужны: владелец открывает их по действию.
const Activity = lazy(() =>
  import('./activity').then((m) => ({ default: m.Activity })),
);
const TaskEditor = lazy(() =>
  import('./editor/editor').then((m) => ({ default: m.TaskEditor })),
);
const changeHideP3 = (value: boolean) =>
  void chooseHideP3(value).catch((error: Error) =>
    toast.add({ title: error.message, type: 'error' }),
  );
export function Workspace() {
  return (
    <Toaster>
      <SidebarProvider
        style={{ '--sidebar-width': '14.5rem' } as React.CSSProperties}
        className="workspace-shell"
      >
        <NavigationProvider>
          <WorkspaceBody />
        </NavigationProvider>
      </SidebarProvider>
    </Toaster>
  );
}
// `key={state.generation}` у доски, редактора и диалогов — это сброс локального
// состояния форм при смене поколения базы: другая база значит другие записи,
// и незавершённый ввод не должен переехать на них молча.
function WorkspaceBody() {
  const state = useWorkspaceFrame(),
    { data, loading, error, today, pending } = state;
  const { location, update, navigate, openTask, closeTask, bodyRef } =
    useNavigation();
  const commands = useWorkspaceCommands();
  const {
    area,
    project: projectId,
    view,
    q: query,
    focus: focusView,
    archive,
    today: todayOnly,
    activity,
    archiveSearch,
  } = location;
  const [create, setCreate] = useState<Status | null>(null),
    [projectDialog, setProjectDialog] = useState<Project | 'new' | null>(null),
    [mobileSearch, setMobileSearch] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const [cardMenu] = useState(() => Menu.createHandle<string>());
  useEffect(() => startSync(), []);
  const projects = data.projects.filter((p) => p.area === area),
    project = projects.find((p) => p.id === projectId);
  const selected = data.tasks.find((task) => task.id === location.task) ?? null;
  // TI-007: the editor is based on the confirmed record, never on an optimistic preview.
  const confirmedSelected =
    selected &&
    (state.confirmed.tasks.find((task) => task.id === selected.id) ?? selected);
  const deferredQuery = useDeferredValue(query);
  const searchPending = query !== deferredQuery;
  const searching = deferredQuery.trim().length > 0,
    globalView = searching || focusView || activity;
  const hideP3 = data.appearance[0]?.hideP3 ?? false;
  const filteringP3 = hideP3 && !archive && !globalView;
  // Opening a task or changing board/list presentation does not change the
  // selected records. Preserve the list so DnD consumers stay idle (TI-085).
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
  const tasks = useMemo(
    () => selectVisibleTasks(data, selection, today),
    [data, selection, today],
  );
  const contextual = selectContextualTasks(data, location);
  const hiddenP3 = useMemo(
    () => hiddenP3Count(data, selection, today),
    [data, selection, today],
  );
  const showAllTasks = () => {
    update({ today: false }, true);
    // A P3 task outside today's filter does not contribute to hiddenP3.
    // Clear the active preference itself, not just the counted hidden tasks.
    if (filteringP3) changeHideP3(false);
  };
  const pendingTask = (id: string) =>
    pendingTaskLabel(pending, id) !== undefined;
  // TI-006: without durable browser storage no command may be sent.
  const disabled =
    loading || !!error || !state.storageAvailable || state.incompatible;
  const openSearch = () => {
    setMobileSearch(true);
    requestAnimationFrame(() => searchRef.current?.focus());
  };
  useKeyboardShortcuts({
    blocked: !!selected || !!create || !!projectDialog,
    onSearch: openSearch,
    onCreate: disabled ? null : () => setCreate('todo'),
  });
  async function newTask(task: NewTask, operationId: string) {
    const { task: next } = await commands.createTask(
      focusView ? { ...task, focus: true } : task,
      operationId,
    );
    update({ q: '', today: false, archive: false }, true);
    toast.add({
      title: 'Задача добавлена',
      type: 'success',
      actionProps: { children: 'Открыть', onClick: () => openTask(next.id) },
    });
    return next;
  }
  const renderCard = (task: Task, overlay = false) => {
    const Card = overlay ? TaskCardContent : TaskCard;
    return (
      <Card
        key={task.id}
        task={task}
        project={data.projects.find((p) => p.id === task.projectId)}
        today={today}
        showContext={globalView}
        showProject={globalView || projectId !== task.projectId}
        menu={cardMenu}
        pending={pendingTask(task.id)}
        disabled={archive || globalView || pendingTask(task.id)}
      />
    );
  };
  const renderTask = (task: Task) => renderCard(task);
  return (
    <>
      <WorkspaceSidebar
        projects={projects}
        tasks={data.tasks}
        disabled={disabled}
        onCreateProject={() => setProjectDialog('new')}
      />
      <SidebarInset className="workspace-main">
        <WorkspaceHeader
          visible={tasks.length}
          project={project}
          disabled={disabled}
          searchRef={searchRef}
          mobileSearch={mobileSearch}
          searchPending={searchPending}
          hideP3={hideP3}
          onHideP3={changeHideP3}
          onMobileSearch={setMobileSearch}
          onCreate={() => setCreate('todo')}
          onEditProject={setProjectDialog}
        />
        <div
          className="board-body"
          ref={bodyRef}
          aria-busy={searchPending}
          inert={searchPending || undefined}
        >
          <PendingNotice />
          {todayOnly && !globalView && (
            <p className="filter-note">
              Срок или дата проверки — сегодня и раньше
            </p>
          )}
          {filteringP3 && (
            <p className="filter-note" data-hidden-p3={hiddenP3}>
              Без задач P3{hiddenP3 ? `: скрыто ${taskCount(hiddenP3)}` : ''}
            </p>
          )}
          {error ? (
            <Empty className="main-empty">
              <EmptyTitle>Не удалось открыть доску</EmptyTitle>
              <EmptyDescription>{error}</EmptyDescription>
              <Button
                onClick={() =>
                  ignoreRejection(
                    workspaceStore.refresh(),
                    'повтор загрузки: ошибка снова попадёт в баннер',
                  )
                }
              >
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
            // Запасной вид повторяет подпись самого экрана: пока грузится
            // чанк, владелец (и тест) видят то же «Загружаем активность…».
            <Suspense fallback={<output>Загружаем активность…</output>}>
              <Activity
                actor={location.actor}
                onActor={(next) => update({ actor: next })}
              />
            </Suspense>
          ) : focusView && !searching ? (
            // TI-078: экран Focus это стол, а не сетка групп. Стартовый экран
            // не меняется, сетка осталась в поиске и в дайджесте.
            <Desk />
          ) : (
            <DragBoard
              tasks={tasks}
              disabled={archive || globalView}
              move={commands.move}
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
                      : focusGroups(data.tasks, today)
                  }
                  renderTask={renderTask}
                  onBrowse={() => navigate(area)}
                />
              ) : tasks.length === 0 &&
                (todayOnly || filteringP3 || archive || !contextual.length) ? (
                <WorkspaceEmpty
                  onCreate={() => setCreate('todo')}
                  hiddenP3={hiddenP3}
                  onShowP3={() => changeHideP3(false)}
                  onShowAll={showAllTasks}
                />
              ) : (
                <Board
                  key={state.generation}
                  tasks={tasks}
                  view={view}
                  area={area}
                  projectId={projectId}
                  mode={archive ? 'archive' : 'board'}
                  filtered={todayOnly || filteringP3}
                  renderTask={renderTask}
                  onCreate={newTask}
                />
              )}
            </DragBoard>
          )}
        </div>
      </SidebarInset>
      <TaskCardMenu
        handle={cardMenu}
        tasks={data.tasks}
        isPending={pendingTask}
      />
      {selected && (
        <Suspense fallback={null}>
          <TaskEditor
            key={`${state.generation}/${selected.id}`}
            task={selected}
            base={confirmedSelected ?? selected}
            pendingLabel={pendingTaskLabel(pending, selected.id)}
            projects={data.projects}
            onClose={closeTask}
          />
        </Suspense>
      )}
      {location.task && !selected && !loading && !error && (
        <div className="missing-task" role="alert">
          Задача недоступна. <Button onClick={closeTask}>Закрыть</Button>
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
          onSave={async (next, operationId) => {
            const saved = await commands.saveProject(next, operationId);
            navigate(area, saved.id);
            toast.add({
              title: next.revision
                ? 'Название сохранено'
                : 'Направление добавлено',
              type: 'success',
            });
            return saved;
          }}
        />
      )}
    </>
  );
}
