import { getDatabase } from '@/db';
import { makeSeed, localDate, type Project, type Task } from '@/lib/workspace';
import {
  InputError,
  object,
  validateTask,
  validateProject,
} from '@/lib/validation';
export const dynamic = 'force-dynamic';
const response = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
async function readAll() {
  const db = getDatabase();
  const result = await db
    .prepare('SELECT kind, data, revision FROM workspace_records')
    .all<{ kind: string; data: string; revision: number }>();
  const unpack = (kind: string) =>
    result.results
      .filter((r) => r.kind === kind)
      .map((r) => ({ ...JSON.parse(r.data), revision: r.revision }));
  return {
    projects: unpack('project') as Project[],
    tasks: unpack('task') as Task[],
    initialized: result.results.some((r) => r.kind === 'meta'),
  };
}
export async function GET() {
  try {
    return response(await readAll());
  } catch {
    return response(
      { error: 'Не удалось загрузить задачи. Попробуйте ещё раз.' },
      503,
    );
  }
}
export async function POST(request: Request) {
  try {
    const origin = request.headers.get('origin');
    if (origin && new URL(origin).origin !== new URL(request.url).origin)
      return response({ error: 'Запрос с другого сайта отклонён.' }, 403);
    if (!request.headers.get('content-type')?.includes('application/json'))
      return response({ error: 'Ожидается JSON.' }, 415);
    const raw = await request.text();
    if (raw.length > 100000)
      return response({ error: 'Слишком много данных.' }, 413);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new InputError('Некорректный JSON.');
    }
    const body = object(parsed),
      db = getDatabase();
    if (body.action === 'initialize') {
      const current = await readAll();
      if (current.initialized) return response(current);
      const seed = makeSeed(localDate());
      const now = new Date().toISOString();
      const rows = [
        ...seed.projects.map((p) => ({ kind: 'project', value: p })),
        ...seed.tasks.map((t) => ({ kind: 'task', value: t })),
      ];
      await db.batch([
        ...rows.map((r) =>
          db
            .prepare(
              "INSERT OR IGNORE INTO workspace_records (id,kind,data,revision,updated_at) SELECT ?,?,?,1,? WHERE NOT EXISTS (SELECT 1 FROM workspace_records WHERE id='workspace-initialized')",
            )
            .bind(
              r.kind + '/' + r.value.id,
              r.kind,
              JSON.stringify(r.value),
              now,
            ),
        ),
        db
          .prepare(
            "INSERT OR IGNORE INTO workspace_records (id,kind,data,revision,updated_at) VALUES ('workspace-initialized','meta','{}',1,?)",
          )
          .bind(now),
      ]);
      return response(await readAll());
    }
    if (body.action !== 'task' && body.action !== 'project')
      throw new InputError('Неизвестное действие.');
    const kind = body.action;
    const value =
      kind === 'task' ? validateTask(body.value) : validateProject(body.value);
    if (kind === 'task') {
      const task = value as Task;
      if (task.projectId) {
        const project = await db
          .prepare(
            "SELECT data FROM workspace_records WHERE id=? AND kind='project'",
          )
          .bind('project/' + task.projectId)
          .first<{ data: string }>();
        if (!project || JSON.parse(project.data).area !== task.area)
          throw new InputError('Проект должен принадлежать выбранной области.');
      }
    } else {
      const project = value as Project;
      const allProjects = await db
        .prepare("SELECT id,data FROM workspace_records WHERE kind='project'")
        .all<{ id: string; data: string }>();
      const collision = allProjects.results.some((row) => {
        const p = JSON.parse(row.data) as Project;
        return (
          row.id !== 'project/' + project.id &&
          p.area === project.area &&
          p.name.toLocaleLowerCase('ru') ===
            project.name.toLocaleLowerCase('ru')
        );
      });
      if (collision) throw new InputError('Такое направление уже есть.');
    }
    const id = kind + '/' + value.id;
    const next = { ...value, revision: value.revision + 1 };
    const now = new Date().toISOString();
    if (value.revision === 0) {
      const result = await db
        .prepare(
          'INSERT OR IGNORE INTO workspace_records (id,kind,data,revision,updated_at) VALUES (?,?,?,?,?)',
        )
        .bind(id, kind, JSON.stringify(next), 1, now)
        .run();
      if (!result.meta.changes) {
        const existing = await db
          .prepare('SELECT data,revision FROM workspace_records WHERE id=?')
          .bind(id)
          .first<{ data: string; revision: number }>();
        if (existing?.revision === 1 && existing.data === JSON.stringify(next))
          return response({ value: next });
        return response(
          { error: 'Запись уже существует. Обновите доску.' },
          409,
        );
      }
    } else {
      const result = await db
        .prepare(
          'UPDATE workspace_records SET data=?,revision=?,updated_at=? WHERE id=? AND kind=? AND revision=?',
        )
        .bind(
          JSON.stringify(next),
          next.revision,
          now,
          id,
          kind,
          value.revision,
        )
        .run();
      if (!result.meta.changes) {
        const existing = await db
          .prepare('SELECT data,revision FROM workspace_records WHERE id=?')
          .bind(id)
          .first<{ data: string; revision: number }>();
        if (
          existing?.revision === next.revision &&
          existing.data === JSON.stringify(next)
        )
          return response({ value: next });
        return response(
          {
            error:
              'Задача изменилась в другой вкладке. Ваш текст остался в форме.',
            current: existing
              ? { ...JSON.parse(existing.data), revision: existing.revision }
              : null,
          },
          409,
        );
      }
    }
    return response({ value: next });
  } catch (error) {
    if (error instanceof InputError)
      return response({ error: error.message }, 400);
    return response(
      { error: 'Изменение не сохранилось. Проверьте соединение и повторите.' },
      503,
    );
  }
}
