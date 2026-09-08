'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type WorkspaceData, type Task, type Project } from './workspace';
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public current?: unknown,
  ) {
    super(message);
  }
}
export async function api<T>(action?: string, value?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/workspace', {
      method: action ? 'POST' : 'GET',
      headers: action ? { 'Content-Type': 'application/json' } : undefined,
      body: action ? JSON.stringify({ action, value }) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error(
      'Нет соединения. Изменение не подтверждено — попробуйте ещё раз.',
    );
  }
  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error('Не удалось прочитать ответ. Проверьте соединение.');
  }
  if (!response.ok)
    throw new ApiError(
      typeof data.error === 'string' ? data.error : 'Изменение не сохранилось.',
      response.status,
      data.current,
    );
  return data as T;
}
export function useWorkspace() {
  const [data, setData] = useState<WorkspaceData>({ projects: [], tasks: [] });
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [pending, setPending] = useState(0),
    [mutationError, setMutationError] = useState('');
  const locked = useRef(new Set<string>());
  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      let d = await api<WorkspaceData & { initialized: boolean }>();
      if (!d.initialized) d = await api('initialize');
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить задачи.');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => {
      if (mounted) void refresh();
    });
    return () => {
      mounted = false;
    };
  }, [refresh]);
  const saveTask = useCallback(async (task: Task) => {
    if (locked.current.has(task.id))
      throw new Error('Подождите, задача сохраняется.');
    locked.current.add(task.id);
    setPending((n) => n + 1);
    try {
      const { value } = await api<{ value: Task }>('task', task);
      setData((d) => ({
        ...d,
        tasks: d.tasks.some((t) => t.id === value.id)
          ? d.tasks.map((t) => (t.id === value.id ? value : t))
          : [...d.tasks, value],
      }));
      setMutationError('');
      return value;
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : 'Не сохранилось.');
      throw e;
    } finally {
      locked.current.delete(task.id);
      setPending((n) => n - 1);
    }
  }, []);
  const saveProject = useCallback(async (project: Project) => {
    const key = 'project/' + project.id;
    if (locked.current.has(key)) throw new Error('Направление сохраняется.');
    locked.current.add(key);
    setPending((n) => n + 1);
    try {
      const { value } = await api<{ value: Project }>('project', project);
      setData((d) => ({
        ...d,
        projects: d.projects.some((p) => p.id === value.id)
          ? d.projects.map((p) => (p.id === value.id ? value : p))
          : [...d.projects, value],
      }));
      setMutationError('');
      return value;
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : 'Не сохранилось.');
      throw e;
    } finally {
      locked.current.delete(key);
      setPending((n) => n - 1);
    }
  }, []);
  return {
    data,
    loading,
    error,
    pending,
    mutationError,
    refresh,
    saveTask,
    saveProject,
  };
}
