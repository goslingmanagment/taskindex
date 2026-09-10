import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
  Comment,
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
import { toast } from '../ui/toast';
import { request } from './api';
import { workspaceStore } from './store';
import { commandLabels, taskCount } from './labels';
import { readDraft, writeDraft, clearDraft } from './drafts';
const labels = commandLabels;
const fields: Record<string, string> = {
  title: 'Название',
  status: 'Состояние',
  note: 'Заметка',
  due: 'Срок',
  followUp: 'Дата возврата',
  waitingFor: 'Чего ждём',
  projectId: 'Направление',
  area: 'Область',
  focus: 'Фокус',
  archived: 'Архив',
  checklist: 'Шаги',
  description: 'Описание',
  name: 'Название',
  text: 'Текст',
  deletedAt: 'Удаление',
  orderKey: 'Порядок',
};
function formatValue(value: unknown): string {
  if (value === null) return '—';
  if (value === true) return 'Да';
  if (value === false) return 'Нет';
  if (typeof value === 'object') return JSON.stringify(value);
  return typeof value === 'string'
    ? value
    : typeof value === 'number'
      ? String(value)
      : '—';
}
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
    await workspaceStore.submit({ command: 'undo', payload });
    toast.add({ title: 'Изменение отменено', type: 'success' });
  } catch (e) {
    toast.add({
      title: e instanceof Error ? e.message : 'Не удалось отменить.',
      type: 'error',
    });
  }
}
function EventRow({ event }: { event: DomainEvent }) {
  const shown = Object.entries(event.changes).filter(
    ([field]) => field in fields,
  );
  return (
    <li className="event-row">
      <div>
        <strong>{labels[event.command] || event.command}</strong>
        <span>
          {event.actorLabel} · {time(event.at)}
        </span>
      </div>
      {shown.length > 0 && (
        <dl>
          {shown.map(([field, change]) => (
            <div key={field}>
              <dt>{fields[field]}</dt>
              <dd>
                <del>{formatValue(change.from)}</del>
                <span> → {formatValue(change.to)}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={event.command === 'project.create'}
        onClick={() => void undo({ seq: event.seq })}
      >
        Отменить
      </Button>
    </li>
  );
}
export function Activity() {
  const { seq, generation, operationsVersion } = useSyncExternalStore(
    workspaceStore.subscribe,
    workspaceStore.getSnapshot,
  );
  const [page, setPage] = useState<Page<OperationSummary> | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loadedVersion, setLoadedVersion] = useState('');
  const version = `${generation}/${seq}/${operationsVersion}`;
  const loading = loadedVersion !== version;
  const requestVersion = useRef({ active: false }),
    loadedCount = useRef(50);
  useEffect(() => {
    const flight = { active: true };
    requestVersion.current = flight;
    const load = async () => {
      let next = await request<Page<OperationSummary>>(
        '/api/operations?limit=50',
      );
      const items = [...next.items];
      // Preserve the depth the owner has opened, using fresh cursors throughout.
      while (next.nextCursor && items.length < loadedCount.current) {
        if (!flight.active) return null;
        next = await request<Page<OperationSummary>>(
          `/api/operations?limit=50&cursor=${encodeURIComponent(next.nextCursor)}`,
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
      .catch((e) => {
        if (flight.active) setError(e.message);
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
  }, [version]);
  async function more() {
    if (!page?.nextCursor || busy || loading) return;
    setBusy(true);
    const flight = requestVersion.current;
    try {
      const next = await request<Page<OperationSummary>>(
        `/api/operations?limit=50&cursor=${encodeURIComponent(page.nextCursor)}`,
      );
      if (flight.active) {
        const items = [...page.items, ...next.items];
        loadedCount.current = items.length;
        setPage({ ...next, items });
      }
    } catch (e) {
      if (flight.active)
        setError(e instanceof Error ? e.message : 'Не удалось загрузить.');
    } finally {
      if (flight.active) setBusy(false);
    }
  }
  return (
    <section className="activity-view">
      <p className="focus-hint">
        Изменения владельца и агентов. Операцию можно раскрыть и отменить
        целиком.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!page && !error && <output>Загружаем активность…</output>}
      {page && !page.items.length && (
        <p className="focus-hint">Здесь появятся первые изменения.</p>
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
    void request<StoredOperation>(
      `/api/operations/${encodeURIComponent(operation.id)}`,
    )
      .then((value) => {
        if (active) setDetail(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
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
        {!detail && !error && <output>Загружаем изменения…</output>}
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
  const { seq, generation } = useSyncExternalStore(
    workspaceStore.subscribe,
    workspaceStore.getSnapshot,
  );
  const [commentsOpen, setCommentsOpen] = useState(false),
    [historyOpen, setHistoryOpen] = useState(false);
  const [comments, setComments] = useState<Page<Comment> | null>(null),
    [history, setHistory] = useState<Page<DomainEvent> | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const key = `comment/${task.id}`;
  const [initial] = useState(() => readDraft<{ text: string }>(key));
  const [text, setText] = useState(
    initial?.generation === generation ? initial.fields.text : '',
  );
  const [intent, setIntent] = useState(() => ({
    id:
      initial?.generation === generation && initial.id
        ? initial.id
        : crypto.randomUUID(),
    operationId:
      initial?.generation === generation && initial.operationId
        ? initial.operationId
        : crypto.randomUUID(),
  }));
  useEffect(() => {
    if (text)
      writeDraft(key, {
        formatVersion: 1,
        generation,
        baseRevision: 0,
        fields: { text },
        ...intent,
      });
    else if (!initial || initial.generation === generation) clearDraft(key);
  }, [text, key, generation, intent, initial]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        if (commentsOpen) {
          const value = await request<Page<Comment>>(
            `/api/tasks/${task.id}/comments?limit=100`,
          );
          if (active) setComments(value);
        }
        if (historyOpen) {
          const value = await request<Page<DomainEvent>>(
            `/api/tasks/${task.id}/history?limit=100`,
          );
          if (active) setHistory(value);
        }
        if (active) setError('');
      } catch (e) {
        if (active)
          setError(
            e instanceof Error ? e.message : 'Не удалось загрузить историю.',
          );
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [task.id, seq, commentsOpen, historyOpen]);
  async function add() {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await workspaceStore.submit(
        {
          command: 'comment.add',
          payload: { taskId: task.id, id: intent.id, text: text.trim() },
        },
        intent.operationId,
      );
      clearDraft(key);
      setText('');
      setIntent({ id: crypto.randomUUID(), operationId: crypto.randomUUID() });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отправить.');
    } finally {
      setBusy(false);
    }
  }
  async function remove(comment: Comment) {
    try {
      await workspaceStore.submit({
        command: 'comment.remove',
        payload: { commentId: comment.id },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось удалить.');
    }
  }
  async function loadMore(kind: 'comments' | 'history') {
    const current = kind === 'comments' ? comments : history;
    if (!current?.nextCursor) return;
    try {
      const next = await request<Page<Comment | DomainEvent>>(
        `/api/tasks/${task.id}/${kind}?limit=100&cursor=${encodeURIComponent(current.nextCursor)}`,
      );
      if (kind === 'comments')
        setComments({
          ...next,
          items: [...(comments?.items ?? []), ...(next.items as Comment[])],
        });
      else
        setHistory({
          ...next,
          items: [...(history?.items ?? []), ...(next.items as DomainEvent[])],
        });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить.');
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
          {comments === null && <output>Загружаем комментарии…</output>}
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
            maxLength={4000}
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
          {history === null && <output>Загружаем историю…</output>}
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
