// I/O of the night shift: the `taskindex` CLI as a child process and the
// state directory. Kept thin; the decisions live in audit.mts and morning.mts.
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RunReport } from './report.mts';

// The key of the night shift, set explicitly: without it the wrapper picks
// the key by the environment and under the OpenClaw gateway that is Bobr's.
export const AGENT = 'night-shift';
const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 256 * 1024 * 1024;

export class CliError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

type Json = Record<string, unknown>;

function parseLines(stdout: string): Json[] {
  const lines: Json[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as Json);
    } catch {
      throw new CliError(
        `taskindex напечатал не JSON: ${line.slice(0, 200)}`,
        'invalid_output',
      );
    }
  }
  return lines;
}

// `TASKINDEX_BIN` points at another CLI build (a sandbox check runs
// `dist/cli/index.js`); a `.js` file is started with this Node.
function command(args: string[]): [string, string[]] {
  const bin = process.env.TASKINDEX_BIN ?? 'taskindex';
  return /\.(c|m)?js$/.test(bin)
    ? [process.execPath, [bin, ...args]]
    : [bin, args];
}

// One CLI call: argv without a shell, JSON lines back. A failed call throws
// with the CLI's own code and Russian message.
export function taskindex(args: string[]): Promise<Json[]> {
  const [file, argv] = command(args);
  return new Promise((resolve, reject) => {
    execFile(
      file,
      argv,
      {
        env: { ...process.env, TASKINDEX_AGENT: AGENT },
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
      },
      (error, stdout) => {
        let lines: Json[];
        try {
          lines = parseLines(stdout);
        } catch (parseError) {
          reject(error ? new CliError(error.message, 'spawn') : parseError);
          return;
        }
        if (!error && !lines.some((line) => line.ok === false)) {
          resolve(lines);
          return;
        }
        const failure = lines.find((line) => line.ok === false);
        const code =
          typeof failure?.code === 'string' ? failure.code : 'client_error';
        const message =
          typeof failure?.message === 'string'
            ? failure.message
            : (error?.message ?? 'taskindex завершился с ошибкой');
        reject(
          new CliError(`taskindex ${args[0] ?? ''}: ${message}`.trim(), code),
        );
      },
    );
  });
}

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  // An empty value falls back like `${XDG_STATE_HOME:-…}` in run.sh.
  const configured = env.XDG_STATE_HOME ?? '';
  const base =
    configured === '' ? join(homedir(), '.local', 'state') : configured;
  return join(base, 'taskindex', 'night-shift');
}

export const reportPath = (dir = stateDir()) => join(dir, 'last-run.json');

export async function ensureStateDir(dir = stateDir()): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

// null when there is no report yet; a report that does not parse is a
// failed run for the reader, not a crash.
export async function readReport(
  path = reportPath(),
): Promise<RunReport | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(text) as RunReport;
  } catch {
    return {
      startedAt: '',
      finishedAt: '',
      ok: false,
      window: null,
      stages: {},
      errors: [{ stage: 'report', message: 'отчёт прогона не читается' }],
    };
  }
}

// Temp file and rename in the same directory: a reader sees the old report
// or the new one, never half of it.
export async function writeReport(
  report: RunReport,
  path = reportPath(),
): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}
