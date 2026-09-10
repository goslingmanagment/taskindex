import { execFile } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { assertSchema, openDatabase } from '../server/db.js';
import * as admin from '../server/admin.js';
import type { ExportData, Scope } from '../shared/model.js';
import {
  ArgumentError,
  flagBoolean,
  flagString,
  parseArguments,
  parseJson,
  required,
} from './arguments.js';
import { readInput } from './input.js';

export interface AdminOptions {
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  readInput?: (path: string) => Promise<string>;
}

export async function runAdmin(
  argv: string[],
  options: AdminOptions = {},
): Promise<number> {
  const emit = (value: unknown) =>
    (options.stdout ?? ((line) => process.stdout.write(`${line}\n`)))(
      JSON.stringify(value),
    );
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const args = parseArguments(argv);
    const [command, action, id] = args.positional;
    if (!command || args.flags.help) {
      emit({
        usage: 'taskindex-admin <command>',
        commands: [
          'migrate',
          'create-owner --email ADDRESS [--name NAME] (password on stdin or --password-op op://...)',
          'reset-owner-password (password on stdin or --password-op op://...)',
          'agent create --id ID --label LABEL',
          'agent list',
          'agent disable ID',
          'agent-key create --agent ID --scope read|tasks|write --out /protected/key.json',
          'agent-key list [--agent ID]',
          'agent-key revoke ID',
          'import FILE [--replace]',
          'export [--out FILE]',
          'mark-restored',
          'open-writes',
        ],
        configuration: [
          'DATABASE_PATH',
          'BASE_URL',
          'BETTER_AUTH_SECRET',
          'TIMEZONE',
          'TASKINDEX_DEPLOYMENT',
        ],
      });
      return 0;
    }
    const env = options.env ?? process.env;
    const input = options.readInput ?? readInput;
    const password = async () => {
      const reference = flagString(args.flags, 'password-op');
      let value: string;
      if (reference) {
        if (!reference.startsWith('op://'))
          throw new ArgumentError('--password-op требует ссылку op://');
        try {
          value = (
            await promisify(execFile)('op', ['read', reference], {
              maxBuffer: 16_384,
            })
          ).stdout;
        } catch {
          throw new Error('Не удалось прочитать пароль через op');
        }
      } else value = await input('-');
      return value.replace(/\r?\n$/, '');
    };
    // Do not silently create a database in an arbitrary working directory.
    const databasePath = required(env.DATABASE_PATH, 'DATABASE_PATH');
    if (command !== 'migrate' && databasePath !== ':memory:')
      await access(databasePath);
    db = openDatabase(databasePath);
    if (command !== 'migrate') assertSchema(db);
    let result: unknown;
    switch (command) {
      case 'migrate':
        result = admin.initialize(db, {
          ...(env.TIMEZONE ? { timezone: env.TIMEZONE } : {}),
          ...(env.TASKINDEX_MIGRATIONS_DIR
            ? { migrationsDir: env.TASKINDEX_MIGRATIONS_DIR }
            : {}),
        });
        break;
      case 'create-owner':
        result = await admin.createOwner(db, {
          email: required(flagString(args.flags, 'email'), '--email'),
          password: await password(),
          ...(flagString(args.flags, 'name')
            ? { name: flagString(args.flags, 'name') }
            : {}),
        });
        break;
      case 'reset-owner-password':
        result = await admin.resetOwnerPassword(db, {
          password: await password(),
        });
        break;
      case 'agent':
        if (action === 'create')
          result = admin.createAgent(db, {
            id: required(flagString(args.flags, 'id'), '--id'),
            label: required(flagString(args.flags, 'label'), '--label'),
          });
        else if (action === 'list') result = admin.listAgents(db);
        else if (action === 'disable')
          result = admin.disableAgent(db, required(id, 'agent id'));
        else
          throw new ArgumentError('agent: ожидается create, list или disable');
        break;
      case 'agent-key':
        if (action === 'create') {
          const destination = required(
            flagString(args.flags, 'out'),
            '--out (защищённый файл для нового ключа)',
          );
          const scope = required(flagString(args.flags, 'scope'), '--scope');
          if (!['read', 'tasks', 'write'].includes(scope))
            throw new ArgumentError('--scope: read, tasks или write');
          const auth = admin.createAuth(db, {
            baseURL: required(env.BASE_URL, 'BASE_URL'),
            secret: required(env.BETTER_AUTH_SECRET, 'BETTER_AUTH_SECRET'),
          });
          const key = await admin.createAgentKey(db, auth, {
            agentId: required(flagString(args.flags, 'agent'), '--agent'),
            scope: scope as Scope,
            ...(flagString(args.flags, 'name')
              ? { name: flagString(args.flags, 'name') }
              : {}),
          });
          try {
            await writeFile(destination, `${JSON.stringify(key)}\n`, {
              mode: 0o600,
              flag: 'wx',
            });
          } catch {
            admin.revokeAgentKey(db, key.id);
            throw new Error(
              'Не удалось безопасно сохранить ключ; созданный ключ отозван',
            );
          }
          result = {
            id: key.id,
            agentId: key.agentId,
            scope: key.scope,
            path: destination,
          };
        } else if (action === 'list')
          result = admin.listAgentKeys(db, flagString(args.flags, 'agent'));
        else if (action === 'revoke')
          result = admin.revokeAgentKey(db, required(id, 'key id'));
        else
          throw new ArgumentError(
            'agent-key: ожидается create, list или revoke',
          );
        break;
      case 'import':
        result = admin.importWorkspace(
          db,
          parseJson(
            await input(required(action, 'файл импорта')),
            'export',
          ) as ExportData,
          { replace: flagBoolean(args.flags, 'replace') },
        );
        break;
      case 'export': {
        const data = admin.exportWorkspace(db);
        const destination = flagString(args.flags, 'out');
        if (destination) {
          await writeFile(destination, `${JSON.stringify(data)}\n`, {
            mode: 0o600,
            flag: 'wx',
          });
          result = {
            path: destination,
            generation: data.generation,
            seq: data.seq,
          };
        } else result = data;
        break;
      }
      case 'mark-restored':
        result = admin.markRestored(db);
        break;
      case 'open-writes':
        result = admin.openWrites(
          db,
          required(env.TASKINDEX_DEPLOYMENT, 'TASKINDEX_DEPLOYMENT'),
        );
        break;
      default:
        throw new ArgumentError(`Неизвестная admin-команда: ${command}`);
    }
    emit(result);
    return 0;
  } catch (error) {
    const candidate = error as {
      code?: string;
      status?: number;
      message?: string;
      issues?: unknown[];
    };
    const code = candidate.code;
    // Never print stdin, auth objects, keys or library error payloads.
    emit({
      ok: false,
      code:
        code ??
        (error instanceof ArgumentError || candidate.issues
          ? 'invalid_arguments'
          : 'admin_error'),
      message: candidate.issues
        ? 'Параметры не прошли проверку схемы'
        : (candidate.message ?? 'Ошибка служебной команды'),
    });
    if (error instanceof ArgumentError || candidate.issues) return 2;
    if (code === 'forbidden' || code === 'unauthorized') return 4;
    if (code === 'conflict' || code === 'generation_changed') return 3;
    return 1;
  } finally {
    db?.close();
  }
}
