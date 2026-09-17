// oxlint-disable jsx-a11y/prefer-tag-over-role -- план 07, §3.9: `<output>` это
// результат вычисления и по HTML принимает только фразовое содержимое, а здесь
// внутри живут абзацы, `pre` и кнопки. Роль `status` даёт ту же живую область
// без нарушения модели содержимого.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { LIMITS } from '@shared/limits';
import type {
  Comment,
  Context,
  DomainEvent,
  OperationSummary,
  Page,
  StoredOperation,
  Task,
} from '@shared/model';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { toast } from '../ui/toast';
import {
  commentSchema,
  contextSchema,
  eventSchema,
  operationSummarySchema,
  pageSchema,
  storedOperationSchema,
} from '@shared/domain-schemas';
import { ApiError, request } from './api';
import { workspaceStore } from './store';
import { commandLabels, taskCount } from './labels';
import { actorOptions, ALL_ACTORS, describeEvent } from './history';
import { useDraft } from './use-draft';
import {
  commentAddCommand,
  commentRemoveCommand,
  undoCommand,
} from './commands';
import { latestSeqForTask } from './selectors';
import { useWorkspace } from './use-workspace';
const labels = commandLabels;
function time(value: string) {
  return new Date(value).toLocaleString('ru-RU', {
    timeZone: workspaceStore.getSnapshot().timezone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
async function undo(payload: { seq: number } | { operationId: string }) {
  try {
    await workspaceStore.submit(undoCommand(payload));
    toast.add({ title: 'Изменение отменено', type: 'success' });
  } catch (error_) {
    toast.add({
      title: error_ instanceof Error ? error_.message : 'Не удалось отменить.',
      type: 'error',
    });
  }
}
// TI-032: one event told in words. Who and when comes from the event itself,
// what changed from `describeEvent`; the stored payload stays available under
// «Технические детали» for a report or a bug.
function EventRow({ event }: { event: DomainEvent }) {
  const { data } = useSyncExternalStore(
    workspaceStore.subscribe,
    workspaceStore.getSnapshot,
  );
  const [raw, setRaw] = useState(false);
  const story = describeEvent(event, {
    projects: data.projects,
    labels: data.labels,
  });
  return (
    <li className="event-row">
      <div>
        <strong>{labels[event.command] || event.command}</strong>
        <span>
          {event.actorLabel} · {time(event.at)}
        </span>
      </div>
      {story.lines.length > 0 ? (
        <dl>
          {story.lines.map((line) => (
            <div key={line.label}>
              <dt>{line.label}</dt>
              <dd>
                {line.text}
                {line.note && <small className="event-note">{line.note}</small>}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="focus-hint">Предметные поля не изменились.</p>
      )}
      <div className="event-actions">
        <Button
          variant="ghost"
          size="sm"
          disabled={event.command === 'project.create'}
          onClick={() => void undo({ seq: event.seq })}
        >
          Отменить
        </Button>
        {story.technical.length > 0 && (
          <Collapsible open={raw} onOpenChange={setRaw}>
            <CollapsibleTrigger className="event-raw-trigger">
              Технические детали
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="event-raw">
                {JSON.stringify(Object.fromEntries(story.technical), null, 2)}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </li>
  );
}
export function Activity({
  actor,
  onActor,
}: {
  actor: string;
  onActor: (actor: string) => void;
}) {
  const { seq, generation, operationsVersion } = useSyncExternalStore(
    workspaceStore.subscribe,
    workspaceStore.getSnapshot,
  );
  const [page, setPage] = useState<Page<OperationSummary> | null>(null),
    // План 01, доп. 16: страницы ленты собраны из разных позиций журнала.
    [changed, setChanged] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [agents, setAgents] = useState<Context['agents'] | null>(null),
    [loadedVersion, setLoadedVersion] = useState('');
  // The filter is part of the identity of the loaded page: a change reloads
  // from the first page and the answers of the previous filter are dropped.
  const version = `${generation}/${seq}/${operationsVersion}/${actor}`;
  const query = actor ? `&actor=${encodeURIComponent(actor)}` : '';
  const loading = loadedVersion !== version;
  const requestVersion = useRef({ active: false }),
    loadedCount = useRef(50),
    loadedActor = useRef(actor);
  useEffect(() => {
    let active = true;
    void request('/api/context', contextSchema)
      .then((value) => {
        if (active) setAgents(value.agents);
      })
      .catch(() => {
        // The filter still works from the loaded journal without the directory.
      });
    return () => {
      active = false;
    };
  }, [generation]);
  useEffect(() => {
    if (loadedActor.current !== actor) {
      loadedActor.current = actor;
      loadedCount.current = 50;
      setPage(null);
    }
    const flight = { active: true };
    requestVersion.current = flight;
    const load = async () => {
      let next = await request(
        `/api/operations?limit=50${query}`,
        pageSchema(operationSummarySchema),
      );
      const items = [...next.items];
      // Preserve the depth the owner has opened, using fresh cursors throughout.
      while (next.nextCursor && items.length < loadedCount.current) {
        if (!flight.active) return null;
        next = await request(
          `/api/operations?limit=50${query}&cursor=${encodeURIComponent(next.nextCursor)}`,
          pageSchema(operationSummarySchema),
        );
        items.push(...next.items);
      }
      return { ...next, items };
    };
    void load()
      .then((value) => {
        if (flight.active && value) {
          setPage(value);
          setError('');
        }
      })
      .catch((error_: Error) => {
        if (flight.active) setError(error_.message);
      })
      .finally(() => {
        if (flight.active) {
          setLoadedVersion(version);
          setBusy(false);
        }
      });
    return () => {
      flight.active = false;
    };
  }, [version, actor, query]);
  async function more() {
    if (!page?.nextCursor || busy || loading) return;
    setBusy(true);
    const flight = requestVersion.current;
    const first = `/api/operations?limit=50${query}`;
    try {
      const next = await request(
        `${first}&cursor=${encodeURIComponent(page.nextCursor)}`,
        pageSchema(operationSummarySchema),
      );
      if (flight.active) {
        const items = [...page.items, ...next.items];
        loadedCount.current = items.length;
        setPage({ ...next, items });
        // Позиция журнала между страницами разъехалась: показанный список
        // склеен из разных состояний, и об этом честнее сказать.
        setChanged(next.seq !== page.seq);
      }
    } catch (error_) {
      // Курсор устарел (журнал усечён или сменилось поколение): единственный
      // согласованный ответ — перечитать с первой страницы.
      if (error_ instanceof ApiError && error_.status === 409) {
        try {
          const restart = await request(
            first,
            pageSchema(operationSummarySchema),
          );
          if (flight.active) {
            loadedCount.current = restart.items.length;
            setPage(restart);
            setChanged(true);
            setError('');
          }
          return;
        } catch (retryError) {
          if (flight.active)
            setError(
              retryError instanceof Error
                ? retryError.message
                : 'Не удалось загрузить.',
            );
          return;
        }
      }
      if (flight.active)
        setError(
          error_ instanceof Error ? error_.message : 'Не удалось загрузить.',
        );
    } finally {
      if (flight.active) setBusy(false);
    }
  }
  const options = actorOptions(agents, page?.items ?? []);
  return (
    <section className="activity-view">
      <p className="focus-hint">
        Изменения владельца и агентов. Операцию можно раскрыть и отменить
        целиком.
      </p>
      <div className="activity-filter">
        <Select
          value={actor}
          onValueChange={(v) => onActor(v === null ? ALL_ACTORS : String(v))}
          items={options}
        >
          <SelectTrigger className="field-select" aria-label="Автор изменений">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {actor && (
          <Button variant="ghost" size="sm" onClick={() => onActor(ALL_ACTORS)}>
            Показать всех
          </Button>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {changed && (
        <p className="focus-hint" role="status">
          Список изменился во время загрузки
        </p>
      )}
      {!page && !error && <p role="status">Загружаем активность…</p>}
      {page && !page.items.length && (
        <p className="focus-hint">
          {actor
            ? 'У этого автора пока нет операций.'
            : 'Здесь появятся первые изменения.'}
        </p>
      )}
      <div className="operation-list">
        {page?.items.map((operation) => (
          <OperationRow key={operation.id} operation={operation} />
        ))}
      </div>
      {page?.more && (
        <Button
          variant="outline"
          disabled={busy || loading}
          onClick={() => void more()}
        >
          Показать ещё
        </Button>
      )}
    </section>
  );
}
function OperationRow({ operation }: { operation: OperationSummary }) {
  const [open, setOpen] = useState(false),
    [detail, setDetail] = useState<StoredOperation | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    if (!open || detail) return;
    let active = true;
    void request(
      `/api/operations/${encodeURIComponent(operation.id)}`,
      storedOperationSchema,
    )
      .then((value) => {
        if (active) setDetail(value);
      })
      .catch((error_: Error) => {
        if (active) setError(error_.message);
      });
    return () => {
      active = false;
    };
  }, [open, operation.id, detail]);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="operation-row"
      data-operation-id={operation.id}
      data-outcome={operation.ok ? 'success' : 'rejected'}
    >
      <div className="operation-heading">
        <CollapsibleTrigger>
          <strong>{operation.actorLabel}</strong>
          <span>
            {operation.ok
              ? labels[operation.command] || operation.command
              : 'Операция отклонена'}
            {operation.taskCount > 0 && ` · ${taskCount(operation.taskCount)}`}
          </span>
          <small>{time(operation.createdAt)}</small>
        </CollapsibleTrigger>
        <Button
          variant="ghost"
          size="sm"
          disabled={
            !operation.ok ||
            operation.firstSeq === null ||
            operation.command === 'project.create'
          }
          onClick={() => void undo({ operationId: operation.id })}
        >
          Отменить
        </Button>
      </div>
      {operation.titles.length > 0 && (
        <p className="operation-titles">{operation.titles.join(' · ')}</p>
      )}
      {!operation.ok && operation.errorMessage && (
        <p className="form-error" data-error-code={operation.errorCode}>
          {operation.errorMessage}
        </p>
      )}
      <CollapsibleContent>
        {error && <p role="alert">{error}</p>}
        {!detail && !error && <p role="status">Загружаем изменения…</p>}
        {detail && !detail.result.ok && !operation.errorMessage && (
          <p className="form-error">
            Операция отклонена: {detail.result.message}
          </p>
        )}
        <ol className="event-list">
          {detail?.result.ok &&
            detail.result.events.map((event) => (
              <EventRow key={event.seq} event={event} />
            ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}
export function TaskDiscussion({ task }: { task: Task }) {
  const { generation, lastEvents, connected } = useWorkspace();
  const [commentsOpen, setCommentsOpen] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false);
  const [comments, setComments] = useState<Page<Comment> | null>(null),
    [history, setHistory] = useState<Page<DomainEvent> | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const key = `comment/${task.id}`;
  const [text, setText] = useState('');
  const draft = useDraft<{ text: string }>(
    key,
    { text },
    { enabled: text.length > 0 },
  );
  const [seeded, setSeeded] = useState(false);
  if (!seeded) {
    setSeeded(true);
    if (draft.fields?.text) setText(draft.fields.text);
  }
  // TI-063: обсуждение перечитывается по событиям своей задачи, а не по общему
  // `seq`: правка соседней карточки больше не дёргает `/comments` и `/history`.
  const relevantSeq = latestSeqForTask(lastEvents, task.id);
  // Разрыв потока мог пропустить события: после восстановления связи читаем заново.
  const [reconnects, setReconnects] = useState(0);
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (connected && !wasConnected.current) setReconnects((n) => n + 1);
    wasConnected.current = connected;
  }, [connected]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        if (commentsOpen) {
          const value = await request(
            `/api/tasks/${task.id}/comments?limit=100`,
            pageSchema(commentSchema),
          );
          if (active) setComments(value);
        }
        if (historyOpen) {
          const value = await request(
            `/api/tasks/${task.id}/history?limit=100`,
            pageSchema(eventSchema),
          );
          if (active) setHistory(value);
        }
        if (active) setError('');
      } catch (error_) {
        if (active)
          setError(
            error_ instanceof Error
              ? error_.message
              : 'Не удалось загрузить историю.',
          );
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [task.id, relevantSeq, generation, reconnects, commentsOpen, historyOpen]);
  async function add() {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      // TI-023: тот же конверт, пока прошлая отправка не завершилась
      // окончательно; новый — только после отказа и правки текста.
      draft.dispatch({ type: 'edit', signature: text.trim() });
      const sending = draft.dispatch({ type: 'send', signature: text.trim() });
      await workspaceStore.submit(
        commentAddCommand(task.id, draft.entity.current, text.trim()),
        sending.operationId,
      );
      draft.dispatch({ type: 'success' });
      draft.clear();
      setText('');
    } catch (error_) {
      draft.dispatch({
        type: 'reject',
        retryable: !(error_ instanceof ApiError) || error_.detail.retryable,
      });
      setError(
        error_ instanceof Error ? error_.message : 'Не удалось отправить.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function remove(comment: Comment) {
    try {
      await workspaceStore.submit(commentRemoveCommand(comment.id));
    } catch (error_) {
      setError(
        error_ instanceof Error ? error_.message : 'Не удалось удалить.',
      );
    }
  }
  // Каждая страница проверяется своей схемой: комментарии и события — разные
  // контракты, общий каст между ними больше не нужен (план 07, шаг 8).
  async function loadMore(kind: 'comments' | 'history') {
    const current = kind === 'comments' ? comments : history;
    if (!current?.nextCursor) return;
    const path = `/api/tasks/${task.id}/${kind}?limit=100&cursor=${encodeURIComponent(current.nextCursor)}`;
    try {
      if (kind === 'comments') {
        const next = await request(path, pageSchema(commentSchema));
        setComments({
          ...next,
          items: [...(comments?.items ?? []), ...next.items],
        });
      } else {
        const next = await request(path, pageSchema(eventSchema));
        setHistory({
          ...next,
          items: [...(history?.items ?? []), ...next.items],
        });
      }
    } catch (error_) {
      setError(
        error_ instanceof Error ? error_.message : 'Не удалось загрузить.',
      );
    }
  }
  return (
    <div className="task-discussion">
      {task.originUrl && (
        <a href={task.originUrl} target="_blank" rel="noreferrer">
          Открыть источник
        </a>
      )}
      <Collapsible open={commentsOpen} onOpenChange={setCommentsOpen}>
        <CollapsibleTrigger className="discussion-heading">
          Комментарии <span>{task.commentCount}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {comments === null && <p role="status">Загружаем комментарии…</p>}
          <ol className="comment-list">
            {comments?.items.map((comment) => (
              <li key={comment.id}>
                <div>
                  <strong>{comment.actorLabel}</strong>
                  <time>{time(comment.createdAt)}</time>
                </div>
                <p>{comment.deletedAt ? 'Комментарий удалён' : comment.text}</p>
                {!comment.deletedAt && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void remove(comment)}
                  >
                    Удалить
                  </Button>
                )}
              </li>
            ))}
          </ol>
          {comments?.more && (
            <Button variant="ghost" onClick={() => void loadMore('comments')}>
              Ещё комментарии
            </Button>
          )}
          <Textarea
            aria-label="Новый комментарий"
            placeholder="Комментарий или поручение…"
            maxLength={LIMITS.commentText}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
          />
          <Button disabled={busy || !text.trim()} onClick={() => void add()}>
            {busy ? 'Отправляем…' : 'Добавить комментарий'}
          </Button>
        </CollapsibleContent>
      </Collapsible>
      <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
        <CollapsibleTrigger className="discussion-heading">
          История
        </CollapsibleTrigger>
        <CollapsibleContent>
          {history === null && <p role="status">Загружаем историю…</p>}
          <ol className="event-list">
            {history?.items.map((event) => (
              <EventRow key={event.seq} event={event} />
            ))}
          </ol>
          {history?.more && (
            <Button variant="ghost" onClick={() => void loadMore('history')}>
              Ещё изменения
            </Button>
          )}
        </CollapsibleContent>
      </Collapsible>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
