import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compileFunction } from 'node:vm';
import ts from 'typescript';

// Exercise the actual route and SQL against isolated SQLite, never the owner's DB.
function isolatedRoute() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(
    'CREATE TABLE workspace_records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL)',
  );
  const db = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let args = [];
      return {
        bind(...values) {
          args = values;
          return this;
        },
        async run() {
          return { meta: { changes: Number(statement.run(...args).changes) } };
        },
        async first() {
          return statement.get(...args) ?? null;
        },
        async all() {
          return { results: statement.all(...args) };
        },
      };
    },
  };
  const cache = new Map();
  function load(path) {
    if (cache.has(path)) return cache.get(path);
    const compiledModule = { exports: {} };
    const js = ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const require = (name) =>
      name === '@/db'
        ? { getDatabase: () => db }
        : load(
            resolve(
              name.startsWith('@/') ? root : dirname(path),
              name.replace(/^@\//, '') + '.ts',
            ),
          );
    compileFunction(js, ['require', 'module', 'exports'])(
      require,
      compiledModule,
      compiledModule.exports,
    );
    cache.set(path, compiledModule.exports);
    return compiledModule.exports;
  }
  return {
    ...load(resolve(root, 'app/api/workspace/route.ts')),
    close: () => sqlite.close(),
  };
}

test('Focus survives the API, retries, conflict handling, archive and legacy records', async (t) => {
  const route = isolatedRoute();
  t.after(route.close);
  const post = async (value) => {
    const response = await route.POST(
      new Request('http://localhost:3000/api/workspace', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:3000',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'task', value }),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  const legacy = {
    id: 'legacy-task',
    area: 'agency',
    projectId: '',
    title: 'Legacy task',
    status: 'todo',
    note: '',
    due: '',
    waitingFor: '',
    followUp: '',
    checklist: [],
    rank: 1024,
    demo: false,
    archived: false,
    revision: 0,
  };
  const created = await post(legacy);
  assert.equal(created.status, 200);
  assert.equal(created.body.value.focus, undefined);
  assert.equal(
    (await post(legacy)).status,
    200,
    'Legacy create retries remain idempotent',
  );
  const draft = { ...created.body.value, focus: true };
  const focused = await post(draft);
  assert.equal(focused.status, 200);
  assert.equal(focused.body.value.focus, true);
  assert.equal(
    (await post(draft)).status,
    200,
    'Focus update retries remain idempotent',
  );
  const stale = await post({ ...draft, focus: false });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.focus, true);
  assert.equal(
    (await post({ ...focused.body.value, focus: 'yes' })).status,
    400,
  );
  const read = await (await route.GET()).json();
  assert.equal(
    read.tasks[0].focus,
    true,
    'GET returns the persisted selection',
  );
  const archived = await post({ ...focused.body.value, archived: true });
  assert.equal(
    archived.body.value.focus,
    true,
    'Archiving preserves selection for restoration',
  );
  const unselected = await post({
    ...archived.body.value,
    archived: false,
    focus: false,
  });
  assert.equal(unselected.body.value.focus, false);
});
