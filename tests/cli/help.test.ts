import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { renderHelp } from '../../src/cli/help.js';
import {
  GLOBAL_FLAGS,
  PAGE_FLAGS,
  READS,
  SERVICE,
  WRITES,
  WRITE_FLAGS,
  autofilled,
  payloadFlags,
  type FlagSpec,
} from '../../src/cli/spec.js';
import { commandPayloadSchemas, z } from '../../src/shared/schemas.js';
import { fixture } from '../api/helpers.js';

const kebab = (key: string) =>
  key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const actor = {
  id: 'agent:test',
  agentId: 'test',
  label: 'Тест',
  kind: 'agent',
  scope: 'write',
};

async function cli(
  argv: string[],
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'taskindex-help-'));
  const output: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const urls: string[] = [];
  const code = await runCli(argv, {
    env: {
      TASKINDEX_URL: 'https://taskindex.example',
      TASKINDEX_TOKEN: 'secret',
      XDG_STATE_HOME: directory,
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      urls.push(`${url.pathname}${url.search}`);
      // The first /api/me of a fresh state directory is the identity lookup.
      if (url.pathname === '/api/me') return json(actor);
      return handler(url, init);
    }) as typeof fetch,
    stdout: (line) => output.push(JSON.parse(line) as Record<string, unknown>),
    stderr: (line) => errors.push(line),
    sleep: async () => undefined,
  });
  return { code, output, errors, urls, last: output.at(-1) };
}

type Rendered = {
  command?: string;
  usage?: string;
  flags?: { flag: string; type: string; required?: boolean }[];
  globalFlags?: { flag: string }[];
  example?: string;
  exitCodes?: Record<string, number>;
  errorCodes?: string[];
  reads?: { command: string; usage: string }[];
  writes?: { command: string; usage: string }[];
  service?: { command: string; usage: string }[];
};

describe('help is generated from one specification', () => {
  it('lists every command payload schema as a write command with all its fields', () => {
    const names = Object.keys(commandPayloadSchemas);
    for (const name of names) {
      const spec = WRITES.find((write) => write.command === name);
      expect(spec, `WRITES lacks ${name}`).toBeDefined();
      const help = renderHelp(spec!.group, spec!.action) as Rendered;
      const schema = z.toJSONSchema(
        commandPayloadSchemas[name as keyof typeof commandPayloadSchemas],
        { io: 'input', unrepresentable: 'any' },
      ) as {
        properties?: Record<string, unknown>;
        anyOf?: { properties?: Record<string, unknown> }[];
        required?: string[];
      };
      const properties = (schema.anyOf ?? [schema]).flatMap((variant) =>
        Object.keys(variant.properties ?? {}),
      );
      expect(properties.length).toBeGreaterThan(0);
      const rendered = JSON.stringify(help);
      for (const property of properties) {
        const flag = payloadFlags(
          name as keyof typeof commandPayloadSchemas,
        ).find((candidate) => candidate.key === property)!;
        expect(flag, `${name}: ${property} has no flag`).toBeDefined();
        expect(rendered, `${name}: --${flag.name}`).toContain(`--${flag.name}`);
      }
      for (const property of schema.required ?? []) {
        const rendered_flag = help.flags!.find(
          (flag) => flag.flag === `--${kebab(property)}`,
        );
        // A field the CLI reads for itself (appearance set takes the current
        // revision from GET /api/appearance) is offered, never demanded.
        if (
          autofilled(name as keyof typeof commandPayloadSchemas).includes(
            property,
          )
        ) {
          expect(
            rendered_flag?.required,
            `${name}: ${property} must be optional`,
          ).toBeUndefined();
          continue;
        }
        expect(
          rendered_flag?.required,
          `${name}: ${property} must be required`,
        ).toBe(true);
      }
      expect(help.example).toContain(`taskindex ${spec!.group}`);
      expect(help.usage).toContain('--payload JSON');
      expect(help.exitCodes).toMatchObject({ success: 0, arguments: 2 });
      expect(help.errorCodes).toContain('invalid_arguments');
      expect(help.errorCodes).toContain('generation_changed');
    }
  });

  it('covers every query parameter of every GET route in the OpenAPI document', async () => {
    const api = fixture();
    try {
      const response = await api.app.request('/api/openapi.json');
      expect(response.status).toBe(200);
      const document = (await response.json()) as {
        paths: Record<
          string,
          { get?: { parameters?: { in: string; name: string }[] } }
        >;
      };
      const routes = Object.entries(document.paths).filter(
        ([, item]) => item.get,
      );
      expect(routes.length).toBeGreaterThan(10);
      for (const [path, item] of routes) {
        if (path === '/api/events/stream' || path === '/health') continue;
        const read = READS.find((spec) => spec.route === path);
        expect(read, `READS lacks ${path}`).toBeDefined();
        const flags: FlagSpec[] = [
          ...read!.query,
          ...(read!.pageable ? PAGE_FLAGS : []),
        ];
        for (const parameter of item.get!.parameters ?? []) {
          if (parameter.in !== 'query') continue;
          const flag = flags.find(
            (candidate) =>
              (candidate.key ?? camel(candidate.name)) === parameter.name,
          );
          expect(flag, `${path}: ${parameter.name}`).toBeDefined();
          const help = renderHelp(read!.group, read!.action) as Rendered;
          expect(JSON.stringify(help)).toContain(`--${flag!.name}`);
        }
      }
    } finally {
      api.close();
    }
  });

  it('documents --today and --has-follow-up for tasks and me/openapi as reads', () => {
    const tasks = renderHelp('tasks') as Rendered;
    expect(tasks.command).toBe('tasks');
    const flags = tasks.flags!.map((flag) => flag.flag);
    expect(flags).toContain('--today');
    expect(flags).toContain('--has-follow-up');
    expect(flags).toContain('--all');
    expect(tasks.usage).toContain('--has-follow-up true|false');
    expect(READS.some((read) => read.group === 'me')).toBe(true);
    expect(READS.some((read) => read.group === 'openapi')).toBe(true);
    expect(
      SERVICE.some(
        (entry) => entry.group === 'operation' && entry.action === 'resume',
      ),
    ).toBe(true);
  });

  it('renders the overview, a group and a command; --help on a command is the same page', async () => {
    const overview = renderHelp() as Rendered;
    expect(overview.reads!.map((read) => read.command)).toContain('task get');
    expect(overview.writes!.map((write) => write.command)).toContain(
      'task create',
    );
    expect(overview.service!.map((entry) => entry.command)).toContain(
      'operation resume',
    );
    expect(JSON.stringify(overview)).not.toContain('--json');
    const group = renderHelp('task') as {
      group: string;
      actions: { command: string }[];
    };
    expect(group.group).toBe('task');
    expect(group.actions.map((action) => action.command)).toEqual(
      expect.arrayContaining(['task get', 'task create', 'task move']),
    );
    const command = renderHelp('task', 'move') as Rendered;
    expect(command.usage).toMatch(
      /^taskindex task move ID --base-revision N --status todo\|doing\|waiting\|done/,
    );
    expect(
      command.flags!.find((flag) => flag.flag === '--base-revision'),
    ).toMatchObject({
      type: 'integer',
      required: true,
    });
    expect(command.globalFlags!.map((flag) => flag.flag)).toEqual(
      expect.arrayContaining([
        '--dry-run',
        '--operation-id',
        '--generation',
        '--payload',
        '--file',
      ]),
    );
    const viaFlag = await cli(['task', 'move', '--help'], () => json({}));
    expect(viaFlag.code).toBe(0);
    expect(viaFlag.last).toEqual(JSON.parse(JSON.stringify(command)));
    expect(viaFlag.urls).toEqual([]);
    const viaHelp = await cli(['help', 'task', 'move'], () => json({}));
    expect(viaHelp.last).toEqual(viaFlag.last);
    expect(GLOBAL_FLAGS.map((flag) => flag.name)).toContain('help');
    expect(WRITE_FLAGS.map((flag) => flag.name)).not.toContain('json');
  });

  it('a group without an action or with an unknown action lists the actions of the group', async () => {
    const bare = await cli(['task'], () => json({}));
    expect(bare.code).toBe(2);
    expect(bare.last).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
      message:
        'task: ожидается get|history|find-origin|create|sync|update|save|move|archive|restore',
      hint: 'taskindex help task',
    });
    const unknownAction = await cli(['task', 'frobnicate'], () => json({}));
    expect(unknownAction.code).toBe(2);
    expect(unknownAction.last).toMatchObject({
      code: 'invalid_arguments',
      hint: 'taskindex help task',
    });
    expect(String(unknownAction.last!.message)).toContain('frobnicate');
    const unknownGroup = await cli(['foo'], () => json({}));
    expect(unknownGroup.code).toBe(2);
    expect(unknownGroup.last).toMatchObject({
      code: 'invalid_arguments',
      message: 'Неизвестная команда: foo',
      hint: 'taskindex help',
    });
    const unknownFlag = await cli(['tasks', '--colour', 'red'], () => json({}));
    expect(unknownFlag.code).toBe(2);
    expect(unknownFlag.last).toMatchObject({
      code: 'invalid_arguments',
      hint: 'taskindex help tasks',
    });
    expect(String(unknownFlag.last!.message)).toContain('--colour');
    expect(bare.urls).toEqual([]);
  });

  it('me prints the actor and tasks passes today/has-follow-up to the API', async () => {
    // The first /api/me is the identity lookup of a fresh state directory.
    const me = await cli(['me'], () => json({}));
    expect(me.code).toBe(0);
    expect(me.urls).toEqual(['/api/me', '/api/me']);
    expect(me.last).toEqual(actor);
    const page = {
      generation: 'g1',
      seq: 0,
      items: [],
      more: false,
      nextCursor: null,
    };
    const today = await cli(['tasks', '--today', 'true'], () => json(page));
    expect(today.code).toBe(0);
    expect(today.urls).toEqual(['/api/me', '/api/tasks?today=true']);
    const followUp = await cli(['tasks', '--has-follow-up', 'false'], () =>
      json(page),
    );
    expect(followUp.urls).toEqual(['/api/me', '/api/tasks?hasFollowUp=false']);
    const openapi = await cli(['openapi'], () => json({ openapi: '3.1.0' }));
    expect(openapi.urls).toEqual(['/api/me', '/api/openapi.json']);
    expect(openapi.last).toEqual({ openapi: '3.1.0' });
  });

  it('TI-044: tasks --today and --has-follow-up select the same ids as the HTTP API', async () => {
    const api = fixture();
    try {
      const create = (id: string, extra: Record<string, unknown>) =>
        api.post({
          command: 'task.create',
          payload: { id, area: 'agency', title: id, ...extra },
        });
      expect((await create('due-today', { due: '2026-09-08' })).status).toBe(
        200,
      );
      expect((await create('due-later', { due: '2026-09-20' })).status).toBe(
        200,
      );
      expect(
        (
          await create('waiting-back', {
            status: 'waiting',
            followUp: '2026-09-01',
          })
        ).status,
      ).toBe(200);
      expect((await create('plain', {})).status).toBe(200);
      const direct = async (query: string) => {
        const response = await api.app.request(`/api/tasks?${query}`);
        const body = (await response.json()) as { items: { id: string }[] };
        return body.items.map((task) => task.id).sort();
      };
      const viaCli = async (argv: string[]) => {
        const result = await cli(argv, (url, init) =>
          api.app.request(url.toString(), init),
        );
        expect(result.code).toBe(0);
        return (result.last!.items as { id: string }[])
          .map((task) => task.id)
          .sort();
      };
      expect(await viaCli(['tasks', '--today', 'true'])).toEqual(
        await direct('today=true'),
      );
      expect(await viaCli(['tasks', '--today', 'true'])).toEqual([
        'due-today',
        'waiting-back',
      ]);
      expect(await viaCli(['tasks', '--has-follow-up', 'true'])).toEqual(
        await direct('hasFollowUp=true'),
      );
      expect(await viaCli(['tasks', '--has-follow-up', 'false'])).toEqual(
        await direct('hasFollowUp=false'),
      );
      expect(await viaCli(['tasks', '--has-follow-up', 'true'])).toEqual([
        'waiting-back',
      ]);
    } finally {
      api.close();
    }
  });
});

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}
