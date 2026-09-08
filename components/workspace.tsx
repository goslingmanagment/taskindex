'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BriefcaseBusiness,
  Code2,
  House,
  Plus,
  Search,
  LayoutGrid,
  List,
  ChevronRight,
  LockKeyhole,
  CircleCheck,
  Clock3,
  CalendarDays,
  ListChecks,
  PanelsTopLeft,
  Archive,
  Check,
  X,
  Pencil,
  RefreshCw,
  ArrowUp,
  Undo2,
  LoaderCircle,
  SlidersHorizontal,
  Star,
} from 'lucide-react';
import {
  Sidebar,
  SidebarProvider,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarTrigger,
  SidebarInset,
  useSidebar,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Empty, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Toaster, toast } from '@/components/ui/toast';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  AREAS,
  STATUSES,
  dateLabel,
  localDate,
  type AreaId,
  type Task,
  type Status,
  type Project,
} from '@/lib/workspace';
import { useWorkspace } from '@/lib/use-workspace';
import { TaskEditor } from './task-editor';
import { QuickCreate, ProjectDialog } from './workspace-dialogs';
import { registerWorkspaceTools } from '@/lib/webmcp';
import { byRank, focusGroups, searchTasks } from '@/lib/workspace-queries';
import { WorkspaceOverview } from './workspace-overview';
const icons = {
  agency: BriefcaseBusiness,
  development: Code2,
  personal: House,
};
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : 'Не удалось сохранить.';
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
function WorkspaceBody() {
  const {
    data,
    loading,
    error,
    pending,
    mutationError,
    refresh,
    saveTask,
    saveProject,
  } = useWorkspace();
  const [area, setArea] = useState<AreaId>('agency'),
    [projectId, setProjectId] = useState('all'),
    [view, setView] = useState('board');
  const [query, setQuery] = useState(''),
    [todayOnly, setTodayOnly] = useState(false),
    [archive, setArchive] = useState(false),
    [showDemo, setShowDemo] = useState(true);
  const [focusView, setFocusView] = useState(false);
  const [searchArchive, setSearchArchive] = useState(false);
  const [today, setToday] = useState(() => localDate());
  const [selected, setSelected] = useState<Task | null>(null),
    [create, setCreate] = useState<Status | null>(null),
    [projectDialog, setProjectDialog] = useState<Project | 'new' | null>(null);
  const [inline, setInline] = useState<Status | null>(null),
    [inlineTitle, setInlineTitle] = useState(''),
    [inlineBusy, setInlineBusy] = useState(false),
    [inlineError, setInlineError] = useState('');
  const [dragging, setDragging] = useState(''),
    [dropTarget, setDropTarget] = useState(''),
    [prefsReady, setPrefsReady] = useState(false),
    [mobileSearch, setMobileSearch] = useState(false);
  const inlineRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null),
    bodyRef = useRef<HTMLDivElement>(null),
    inlineId = useRef('');
  const { setOpenMobile } = useSidebar();
  useEffect(() => {
    const timer = window.setInterval(() => setToday(localDate()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    queueMicrotask(() => {
      try {
        const p = JSON.parse(localStorage.getItem('space-preferences') || '{}');
        if (AREAS.some((a) => a.id === p.area)) setArea(p.area);
        if (typeof p.projectId === 'string') setProjectId(p.projectId);
        if (p.view === 'list') setView('list');
        if (p.showDemo === false) setShowDemo(false);
      } catch {}
      setPrefsReady(true);
    });
  }, []);
  useEffect(() => {
    if (prefsReady)
      try {
        localStorage.setItem(
          'space-preferences',
          JSON.stringify({ area, projectId, view, showDemo }),
        );
      } catch {}
  }, [area, projectId, view, showDemo, prefsReady]);
  useEffect(() => {
    if (
      !loading &&
      projectId !== 'all' &&
      projectId !== 'none' &&
      !data.projects.some((p) => p.id === projectId && p.area === area)
    )
      queueMicrotask(() => setProjectId('all'));
  }, [data.projects, loading, projectId, area]);
  useEffect(() => {
    const keyboard = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing =
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
        !error
      ) {
        e.preventDefault();
        setCreate('todo');
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [selected, create, projectDialog, loading, error]);
  const current = AREAS.find((a) => a.id === area)!,
    projects = data.projects.filter((p) => p.area === area),
    project = projects.find((p) => p.id === projectId);
  const baseTasks = data.tasks.filter(
    (t) => t.area === area && t.archived === archive && (showDemo || !t.demo),
  );
  const contextual = baseTasks.filter(
    (t) =>
      projectId === 'all' ||
      t.projectId === (projectId === 'none' ? '' : projectId),
  );
  const searching = query.trim().length > 0;
  const globalView = searching || focusView;
  const focus = focusGroups(data.tasks, today, showDemo);
  const found = searching
    ? searchTasks(data.tasks, data.projects, query, showDemo, searchArchive)
    : [];
  const tasks = searching
    ? found
    : focusView
      ? focus.flatMap((group) => group.tasks)
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
          .sort(byRank);
  function navigate(nextArea: AreaId, nextProject = 'all') {
    if (inlineBusy) return;
    setArea(nextArea);
    setFocusView(false);
    setProjectId(nextProject);
    setQuery('');
    setTodayOnly(false);
    setArchive(false);
    setInline(null);
    setOpenMobile(false);
    bodyRef.current?.scrollTo({ left: 0, top: 0 });
  }
  const change = useCallback(
    async (task: Task, patch: Partial<Task>, message: string) => {
      const previous = task;
      const next = await saveTask({ ...task, ...patch });
      toast.add({
        title: message,
        type: 'success',
        timeout: 6500,
        actionProps: {
          children: 'Отменить',
          onClick: () => {
            void saveTask({ ...previous, revision: next.revision })
              .then(() =>
                toast.add({ title: 'Действие отменено', type: 'info' }),
              )
              .catch((e) => toast.add({ title: errorText(e), type: 'error' }));
          },
        },
      });
      return next;
    },
    [saveTask],
  );
  const move = useCallback(
    async (task: Task, status: Status, before?: Task) => {
      const column = data.tasks
        .filter(
          (t) =>
            t.area === task.area &&
            !t.archived &&
            t.status === status &&
            t.id !== task.id,
        )
        .sort((a, b) => a.rank - b.rank);
      let rank = (column.at(-1)?.rank ?? 0) + 1024;
      if (before) {
        const index = column.findIndex((t) => t.id === before.id);
        rank =
          index > 0
            ? (column[index - 1].rank + before.rank) / 2
            : before.rank - 1024;
      }
      await change(
        task,
        { status, rank },
        `Задача → ${STATUSES.find((s) => s.id === status)!.name}`,
      );
    },
    [data.tasks, change],
  );
  const safely = (promise: Promise<unknown>) =>
    void promise.catch((e) =>
      toast.add({ title: errorText(e), type: 'error', timeout: 9000 }),
    );
  function startInline(status: Status) {
    if (inlineBusy) return;
    if (inline === status) {
      inlineRef.current?.focus();
      return;
    }
    setInline(status);
    setInlineError('');
    try {
      setInlineTitle(
        sessionStorage.getItem(`inline-draft/${area}/${projectId}/${status}`) ||
          '',
      );
    } catch {
      setInlineTitle('');
    }
    inlineId.current = crypto.randomUUID();
    requestAnimationFrame(() => inlineRef.current?.focus());
  }
  async function inlineSubmit(status: Status) {
    if (!inlineTitle.trim() || inlineBusy) return;
    setInlineBusy(true);
    setInlineError('');
    try {
      await saveTask({
        id: inlineId.current,
        area,
        projectId: projectId === 'all' || projectId === 'none' ? '' : projectId,
        title: inlineTitle.trim(),
        status,
        note: '',
        due: '',
        waitingFor: '',
        followUp: '',
        checklist: [],
        rank:
          Math.max(
            0,
            ...data.tasks
              .filter((t) => t.area === area && t.status === status)
              .map((t) => t.rank),
          ) + 1024,
        demo: false,
        archived: false,
        revision: 0,
      });
      setInlineTitle('');
      try {
        sessionStorage.removeItem(
          `inline-draft/${area}/${projectId}/${status}`,
        );
      } catch {}
      inlineId.current = crypto.randomUUID();
      toast.add({ title: 'Задача добавлена', type: 'success' });
    } catch (e) {
      setInlineError(errorText(e));
    } finally {
      setInlineBusy(false);
    }
  }
  const newTask = useCallback(
    async (task: Task) => {
      const next = await saveTask({
        ...task,
        rank:
          Math.max(
            0,
            ...data.tasks
              .filter((t) => t.area === task.area && t.status === task.status)
              .map((t) => t.rank),
          ) + 1024,
      });
      setQuery('');
      setTodayOnly(false);
      setArchive(false);
      toast.add({
        title: 'Задача добавлена',
        type: 'success',
        actionProps: { children: 'Открыть', onClick: () => setSelected(next) },
      });
      return next;
    },
    [saveTask, data.tasks],
  );
  const toolState = useRef({
    tasks,
    data,
    area,
    projectId,
    newTask,
    move,
    setSelected,
  });
  useEffect(() => {
    toolState.current = {
      tasks,
      data,
      area,
      projectId,
      newTask,
      move,
      setSelected,
    };
  }, [tasks, data, area, projectId, newTask, move]);
  useEffect(() => registerWorkspaceTools(toolState), []);
  const card = (task: Task) => {
    const p = data.projects.find((p) => p.id === task.projectId);
    return (
      // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Native dragging supplements accessible buttons for every card action.
      <article
        key={task.id}
        className={`task-card ${task.status === 'done' ? 'task-done' : ''} ${dragging === task.id ? 'dragging' : ''} ${dropTarget === task.id ? 'drop-before' : ''}`}
        draggable={!archive && !pending && !globalView}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', task.id);
          e.dataTransfer.effectAllowed = 'move';
          setDragging(task.id);
        }}
        onDragEnd={() => {
          setDragging('');
          setDropTarget('');
        }}
        onDragOver={(e) => {
          if (dragging && dragging !== task.id) {
            e.preventDefault();
            e.stopPropagation();
            setDropTarget(task.id);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (dragging && dragging !== task.id) {
            const t = data.tasks.find((t) => t.id === dragging);
            if (t) safely(move(t, task.status, task));
          }
          setDragging('');
          setDropTarget('');
        }}
      >
        <button
          className="card-open"
          data-task-open={task.id}
          onClick={() => setSelected(task)}
          aria-label={'Открыть: ' + task.title}
        />
        <div className="task-title-row">
          <button
            disabled={!!pending}
            className="complete-circle"
            aria-label={
              task.archived
                ? 'Вернуть задачу из архива'
                : task.status === 'done'
                  ? 'Вернуть в очередь'
                  : 'Завершить: ' + task.title
            }
            onClick={() =>
              safely(
                change(
                  task,
                  task.archived
                    ? { archived: false }
                    : { status: task.status === 'done' ? 'todo' : 'done' },
                  task.archived
                    ? 'Задача возвращена'
                    : task.status === 'done'
                      ? 'Возвращено в очередь'
                      : 'Задача готова',
                ),
              )
            }
          >
            {task.archived ? (
              <Undo2 size={16} />
            ) : task.status === 'done' ? (
              <CircleCheck size={19} />
            ) : (
              <Check size={12} className="check-hover" />
            )}
          </button>
          <h3>{task.title}</h3>
        </div>
        {task.status === 'waiting' && task.waitingFor && (
          <p className="waiting-line">
            <Clock3 size={14} />
            {task.waitingFor}
          </p>
        )}
        <div className="card-label-row">
          {globalView && (
            <span className="task-context">
              {AREAS.find((a) => a.id === task.area)?.name} ·{' '}
              {STATUSES.find((s) => s.id === task.status)?.name}
              {task.archived ? ' · Архив' : ''}
            </span>
          )}
          {task.focus && task.status !== 'done' && !task.archived && (
            <span className="focus-mark">
              <Star size={13} fill="currentColor" />В фокусе
            </span>
          )}
          {p && (globalView || projectId !== p.id) && (
            <span className="project-tag">
              <span className="tag-dot" style={{ background: p.color }} />
              {p.name}
            </span>
          )}
          {task.demo && (
            <span
              className="sample-mark"
              title="Пример, не подтверждённая рабочая задача"
            >
              пример
            </span>
          )}
        </div>
        <div className="card-meta">
          {task.due && (
            <span
              className={
                'due-label ' +
                (task.status !== 'done' && task.due < today ? 'overdue' : '')
              }
            >
              <CalendarDays size={14} />
              {task.due < today && task.status !== 'done' ? 'Срок: ' : ''}
              {dateLabel(task.due, today)}
            </span>
          )}
          {task.status === 'waiting' && task.followUp && (
            <span
              className={
                'check-date ' + (task.followUp <= today ? 'check-now' : '')
              }
            >
              <Clock3 size={14} />
              Вернуться {dateLabel(task.followUp, today).toLowerCase()}
            </span>
          )}
          {task.checklist.length > 0 && (
            <span>
              <ListChecks size={15} />
              {task.checklist.filter((c) => c.done).length}/
              {task.checklist.length}
            </span>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                className="card-menu"
                size="icon"
                aria-label={'Действия: ' + task.title}
              />
            }
          >
            ···
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={!!pending || task.archived || task.status === 'done'}
              onClick={() =>
                safely(
                  change(
                    task,
                    { focus: !task.focus },
                    task.focus ? 'Задача убрана из фокуса' : 'Задача в фокусе',
                  ),
                )
              }
            >
              <Star />
              {task.focus ? 'Убрать из фокуса' : 'В фокус'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {STATUSES.map((s) => (
              <DropdownMenuItem
                key={s.id}
                disabled={!!pending || task.status === s.id}
                onClick={() => safely(move(task, s.id))}
              >
                <span className="status-dot" style={{ background: s.color }} />
                {s.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!!pending}
              onClick={() =>
                safely(
                  change(
                    task,
                    {
                      status: 'todo',
                      rank:
                        Math.min(
                          0,
                          ...data.tasks
                            .filter(
                              (t) =>
                                t.area === task.area && t.status === 'todo',
                            )
                            .map((t) => t.rank),
                        ) - 1024,
                    },
                    'Задача в начале очереди',
                  ),
                )
              }
            >
              <ArrowUp />В начало очереди
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!!pending}
              onClick={() =>
                safely(
                  change(
                    task,
                    { archived: !task.archived },
                    task.archived ? 'Задача возвращена' : 'Задача в архиве',
                  ),
                )
              }
            >
              <Archive />
              {task.archived ? 'Вернуть из архива' : 'В архив'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </article>
    );
  };
  const board = (
    <div className={'kanban ' + (view === 'list' ? 'list-view' : '')}>
      {STATUSES.map((s) => {
        const column = tasks.filter((t) => t.status === s.id);
        return (
          <section
            key={s.id}
            className={`column column-${s.id} ${dropTarget === s.id ? 'drop-column' : ''}`}
            onDragOver={(e) => {
              if (dragging) {
                e.preventDefault();
                setDropTarget(s.id);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              const t = data.tasks.find((t) => t.id === dragging);
              if (t) safely(move(t, s.id));
              setDragging('');
              setDropTarget('');
            }}
          >
            <div className="column-head">
              <div>
                <span className="status-dot" style={{ background: s.color }} />
                <h2>{s.name}</h2>
                <span className="column-count">{column.length}</span>
              </div>
            </div>

            <div className="cards">
              {column.map(card)}
              {!column.length && !query && !todayOnly && (
                <Empty className="column-empty">
                  <EmptyDescription>
                    {s.id === 'todo'
                      ? 'Место для следующего дела'
                      : s.id === 'doing'
                        ? 'Начни с одной задачи'
                        : s.id === 'waiting'
                          ? 'Ничего не ждёт ответа'
                          : 'Здесь будут маленькие победы'}
                  </EmptyDescription>
                </Empty>
              )}
            </div>
            {!archive &&
              (inline === s.id ? (
                <form
                  className="inline-create"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void inlineSubmit(s.id);
                  }}
                >
                  <Input
                    ref={inlineRef}
                    disabled={inlineBusy}
                    aria-label="Название новой задачи"
                    placeholder="Что нужно сделать?"
                    value={inlineTitle}
                    maxLength={240}
                    onChange={(e) => {
                      setInlineTitle(e.target.value);
                      try {
                        sessionStorage.setItem(
                          `inline-draft/${area}/${projectId}/${s.id}`,
                          e.target.value,
                        );
                      } catch {}
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape' && !inlineBusy) setInline(null);
                    }}
                  />
                  {inlineError && (
                    <p className="form-error" role="alert">
                      {inlineError}
                    </p>
                  )}
                  <div>
                    <Button
                      disabled={inlineBusy || !inlineTitle.trim()}
                      type="submit"
                    >
                      {inlineBusy ? 'Добавляем…' : 'Добавить'}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={inlineBusy}
                      aria-label="Закрыть добавление"
                      onClick={() => setInline(null)}
                    >
                      <X />
                    </Button>
                  </div>
                </form>
              ) : (
                <Button
                  variant="ghost"
                  className="column-add"
                  onClick={() => startInline(s.id)}
                >
                  <Plus />
                  Добавить задачу
                </Button>
              ))}
          </section>
        );
      })}
    </div>
  );
  const disabled = loading || !!error;
  return (
    <>
      <Sidebar className="workspace-sidebar">
        <SidebarHeader className="brand">
          <span className="brand-symbol">
            <PanelsTopLeft size={22} />
          </span>
          <span>TaskIndex</span>
        </SidebarHeader>
        <SidebarContent className="side-body">
          <SidebarMenu className="area-nav">
            <SidebarMenuItem>
              <SidebarMenuButton
                className="area-button"
                isActive={focusView && !searching}
                onClick={() => {
                  if (inlineBusy) return;
                  setFocusView(true);
                  setQuery('');
                  setArchive(false);
                  setInline(null);
                  setOpenMobile(false);
                  bodyRef.current?.scrollTo({ left: 0, top: 0 });
                }}
              >
                <span className="area-icon">
                  <Star size={18} />
                </span>
                <span>Фокус</span>
                <span className="focus-count">
                  {focus.reduce(
                    (count, group) => count + group.tasks.length,
                    0,
                  ) || ''}
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {AREAS.map((a) => {
              const Icon = icons[a.id];
              return (
                <SidebarMenuItem key={a.id}>
                  <SidebarMenuButton
                    className="area-button"
                    isActive={a.id === area && !globalView}
                    onClick={() => navigate(a.id)}
                  >
                    <span className="area-icon">
                      <Icon size={18} />
                    </span>
                    <span>{a.name}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
          <div className="nav-section-heading">
            <span>{area === 'development' ? 'Проекты' : 'Направления'}</span>
          </div>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                className="project-button"
                isActive={projectId === 'all' && !archive && !globalView}
                onClick={() => navigate(area)}
              >
                <LayoutGrid />
                <span>Все задачи</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {projects.map((p) => (
              <SidebarMenuItem key={p.id}>
                <SidebarMenuButton
                  className="project-button"
                  isActive={projectId === p.id && !archive && !globalView}
                  onClick={() => navigate(area, p.id)}
                >
                  <span
                    className="project-dot"
                    style={{ background: p.color }}
                  />
                  <span>{p.name}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
            {data.tasks.some(
              (t) =>
                t.area === area &&
                !t.projectId &&
                !t.archived &&
                (showDemo || !t.demo),
            ) &&
              projects.length > 0 && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    className="project-button"
                    isActive={projectId === 'none' && !archive && !globalView}
                    onClick={() => navigate(area, 'none')}
                  >
                    <span className="project-dot unassigned-dot" />
                    <span>Без направления</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
          </SidebarMenu>
          <Button
            variant="ghost"
            className="add-project"
            disabled={disabled}
            onClick={() => setProjectDialog('new')}
          >
            <Plus />
            Добавить {area === 'development' ? 'проект' : 'направление'}
          </Button>
        </SidebarContent>
        <SidebarFooter className="side-footer">
          <Button
            variant="ghost"
            className={'archive-link ' + (archive ? 'active' : '')}
            onClick={() => {
              setArchive(!archive);
              setFocusView(false);
              setQuery('');
              setTodayOnly(false);
              setProjectId('all');
              setOpenMobile(false);
            }}
          >
            <Archive size={15} />
            Архив
            <span>
              {data.tasks.filter(
                (t) => t.area === area && t.archived && (showDemo || !t.demo),
              ).length || ''}
            </span>
          </Button>
          <div className="private-note">
            <span>Дмитрий</span>
            <LockKeyhole size={13} />
            <span>Приватно</span>
          </div>
        </SidebarFooter>
      </Sidebar>
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
                    searchRef.current?.focus();
                  }}
                >
                  <Search size={17} />
                </button>
                <input
                  ref={searchRef}
                  placeholder="Найти во всех областях…"
                  aria-label="Найти во всех областях"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setQuery('');
                      setMobileSearch(false);
                      searchRef.current?.blur();
                    }
                  }}
                />
                {query ? (
                  <button
                    onClick={() => setQuery('')}
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
                Все области · {tasks.length} задач
                {searching && searchArchive ? ' в архиве' : ''}
              </output>
            ) : (
              <Tabs value={view} onValueChange={(v) => setView(String(v))}>
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
              <span className="sync-status" aria-live="polite">
                {pending ? (
                  <>
                    <LoaderCircle size={13} className="animate-spin" />
                    Сохраняем…
                  </>
                ) : mutationError ? (
                  <span className="save-failed" title={mutationError}>
                    Не сохранилось
                  </span>
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
                    onCheckedChange={setTodayOnly}
                  />
                  <span>На сегодня</span>
                </label>
              )}
              {searching && (
                <label className="today-toggle" htmlFor="search-archive">
                  <Checkbox
                    id="search-archive"
                    checked={searchArchive}
                    onCheckedChange={setSearchArchive}
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
                  <DropdownMenuItem onClick={() => setShowDemo(!showDemo)}>
                    {showDemo ? 'Скрыть примеры' : 'Показать примеры'}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!!pending || loading}
                    onClick={() => void refresh()}
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
          {showDemo &&
            (globalView ? tasks : contextual).some((t) => t.demo) && (
              <div className="demo-notice">
                <span>На доске есть примеры задач</span>
                <button onClick={() => setShowDemo(false)}>
                  Скрыть примеры
                </button>
              </div>
            )}
          {todayOnly && !globalView && (
            <p className="filter-note">
              Срок или дата проверки — сегодня и раньше
            </p>
          )}
          {error ? (
            <Empty className="main-empty">
              <EmptyTitle>Не удалось открыть доску</EmptyTitle>
              <EmptyDescription>{error}</EmptyDescription>
              <Button onClick={() => void refresh()}>
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
          ) : globalView ? (
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
              renderTask={card}
              onBrowse={() => navigate(area)}
            />
          ) : tasks.length === 0 &&
            (query || todayOnly || archive || !contextual.length) ? (
            <Empty className="main-empty">
              <span className="empty-icon">
                {query ? (
                  <Search />
                ) : archive ? (
                  <Archive />
                ) : todayOnly ? (
                  <CircleCheck />
                ) : (
                  <PanelsTopLeft />
                )}
              </span>
              <EmptyTitle>
                {query
                  ? 'Ничего не нашлось'
                  : archive
                    ? 'Архив пуст'
                    : todayOnly
                      ? 'На сегодня всё спокойно'
                      : 'Здесь пока нет задач'}
              </EmptyTitle>
              <EmptyDescription>
                {query
                  ? 'Попробуй другое слово или сбрось поиск.'
                  : archive
                    ? 'Здесь сохраняются задачи, убранные с доски.'
                    : todayOnly
                      ? 'Нет задач со сроком или проверкой на сегодня.'
                      : 'Добавь первое дело. Достаточно названия.'}
              </EmptyDescription>
              {query || todayOnly ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setQuery('');
                    setTodayOnly(false);
                  }}
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
            board
          )}
        </div>
      </SidebarInset>
      {selected && (
        <TaskEditor
          key={selected.id}
          task={selected}
          projects={data.projects}
          onClose={() => setSelected(null)}
          onSave={async (t) => {
            const next = await saveTask({ ...t, demo: false });
            toast.add({ title: 'Изменения сохранены', type: 'success' });
            return next;
          }}
          onArchive={async (t) => {
            await change(
              t,
              { archived: !t.archived },
              t.archived ? 'Задача возвращена' : 'Задача в архиве',
            );
          }}
          onFirst={async (t) => {
            await change(
              t,
              {
                status: 'todo',
                rank:
                  Math.min(
                    0,
                    ...data.tasks
                      .filter(
                        (other) =>
                          other.area === t.area && other.status === 'todo',
                      )
                      .map((t) => t.rank),
                  ) - 1024,
              },
              'Задача в начале очереди',
            );
          }}
        />
      )}
      {create && (
        <QuickCreate
          area={area}
          projectId={projectId === 'none' ? '' : projectId}
          status={create}
          projects={data.projects}
          onClose={() => setCreate(null)}
          onSave={(task) =>
            newTask(focusView ? { ...task, focus: true } : task)
          }
        />
      )}
      {projectDialog && (
        <ProjectDialog
          area={area}
          project={projectDialog === 'new' ? undefined : projectDialog}
          onClose={() => setProjectDialog(null)}
          onSave={async (p) => {
            const next = await saveProject(p);
            navigate(area, next.id);
            toast.add({
              title: p.revision
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
