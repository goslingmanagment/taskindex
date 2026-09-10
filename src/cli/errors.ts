import { errorCodeSchema } from '../shared/domain-schemas.js';
import { z } from '../shared/schemas.js';

// Codes the CLI adds to the server's: they never come from the API and never
// settle an envelope on their own.
const CLI_ONLY_CODES = [
  'invalid_arguments',
  'client_error',
  'network_error',
  'invalid_response',
  'admin_error',
] as const;

export const CLI_ERROR_CODES = [
  ...errorCodeSchema.options,
  ...CLI_ONLY_CODES,
] as const;

// Zod speaks Russian in the CLI process, like the server's own messages;
// idempotent, so tests that import the CLI may call it any number of times.
let localized = false;
export function configureLocale(): void {
  if (localized) return;
  z.config(z.locales.ru());
  localized = true;
}

interface Issue {
  path: string;
  message: string;
  hint?: string;
}

// What to do about a field, by its last path segment or the full path.
const HINTS: Record<string, string> = {
  baseRevision:
    'Возьмите revision из `taskindex task get ID` и передайте `--base-revision N`',
  area: 'Допустимо: agency, development, personal',
  status: 'Допустимо: todo, doing, waiting, done',
  'origin.version':
    'Упорядоченная версия самого источника, не время наблюдения',
  'origin.system': 'Слаг источника: строчные латинские буквы, цифры, `_`, `-`',
  generation:
    'Возьмите generation из `taskindex me` или используйте `--since last`',
  id: 'Идентификатор: латиница, цифры, `_`, `-`, до 80 символов',
  taskId: 'Идентификатор: латиница, цифры, `_`, `-`, до 80 символов',
  itemId: 'Идентификатор: латиница, цифры, `_`, `-`, до 80 символов',
  commentId: 'Идентификатор: латиница, цифры, `_`, `-`, до 80 символов',
  projectId: 'Идентификатор проекта или null (без проекта)',
  due: 'Календарная дата YYYY-MM-DD или null',
  followUp: 'Календарная дата YYYY-MM-DD или null',
  color: 'Цвет в форме #rrggbb',
  focus: 'focus ставит только владелец; агент это поле не передаёт',
};

// `a.b[0].c` from a Zod path; a server issue already carries a string.
function formatPath(path: (string | number | symbol)[] | string): string {
  if (typeof path === 'string') return path;
  return path.reduce<string>(
    (text, segment) =>
      typeof segment === 'number'
        ? `${text}[${segment}]`
        : text
          ? `${text}.${String(segment)}`
          : String(segment),
    '',
  );
}

function hintFor(path: string): string | undefined {
  const bare = path.replace(/^(payload|commands\[\d+\]\.payload|fields)\./, '');
  const segments = bare.replace(/\[\d+\]/g, '').split('.');
  return (
    HINTS[bare] ??
    HINTS[segments.slice(-2).join('.')] ??
    HINTS[segments.at(-1) ?? '']
  );
}

interface RawIssue {
  path?: (string | number | symbol)[] | string;
  message?: string;
  hint?: string;
}

// Local Zod issues and server `issues` alike become {path, message, hint}.
export function formatIssues(issues: readonly RawIssue[]): Issue[] {
  return issues.map((issue) => {
    const path = formatPath(issue.path ?? []);
    const hint = issue.hint ?? hintFor(path);
    return {
      path,
      message: issue.message ?? 'Неверное значение',
      ...(hint ? { hint } : {}),
    };
  });
}

// A server reply is printed as it is; only a hint is added where the CLI
// knows what to do next (validation issues by field, a changed generation).
export function withHints(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (body.ok !== false) return body;
  const result = { ...body };
  if (Array.isArray(body.issues))
    result.issues = formatIssues(body.issues as RawIssue[]);
  if (body.code === 'generation_changed' && result.hint === undefined)
    result.hint =
      'Поколение базы сменилось: taskindex cursor reset, затем taskindex digest и новая оценка действия';
  const message = typeof body.message === 'string' ? body.message : '';
  if (body.code === 'forbidden' && result.hint === undefined) {
    if (message.includes('confirmOwnerFields'))
      result.hint =
        'Поле защищено ручной правкой владельца (см. conflicts[].fields): если есть поручение владельца, повторите команду с --confirm-owner-fields; иначе сообщите комментарием';
    else if (message.includes('focus'))
      result.hint =
        'focus ставит и снимает только владелец: уберите --focus; в task sync поле пропускается (skipped: owner)';
  }
  return result;
}
